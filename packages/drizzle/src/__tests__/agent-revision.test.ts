import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { DrizzleAgentStore } from "../stores/agent-store.js";
import { DrizzleTeamStore } from "../stores/team-store.js";
import { agentsSqlite, teamsSqlite } from "../schema/teams.js";
import { migrateSqliteSchema } from "../sqlite-migrator.js";

describe("versioned agent persistence", () => {
  let sqlite: InstanceType<typeof Database>;
  let first: DrizzleAgentStore;
  let second: DrizzleAgentStore;
  let teams: DrizzleTeamStore;
  beforeEach(async () => {
    sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    await migrateSqliteSchema(db);
    first = new DrizzleAgentStore(db, agentsSqlite, "sqlite");
    second = new DrizzleAgentStore(db, agentsSqlite, "sqlite");
    teams = new DrizzleTeamStore(db, teamsSqlite, agentsSqlite, "sqlite");
    await first.createAgent({ name: "assistant", role: "original", allowedTools: ["read"] }, "main");
  });
  afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

  it("preserves unrelated fields under simultaneous ordinary updates", async () => {
    await Promise.all([
      first.updateAgent("assistant", { role: "new role" }),
      second.updateAgent("assistant", { allowedTools: ["read", "gmail_read"] }),
    ]);
    expect(await first.getAgent("assistant")).toMatchObject({ role: "new role", allowedTools: ["read", "gmail_read"] });
  });

  it("elects one CAS winner and rejects a stale rollback", async () => {
    const initial = (await first.getAgentSnapshot("assistant"))!;
    const attempts = await Promise.allSettled([first, second].map((store, i) => store.compareAndSwapAgent("assistant", {
      expected: initial.revision, mutationId: `assignment-${i}`, patch: { set: { allowedTools: ["read", `tool-${i}`] } },
    })));
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "agent_revision_conflict" } });
    const committed = (await first.getAgentSnapshot("assistant"))!;
    await second.updateAgent("assistant", { skills: ["fresh"] });
    await expect(first.compareAndSwapAgent("assistant", { expected: committed.revision,
      mutationId: "rollback", patch: { set: { allowedTools: initial.agent.allowedTools } } })).rejects.toMatchObject({ code: "agent_revision_conflict" });
    expect((await first.getAgent("assistant"))?.skills).toEqual(["fresh"]);
  });

  it("fences even no-op writes and replays only the identical acknowledged generation", async () => {
    const initial = (await first.getAgentSnapshot("assistant"))!;
    const mutation = { expected: initial.revision, mutationId: "same-attempt", patch: {} };
    const receipt = await first.compareAndSwapAgent("assistant", mutation);
    expect(receipt.snapshot.revision.version).toBe(initial.revision.version + 1);
    expect(await second.compareAndSwapAgent("assistant", mutation)).toEqual(receipt);
    await expect(second.compareAndSwapAgent("assistant", { ...mutation, patch: { set: { role: "different intent" } } }))
      .rejects.toMatchObject({ code: "agent_revision_conflict" });
    await second.updateAgent("assistant", { role: "later" });
    await expect(first.compareAndSwapAgent("assistant", mutation)).rejects.toMatchObject({ code: "agent_revision_conflict" });
    expect((await first.getAgent("assistant"))?.role).toBe("later");
  });

  it("conditions deletion on both incarnation and configuration generation", async () => {
    const initial = (await first.getAgentSnapshot("assistant"))!;
    await second.updateAgent("assistant", { role: "new configuration" });
    await expect(first.deleteAgentIfRevision("assistant", initial.revision))
      .rejects.toMatchObject({ code: "agent_revision_conflict" });
    const current = (await first.getAgentSnapshot("assistant"))!;
    expect(await first.deleteAgentIfRevision("assistant", current.revision)).toBe(true);
    expect(await first.deleteAgentIfRevision("assistant", current.revision)).toBe(false);
    await second.createAgent(current.agent, "main");
    await expect(first.deleteAgentIfRevision("assistant", current.revision))
      .rejects.toMatchObject({ code: "agent_revision_conflict" });
    expect((await first.getAgent("assistant"))?.role).toBe("new configuration");
  });

  it("rejects malformed deletion preconditions without touching the agent", async () => {
    const initial = (await first.getAgentSnapshot("assistant"))!;
    for (const expected of [undefined, { incarnation: "", version: 0 }, { ...initial.revision, version: -1 }]) {
      await expect(first.deleteAgentIfRevision("assistant", expected as any))
        .rejects.toMatchObject({ code: "invalid_agent_mutation" });
    }
    expect(await first.getAgentSnapshot("assistant")).toEqual(initial);
  });

  it("changes incarnation on delete/recreate, including identical configurations", async () => {
    const initial = (await first.getAgentSnapshot("assistant"))!;
    await second.deleteAgent("assistant");
    await second.createAgent(initial.agent, "main");
    const recreated = (await first.getAgentSnapshot("assistant"))!;
    expect(recreated.revision.incarnation).not.toBe(initial.revision.incarnation);
    await expect(first.compareAndSwapAgent("assistant", { expected: initial.revision,
      mutationId: "old", patch: {} })).rejects.toMatchObject({ code: "agent_revision_conflict" });
  });

  it("treats team movement and team renames as agent mutations", async () => {
    await teams.createTeam({ name: "other", agents: [] });
    const initial = (await first.getAgentSnapshot("assistant"))!;
    await second.moveAgent("assistant", "other");
    const moved = (await first.getAgentSnapshot("assistant"))!;
    expect(moved.teamName).toBe("other");
    expect(moved.revision.version).toBe(initial.revision.version + 1);
    await teams.renameTeam("other", "renamed");
    const renamed = (await first.getAgentSnapshot("assistant"))!;
    expect(renamed.teamName).toBe("renamed");
    expect(renamed.revision.version).toBe(moved.revision.version + 1);
    await expect(first.compareAndSwapAgent("assistant", { expected: moved.revision,
      mutationId: "before-rename", patch: {} })).rejects.toMatchObject({ code: "agent_revision_conflict" });
  });

  it("distinguishes absent fields, explicit null and unset, without mutating caller data", async () => {
    const initial = (await first.getAgentSnapshot("assistant"))!;
    const patch = { set: { identity: { displayName: "Ada" }, model: null }, unset: ["role"] };
    const receipt = await first.compareAndSwapAgent("assistant", { expected: initial.revision,
      mutationId: "patch", patch: patch as any });
    patch.set.identity.displayName = "changed outside";
    expect(receipt.snapshot.agent).toMatchObject({ model: null, allowedTools: ["read"], identity: { displayName: "Ada" } });
    expect(receipt.snapshot.agent).not.toHaveProperty("role");
    expect(await first.getAgent("assistant")).toEqual(receipt.snapshot.agent);
  });

  it.each([
    { set: { name: "rename" } }, { set: { role: undefined } }, { set: { maxTurns: Number.NaN } },
    { set: { role: "a" }, unset: ["role"] }, { unset: ["name"] }, { teamName: "" },
    JSON.parse('{"set":{"__proto__":{"polluted":true}}}'),
  ])("rejects ambiguous or non-JSON mutation %j before writing", async patch => {
    const initial = (await first.getAgentSnapshot("assistant"))!;
    await expect(first.compareAndSwapAgent("assistant", { expected: initial.revision,
      mutationId: "bad", patch: patch as any })).rejects.toMatchObject({ code: "invalid_agent_mutation" });
    expect(await first.getAgentSnapshot("assistant")).toEqual(initial);
  });

  it("migrates legacy rows repeatedly without resetting their revision", async () => {
    sqlite.close();
    sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE agents (name TEXT PRIMARY KEY, team_name TEXT NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    sqlite.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?)").run("legacy", "main", '{"role":"old"}', "then", "then");
    const db = drizzle(sqlite);
    await migrateSqliteSchema(db);
    first = new DrizzleAgentStore(db, agentsSqlite, "sqlite");
    second = new DrizzleAgentStore(db, agentsSqlite, "sqlite");
    const [a, b] = await Promise.all([first.getAgentSnapshot("legacy"), second.getAgentSnapshot("legacy")]);
    expect(a?.revision.incarnation).toBeTruthy();
    expect(a).toEqual(b);
    await migrateSqliteSchema(db);
    expect(await first.getAgentSnapshot("legacy")).toEqual(a);
  });

  it("seeds concurrently without replacing an existing incarnation", async () => {
    await Promise.all([first, second].map(store => store.seed([{ name: "seeded", teamName: "main" }])));
    const seeded = await first.getAgentSnapshot("seeded");
    await second.seed([{ name: "seeded", teamName: "main", role: "replacement" }]);
    expect(await first.getAgentSnapshot("seeded")).toEqual(seeded);
  });

  it("recovers an actual committed write after its database acknowledgement is lost", async () => {
    const snapshot = (await first.getAgentSnapshot("assistant"))!;
    const mutation = { expected: snapshot.revision, mutationId: "lost-ack", patch: { set: { skills: ["google"] } } };
    const db = (first as any).db;
    const update = db.update.bind(db);
    vi.spyOn(db, "update").mockImplementationOnce((table: any) => {
      const builder = update(table);
      return { set: (values: any) => {
        const query = builder.set(values);
        return { where: (condition: any) => {
          const write = query.where(condition);
          return { returning: async () => { await write.returning(); throw new Error("acknowledgement lost"); } };
        } };
      } };
    });
    await expect(first.compareAndSwapAgent("assistant", mutation)).rejects.toThrow("acknowledgement lost");
    const receipt = await second.compareAndSwapAgent("assistant", mutation);
    expect(receipt.snapshot.revision.version).toBe(snapshot.revision.version + 1);
    expect(receipt.snapshot.agent.skills).toEqual(["google"]);
    expect(await first.getAgentSnapshot("assistant")).toEqual(receipt.snapshot);
  });

  it("does not retry an ordinary update onto a recreated agent", async () => {
    const original = first.compareAndSwapAgent.bind(first);
    vi.spyOn(first, "compareAndSwapAgent").mockImplementationOnce(async (name, mutation) => {
      await second.deleteAgent(name);
      await second.createAgent({ name, role: "new incarnation" }, "main");
      return original(name, mutation);
    });
    await expect(first.updateAgent("assistant", { skills: ["stale"] })).rejects.toMatchObject({ code: "agent_revision_conflict" });
    expect(await first.getAgent("assistant")).toMatchObject({ role: "new incarnation" });
    expect(await first.getAgent("assistant")).not.toHaveProperty("skills");
  });

  it("preserves legacy JSON removal semantics for nested undefined fields", async () => {
    await first.updateAgent("assistant", { identity: { displayName: "Support", avatar: "avatar.png" } });
    const current = (await first.getAgent("assistant"))!;
    await second.updateAgent("assistant", { identity: { ...current.identity, avatar: undefined } });
    expect((await first.getAgent("assistant"))?.identity).toEqual({ displayName: "Support" });
  });

  it("does not delete a volatile agent whose lifecycle changed during cleanup", async () => {
    await first.updateAgent("assistant", { volatile: true, missionGroup: "mission" });
    const db = (first as any).db;
    const remove = db.delete.bind(db);
    vi.spyOn(db, "delete").mockImplementationOnce((table: any) => {
      const builder = remove(table);
      return { where: (condition: any) => {
        const query = builder.where(condition);
        return { returning: async (selection: any) => {
          await second.updateAgent("assistant", { volatile: false });
          return query.returning(selection);
        } };
      } };
    });
    expect(await first.cleanupVolatileAgents("mission")).toBe(0);
    expect((await first.getAgent("assistant"))?.volatile).toBe(false);
  });
});
