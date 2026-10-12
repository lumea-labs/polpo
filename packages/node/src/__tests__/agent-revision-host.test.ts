import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteStores, migrateSqliteSchema } from "@polpo-ai/drizzle";
import type { VersionedAgentStore } from "@polpo-ai/core/agent-store";
import { AgentManager } from "@polpo-ai/core/agent-manager";
import { createApp } from "../server/app.js";

describe("self-hosted conditional agent writes", () => {
  let sqlite: InstanceType<typeof Database>;
  let app: ReturnType<typeof createApp>;
  let agentStore: VersionedAgentStore;
  const headers = { Authorization: "Bearer local-revision-test", "Content-Type": "application/json", Origin: "http://localhost:3000" };
  beforeEach(async () => {
    sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    await migrateSqliteSchema(db);
    const stores = createSqliteStores(db);
    agentStore = stores.agentStore;
    await stores.teamStore.createTeam({ name: "main", agents: [] });
    await stores.agentStore.createAgent({ name: "support", allowedTools: ["read"] }, "main");
    const manager = new AgentManager({ agentStore: stores.agentStore, teamStore: stores.teamStore,
      config: { teams: [] }, emitter: { emit: () => {} } } as never);
    app = createApp({ isInitialized: true, engine: manager,
      getAgentStore: () => stores.agentStore, getStore: () => stores.taskStore, getRunStore: () => stores.runStore,
      getPolpoDir: () => ".polpo", getFs: () => undefined,
    } as never, {} as never, { apiKeys: ["local-revision-test"] });
  });
  afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

  it("keeps revision access authenticated and exposes ETag to allowed browsers", async () => {
    expect((await app.request("/api/v1/agents/support")).status).toBe(401);
    const response = await app.request("/api/v1/agents/support", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("etag");
    const body = await response.json();
    expect(body.revision.incarnation).toBeTruthy();
    expect(response.headers.get("etag")).toBe(`"agent:${body.revision.incarnation}:${body.revision.version}"`);
  });

  it("allows one concurrent policy write through the real route, manager and SQL store", async () => {
    const response = await app.request("/api/v1/agents/support", { headers });
    const revision = response.headers.get("etag")!;
    const writes = await Promise.all(["gmail_read", "drive_read"].map((tool, i) => app.request("/api/v1/agents/support", {
      method: "PATCH", headers: { ...headers, "If-Match": revision, "Idempotency-Key": `assign-${i}` },
      body: JSON.stringify({ allowedTools: ["read", tool] }),
    })));
    expect(writes.map(r => r.status).sort()).toEqual([200, 412]);
    const winner = writes.find(r => r.status === 200)!;
    const committed = await winner.json();
    const reread = await (await app.request("/api/v1/agents/support", { headers })).json();
    expect(reread.revision).toEqual(committed.revision);
    expect(reread.data).toEqual(committed.data);
  });

  it("rejects a stale deletion without removing the replacement agent", async () => {
    const original = agentStore.deleteAgentIfRevision.bind(agentStore);
    vi.spyOn(agentStore, "deleteAgentIfRevision").mockImplementationOnce(async (name, expected) => {
      await agentStore.deleteAgent(name);
      await agentStore.createAgent({ name, role: "replacement" }, "main");
      return original(name, expected);
    });
    const response = await app.request("/api/v1/agents/support", { method: "DELETE", headers });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("agent_revision_conflict");
    expect((await agentStore.getAgent("support"))?.role).toBe("replacement");
  });

  it("removes an avatar through the real route without removing the rest of the identity", async () => {
    const created = await app.request("/api/v1/agents/support", {
      method: "PATCH", headers,
      body: JSON.stringify({ identity: { displayName: "Support", avatar: "avatar.png" } }),
    });
    expect(created.status).toBe(200);
    const before = await (await app.request("/api/v1/agents/support", { headers })).json();
    const removed = await app.request("/api/v1/agents/support/avatar", { method: "DELETE", headers });
    expect(removed.status).toBe(200);
    const after = await (await app.request("/api/v1/agents/support", { headers })).json();
    expect(after.data.identity).toEqual({ displayName: "Support" });
    expect(after.revision.version).toBe(before.revision.version + 1);
  });
});
