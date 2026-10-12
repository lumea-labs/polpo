import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { DrizzleAgentStore } from "../stores/agent-store.js";
import { agentsPg } from "../schema/teams.js";
import { migratePgSchema } from "../migrator.js";

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("agent revisions across PostgreSQL connections", () => {
  const namespace = `agent_revision_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
  const clientA = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace }, onnotice: () => undefined });
  const clientB = postgres(databaseUrl!, { max: 1, connection: { search_path: namespace }, onnotice: () => undefined });
  const dbA = drizzle(clientA), dbB = drizzle(clientB);
  const first = new DrizzleAgentStore(dbA, agentsPg, "pg");
  const second = new DrizzleAgentStore(dbB, agentsPg, "pg");
  beforeAll(async () => {
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
    // Deliberately start with a pre-revision table and real data.
    await clientA`CREATE TABLE agents (name TEXT PRIMARY KEY, team_name TEXT NOT NULL, config JSONB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
    await clientA`INSERT INTO agents VALUES ('legacy', 'main', '{"role":"preserved"}'::jsonb, 'then', 'then')`;
    await migratePgSchema(dbA);
  }, 30_000);
  afterAll(async () => {
    await Promise.all([clientA.end(), clientB.end()]);
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.end();
  });

  it("adopts a legacy row once across independent adapters and preserves its generation on migration", async () => {
    const [a, b] = await Promise.all([first.getAgentSnapshot("legacy"), second.getAgentSnapshot("legacy")]);
    expect(a).toEqual(b);
    expect(a?.revision.incarnation).toBeTruthy();
    expect(a?.agent.role).toBe("preserved");
    await migratePgSchema(dbB);
    expect(await second.getAgentSnapshot("legacy")).toEqual(a);
  });

  it("serializes different-field updates and elects only one same-revision writer", async () => {
    await first.createAgent({ name: "parallel", allowedTools: ["read"] }, "main");
    await Promise.all([
      first.updateAgent("parallel", { role: "reader" }),
      second.updateAgent("parallel", { skills: ["google"] }),
    ]);
    const snapshot = (await first.getAgentSnapshot("parallel"))!;
    expect(snapshot.agent).toMatchObject({ role: "reader", skills: ["google"] });
    const results = await Promise.allSettled([first, second].map((store, i) => store.compareAndSwapAgent("parallel", {
      expected: snapshot.revision, mutationId: `request-${i}`, patch: { set: { allowedTools: [`action-${i}`] } },
    })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "agent_revision_conflict" } });
  });

  it("deduplicates concurrent retries and fences no-op policy changes", async () => {
    await first.createAgent({ name: "ack" }, "main");
    const snapshot = (await first.getAgentSnapshot("ack"))!;
    const mutation = { expected: snapshot.revision, mutationId: "same-request", patch: {} };
    const [a, b] = await Promise.all([first.compareAndSwapAgent("ack", mutation), second.compareAndSwapAgent("ack", mutation)]);
    expect(a).toEqual(b);
    expect(a.snapshot.revision.version).toBe(snapshot.revision.version + 1);
    await expect(first.compareAndSwapAgent("ack", { ...mutation, expected: a.snapshot.revision, patch: { set: { role: "changed intent" } } }))
      .rejects.toMatchObject({ code: "agent_revision_conflict" });
    await second.updateAgent("ack", { role: "later" });
    await expect(first.compareAndSwapAgent("ack", mutation)).rejects.toMatchObject({ code: "agent_revision_conflict" });
    expect(a.snapshot.agent).not.toHaveProperty("role");
  });

  it("cannot act on a deleted and recreated agent using its old identity", async () => {
    await first.createAgent({ name: "aba" }, "main");
    const snapshot = (await first.getAgentSnapshot("aba"))!;
    await second.deleteAgent("aba");
    await second.createAgent(snapshot.agent, "main");
    await expect(first.compareAndSwapAgent("aba", { expected: snapshot.revision, mutationId: "stale", patch: {} }))
      .rejects.toMatchObject({ code: "agent_revision_conflict" });
  });

  it("fences delayed deletion across independent PostgreSQL connections", async () => {
    await first.createAgent({ name: "delete-fence" }, "main");
    const old = (await first.getAgentSnapshot("delete-fence"))!;
    await second.updateAgent("delete-fence", { role: "edited" });
    await expect(first.deleteAgentIfRevision("delete-fence", old.revision))
      .rejects.toMatchObject({ code: "agent_revision_conflict" });
    const updated = (await second.getAgentSnapshot("delete-fence"))!;
    expect(await second.deleteAgentIfRevision("delete-fence", updated.revision)).toBe(true);
    await second.createAgent(updated.agent, "main");
    await expect(first.deleteAgentIfRevision("delete-fence", updated.revision))
      .rejects.toMatchObject({ code: "agent_revision_conflict" });
    expect((await first.getAgent("delete-fence"))?.role).toBe("edited");
  });

  it("preserves explicit null and removal in JSONB", async () => {
    await first.createAgent({ name: "json", role: "remove", skills: ["preserve"] }, "main");
    const snapshot = (await first.getAgentSnapshot("json"))!;
    const receipt = await second.compareAndSwapAgent("json", { expected: snapshot.revision, mutationId: "json-change",
      patch: { set: { model: null }, unset: ["role"] } });
    expect(receipt.snapshot.agent).toMatchObject({ model: null, skills: ["preserve"] });
    expect(receipt.snapshot.agent).not.toHaveProperty("role");
    expect(await first.getAgent("json")).toEqual(receipt.snapshot.agent);
  });
});
