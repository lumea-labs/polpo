import { describe, expect, it, vi } from "vitest";
import { AgentMutationError, type AgentSnapshot, type AgentMutation } from "@polpo-ai/core/agent-store";
import { agentRoutes } from "./agents.js";

function fixture(versioned = true) {
  const snapshot: AgentSnapshot = { agent: { name: "support", allowedTools: ["read"], identity: { displayName: "Support" } },
    teamName: "main", revision: { incarnation: "creation", version: 7 } };
  const getAgents = vi.fn(async () => [snapshot.agent]);
  const getAgentSnapshot = vi.fn(async () => structuredClone(snapshot));
  const updateAgent = vi.fn(async () => ({ ...snapshot.agent, role: "ordinary receipt" }));
  const compareAndSwapAgent = vi.fn(async (_name: string, mutation: AgentMutation) => {
    if (mutation.expected.version !== snapshot.revision.version) throw new AgentMutationError("agent_revision_conflict", "Changed");
    return { mutationId: mutation.mutationId, previousRevision: mutation.expected, snapshot: {
      ...snapshot, agent: { ...snapshot.agent, ...mutation.patch.set } as AgentSnapshot["agent"],
      revision: { ...snapshot.revision, version: snapshot.revision.version + 1 },
    } };
  });
  const app = agentRoutes(() => ({
    getAgents, updateAgent, ...(versioned ? { getAgentSnapshot, compareAndSwapAgent } : {}),
    addAgent: async () => {}, removeAgent: async () => false, getTeams: async () => [], getTeam: async () => undefined,
    addTeam: async () => {}, updateTeam: async () => undefined, removeTeam: async () => false, renameTeam: async () => {},
    taskStore: {}, runStore: {}, polpoDir: ".polpo",
  }));
  return { app, snapshot, getAgents, getAgentSnapshot, compareAndSwapAgent, updateAgent };
}

describe("agent revision HTTP contract", () => {
  it("returns the revision and ETag of the same snapshot", async () => {
    const f = fixture();
    const response = await f.app.request("/support");
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"agent:creation:7"');
    expect(await response.json()).toMatchObject({ revision: f.snapshot.revision, data: f.snapshot.agent });
    expect(f.getAgents).not.toHaveBeenCalled();
  });

  it("uses If-Match and an idempotency key and returns the commit, never a later reread", async () => {
    const f = fixture();
    const response = await f.app.request("/support", { method: "PATCH", headers: {
      "content-type": "application/json", "if-match": '"agent:creation:7"', "idempotency-key": "assignment-1",
    }, body: JSON.stringify({ allowedTools: ["read", "gmail_read"], identity: { bio: "New" }, reportsTo: "" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"agent:creation:8"');
    expect(f.compareAndSwapAgent).toHaveBeenCalledWith("support", {
      expected: f.snapshot.revision, mutationId: "assignment-1", patch: {
        set: { allowedTools: ["read", "gmail_read"], identity: { displayName: "Support", bio: "New" } }, unset: ["reportsTo"],
      },
    });
    expect(await response.json()).toMatchObject({ data: { allowedTools: ["read", "gmail_read"] },
      mutation: { mutationId: "assignment-1", previousRevision: f.snapshot.revision }, revision: { version: 8 } });
    expect(f.updateAgent).not.toHaveBeenCalled();
    expect(f.getAgents).not.toHaveBeenCalled();
    expect(f.getAgentSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects stale configuration with a structured precondition failure", async () => {
    const f = fixture();
    const response = await f.app.request("/support", { method: "PATCH", headers: {
      "content-type": "application/json", "if-match": '"agent:creation:6"', "idempotency-key": "stale",
    }, body: JSON.stringify({ allowedTools: [] }) });
    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({ code: "agent_revision_conflict" });
    expect(f.updateAgent).not.toHaveBeenCalled();
  });

  it.each([
    { "if-match": "*", "idempotency-key": "id" },
    { "if-match": 'W/"agent:creation:7"', "idempotency-key": "id" },
    { "if-match": '"agent:creation:7"' },
    { "idempotency-key": "orphan" },
  ])("never degrades a malformed conditional request to an ordinary write: %j", async headers => {
    const f = fixture();
    const response = await f.app.request("/support", { method: "PATCH", headers: { "content-type": "application/json", ...headers } as Record<string, string>,
      body: JSON.stringify({ role: "new" }) });
    expect(response.status).toBe(400);
    expect(f.updateAgent).not.toHaveBeenCalled();
    expect(f.compareAndSwapAgent).not.toHaveBeenCalled();
  });

  it("fails closed on an adapter without conditional mutation support", async () => {
    const f = fixture(false);
    const response = await f.app.request("/support", { method: "PATCH", headers: {
      "content-type": "application/json", "if-match": '"agent:creation:7"', "idempotency-key": "id",
    }, body: JSON.stringify({ allowedTools: [] }) });
    expect(response.status).toBe(501);
    expect(f.updateAgent).not.toHaveBeenCalled();
  });

  it("rejects an empty team before delegating the mutation", async () => {
    const f = fixture();
    const response = await f.app.request("/support", { method: "PATCH", headers: {
      "content-type": "application/json", "if-match": '"agent:creation:7"', "idempotency-key": "invalid-team",
    }, body: JSON.stringify({ team: "" }) });
    expect(response.status).toBe(400);
    expect(f.compareAndSwapAgent).not.toHaveBeenCalled();
  });

  it("carries explicit field removal without turning it into an empty replacement", async () => {
    const f = fixture();
    const response = await f.app.request("/support", { method: "PATCH", headers: {
      "content-type": "application/json", "if-match": '"agent:creation:7"', "idempotency-key": "unset-policy",
    }, body: JSON.stringify({ unset: ["allowedTools", "mcpServers"] }) });
    expect(response.status).toBe(200);
    expect(f.compareAndSwapAgent).toHaveBeenCalledWith("support", expect.objectContaining({
      patch: { set: {}, unset: ["allowedTools", "mcpServers"] },
    }));
  });

  it.each([false, true])("rejects ambiguous/unconditional field removal (%s)", async conditional => {
    const f = fixture();
    const response = await f.app.request("/support", { method: "PATCH", headers: {
      "content-type": "application/json", ...(conditional ? { "if-match": '"agent:creation:7"', "idempotency-key": "unset" } : {}),
    }, body: JSON.stringify({ role: "both set and unset", unset: ["role"] }) });
    expect(response.status).toBe(400);
    expect(f.compareAndSwapAgent).not.toHaveBeenCalled();
    expect(f.updateAgent).not.toHaveBeenCalled();
  });

  it("returns the actual ordinary mutation receipt as well", async () => {
    const f = fixture(false);
    const response = await f.app.request("/support", { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "ordinary receipt" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { role: "ordinary receipt" } });
  });
});
