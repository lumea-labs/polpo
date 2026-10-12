import { describe, expect, it, vi } from "vitest";
import { createToolInvocationContext, MemoryLoopRunStore, type AgentSnapshot } from "@polpo-ai/core";
import { completionRoutes, type CompletionRouteDeps } from "./completions.js";
import { prepareChatCompletionExecution } from "./completions/conversation-turn.js";
import { resumeProjectLoopRun } from "./completions/project-loop-runner.js";
import { buildChatRunInjection } from "./completions/chat-via-run-handler.js";

function fixture() {
  let snapshot: AgentSnapshot | undefined = { agent: { name: "support", role: "original", assignedLoops: ["read"], allowedTools: ["read"] },
    teamName: "default", revision: { incarnation: "original", version: 1 } };
  const store = new MemoryLoopRunStore();
  const read = vi.fn(async () => "read successfully");
  const resolveAgentTools = vi.fn(async (_agent: any, _scope?: unknown, _invocation?: any) => ({
    tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }], executor: read,
  }));
  const deps: CompletionRouteDeps = {
    getAgents: vi.fn(async () => [{ name: "support", role: "unversioned fallback" }]),
    getAgentSnapshot: vi.fn(async () => snapshot),
    getConfig: () => ({}), getMemoryStore: () => null, getSessionStore: () => null, getStore: () => null, emit: vi.fn(),
    getLoopRunStore: () => store,
    getProjectLoop: async () => ({ name: "read", start: "read", steps: { read: { type: "tool", tool: "read", next: "end" } } }),
    buildAgentPrompt: () => "Read",
    resolveAgentModel: async () => ({ model: { id: "test", provider: "test", aiModel: "test-model", contextWindow: 10000, maxTokens: 100 } } as any),
    resolveAgentTools,
  };
  const body = { agent: "support", stream: false, messages: [{ role: "user" as const, content: "Read" }] };
  return { deps, store, read, resolveAgentTools, body, replace: (value: AgentSnapshot | undefined) => { snapshot = value; } };
}

describe("completion agent lifetime capture", () => {
  it("uses the same authoritative snapshot for configuration and identity before awaiting model resolution", async () => {
    const f = fixture();
    const original = f.deps.resolveAgentModel;
    f.deps.resolveAgentModel = async (...args) => {
      f.replace({ agent: { name: "support", role: "replacement" }, teamName: "default", revision: { incarnation: "replacement", version: 0 } });
      return original(...args);
    };
    const prepared = await prepareChatCompletionExecution(f.deps, f.body);
    expect(prepared.kind).toBe("chat");
    expect(f.resolveAgentTools.mock.calls[0][0].role).toBe("original");
    expect(f.resolveAgentTools.mock.calls[0][2].agent).toEqual({ name: "support", incarnation: "original" });
    expect(f.deps.getAgents).not.toHaveBeenCalled();
    expect(f.deps.getAgentSnapshot).toHaveBeenCalledTimes(1);
    if (prepared.kind === "chat") {
      expect(buildChatRunInjection(prepared.execution).toolInvocation?.agent).toEqual({ name: "support", incarnation: "original" });
    }
  });

  it("does not fall back to a name-only config when an authoritative snapshot is absent", async () => {
    const f = fixture(); f.replace(undefined);
    const prepared = await prepareChatCompletionExecution(f.deps, f.body);
    expect(prepared).toMatchObject({ kind: "error", status: 404 });
    expect(f.deps.getAgents).not.toHaveBeenCalled();
    expect(f.resolveAgentTools).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves the snapshot through deterministic loops (stream=%s)", async stream => {
    const f = fixture();
    const response = await completionRoutes(() => f.deps).request("/", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...f.body, loop: "read", stream }) });
    expect(response.status).toBe(200); await response.text();
    expect(f.read).toHaveBeenCalled();
    expect(f.resolveAgentTools.mock.calls[0][2].agent).toEqual({ name: "support", incarnation: "original" });
    const runs = await f.store.listRuns();
    expect(runs[0].metadata?.agentIdentity).toEqual({ name: "support", incarnation: "original" });
  });

  it.each([undefined, { name: "support", incarnation: "former" }, { name: "another", incarnation: "original" }])(
    "rejects an unbound or stale resumed loop before creating tools: %j", async agentIdentity => {
      const f = fixture();
      await f.store.createRun({ id: "paused", loop: { name: "read" }, agentName: "support", metadata: { agentIdentity } });
      await f.store.updateRun("paused", { status: "approval_approved", resume: { context: {}, steps: [{ tool: "read" }], createdAt: new Date().toISOString() } });
      await expect(resumeProjectLoopRun({ deps: f.deps, runId: "paused" })).rejects.toThrow(/identity/i);
      expect(f.read).not.toHaveBeenCalled(); expect(f.resolveAgentTools).not.toHaveBeenCalled();
      expect((await f.store.getRun("paused"))?.status).toBe("approval_approved");
    },
  );

  it("resumes the same incarnation after an ordinary edit and retains it in the tool context", async () => {
    const f = fixture();
    f.replace({ agent: { name: "support", allowedTools: ["read"] }, teamName: "default", revision: { incarnation: "original", version: 90 } });
    await f.store.createRun({ id: "paused", loop: { name: "read" }, agentName: "support", metadata: { agentIdentity: { name: "support", incarnation: "original" } } });
    await f.store.updateRun("paused", { status: "approval_approved", resume: { context: {}, steps: [{ tool: "read" }], createdAt: new Date().toISOString() } });
    expect((await resumeProjectLoopRun({ deps: f.deps, runId: "paused" })).status).toBe("completed");
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.resolveAgentTools.mock.calls[0][2].agent).toEqual({ name: "support", incarnation: "original" });
  });

  it.each(["missing-snapshot-port", "replacement-in-resume-context"])("does not silently rebind a persisted loop: %s", async failure => {
    const f = fixture();
    await f.store.createRun({ id: "paused", loop: { name: "read" }, agentName: "support", metadata: { agentIdentity: { name: "support", incarnation: "original" } } });
    await f.store.updateRun("paused", { status: "approval_approved", resume: { context: {}, steps: [{ tool: "read" }], createdAt: new Date().toISOString() } });
    if (failure === "missing-snapshot-port") delete f.deps.getAgentSnapshot;
    else f.deps.resolveResumedToolInvocation = async () => createToolInvocationContext({ requestId: "paused", runId: "paused", surface: "loop",
      agent: { name: "support", incarnation: "replacement" } });
    await expect(resumeProjectLoopRun({ deps: f.deps, runId: "paused" })).rejects.toThrow(/identity/i);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.resolveAgentTools).not.toHaveBeenCalled();
  });
});
