import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRunCancellationStore,
  InMemoryRunEventStore,
  InMemoryRunExecutionLeaseStore,
} from "@polpo-ai/core/run-delivery";
import { InMemoryRunEventNotifier } from "@polpo-ai/core/run-delivery-follower";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import {
  completionRoutes,
  type CompletionRouteDeps,
} from "./completions.js";
import type { CompletionRunDeliveryScope } from "./completions/durable-stream.js";

function deliveryScope(): CompletionRunDeliveryScope {
  return {
    eventStore: new InMemoryRunEventStore(),
    leaseStore: new InMemoryRunExecutionLeaseStore(),
    cancellationStore: new InMemoryRunCancellationStore(),
    notifier: new InMemoryRunEventNotifier(),
    owner: "test-worker",
    token: `attempt-${Math.random()}`,
  };
}

function viaRunDeps(overrides: Partial<CompletionRouteDeps> = {}): CompletionRouteDeps {
  return {
    getAgents: async () => [{ name: "agent-1", role: "Test agent", model: "mock" }],
    getConfig: () => ({ settings: { chatExecution: "run" } }),
    getMemoryStore: () => null,
    getSessionStore: () => null,
    getStore: () => null,
    emit: () => {},
    resolveAgentModel: async () => ({
      model: {
        id: "mock-model",
        provider: "mock",
        runtimeMode: "provider",
        aiModel: {} as any,
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    }),
    buildAgentPrompt: () => "You are a test agent.",
    resolveAgentTools: async () => ({ tools: [], executor: async () => "ok" }),
    runChatViaRun: async (_inject, hooks) => {
      hooks.onEvent({ type: "text-delta", text: "hello" });
      return { status: "completed", result: { exitCode: 0, stdout: "hello", stderr: "" } };
    },
    ...overrides,
  };
}

function loopDeps(scope: CompletionRunDeliveryScope): CompletionRouteDeps {
  let time = 100;
  return {
    ...viaRunDeps(),
    getConfig: () => ({}),
    getAgents: async () => [{
      name: "timer",
      model: "mock",
      assignedLoops: ["time-tracker"],
      allowedTools: ["unix_time"],
    }],
    getProjectLoop: async (name) => ({
      name,
      start: "capture",
      steps: {
        capture: { type: "tool", tool: "unix_time", next: "end" },
      },
    }),
    resolveAgentTools: async () => ({
      tools: [{
        name: "unix_time",
        description: "Return the current time",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      executor: async () => String(time++),
    }),
    createRunDeliveryScope: async () => scope,
  };
}

function continuationLoopDeps(
  scope: CompletionRunDeliveryScope,
  observedModelMessages: unknown[][],
  executedTools: string[],
): CompletionRouteDeps {
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      observedModelMessages.push(options.prompt);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "implemented" },
          { type: "text-end", id: "text" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 10 },
              outputTokens: { total: 2 },
            },
          },
        ] as any[]),
      };
    },
  });

  return {
    ...viaRunDeps(),
    getConfig: () => ({}),
    getAgents: async () => [{
      name: "leo",
      model: "mock",
      assignedLoops: ["leo-change-site"],
      allowedTools: ["site_context_get", "site_checkout"],
    }],
    getProjectLoop: async (name) => ({
      name,
      start: "context",
      steps: {
        context: { type: "tool", tool: "site_context_get", next: "checkout" },
        checkout: { type: "tool", tool: "site_checkout", next: "implement" },
        implement: { type: "agent", next: "end" },
      },
    }),
    resolveAgentModel: async () => ({
      model: {
        id: "mock-model",
        provider: "mock",
        runtimeMode: "provider",
        aiModel: model,
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    }),
    buildRuntimePrompt: async () => "Implement the requested change.",
    resolveAgentTools: async () => ({
      tools: ["site_context_get", "site_checkout"].map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      })),
      executor: async (name) => {
        executedTools.push(name);
        return `${name}:ok`;
      },
    }),
    createRunDeliveryScope: async () => scope,
  };
}

function request(body: Record<string, unknown>) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: "agent-1",
      messages: [{ role: "user", content: "hello" }],
      ...body,
    }),
  };
}

describe("completion durable delivery routing", () => {
  it("rejects continue for non-streaming requests before execution", async () => {
    const res = await completionRoutes(() => ({} as CompletionRouteDeps)).request("/", request({
      stream: false,
      polpo: { delivery: { onDisconnect: "continue" } },
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "durable_delivery_requires_streaming" },
    });
  });

  it("fails explicitly when the host has no durable delivery scope", async () => {
    const res = await completionRoutes(() => viaRunDeps()).request("/", request({
      stream: true,
      polpo: { delivery: { onDisconnect: "continue" } },
    }));

    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "run_delivery_unavailable" },
    });
  });

  it("journals and returns a via-run completion when continue is explicit", async () => {
    const scope = deliveryScope();
    const createRunDeliveryScope = vi.fn(async () => scope);
    const res = await completionRoutes(() => viaRunDeps({ createRunDeliveryScope })).request("/", request({
      stream: true,
      polpo: { delivery: { onDisconnect: "continue" } },
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-polpo-run-id")).toMatch(/^chatcmpl-/);
    const body = await res.text();
    expect(body).toContain("hello");
    expect(body).toContain("[DONE]");
    expect(createRunDeliveryScope).toHaveBeenCalledOnce();
    const runId = res.headers.get("x-polpo-run-id")!;
    expect((await scope.eventStore.listAfter(runId)).events.map((event) => event.type)).toEqual([
      "run.started",
      "response.chunk",
      "response.chunk",
      "response.chunk",
      "response.done",
      "run.completed",
    ]);
  });

  it("keeps omitted delivery on the legacy attached path", async () => {
    const createRunDeliveryScope = vi.fn(async () => deliveryScope());
    const res = await completionRoutes(() => viaRunDeps({ createRunDeliveryScope })).request("/", request({
      stream: true,
    }));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hello");
    expect(createRunDeliveryScope).not.toHaveBeenCalled();
  });

  it("journals a deterministic project loop on the same delivery contract", async () => {
    const scope = deliveryScope();
    const res = await completionRoutes(() => loopDeps(scope)).request("/", request({
      agent: "timer",
      loop: "time-tracker",
      stream: true,
      polpo: { delivery: { onDisconnect: "continue" } },
    }));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("loop_trace");
    expect(body).toContain("[DONE]");
    const runId = res.headers.get("x-polpo-run-id")!;
    const events = (await scope.eventStore.listAfter(runId)).events;
    expect(events[0]?.type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.some((event) => event.type === "response.done")).toBe(true);
  });

  it("rejects a client-tool continuation without session and idempotency headers", async () => {
    const res = await completionRoutes(() => loopDeps(deliveryScope())).request("/", request({
      agent: "timer",
      loop: "time-tracker",
      stream: true,
      messages: [{ role: "tool", tool_call_id: "call-1", content: "configured" }],
      polpo: {
        continuation: {
          type: "client_tool",
          tool_call_id: "call-1",
          expected_session_version: 2,
        },
        delivery: { onDisconnect: "continue" },
      },
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "continuation_session_required" },
    });
  });

  it("atomically continues canonical session history into one durable loop run", async () => {
    const scope = deliveryScope();
    let reservedRunId: string | undefined;
    const prepareContinuation = vi.fn(async (input: any) => {
      reservedRunId ??= input.runId;
      return {
        status: reservedRunId === input.runId ? "prepared" : "replay",
        sessionVersion: 3,
        runId: reservedRunId,
        messages: [
          { id: "u1", role: "user", content: "Build a site", ts: "2026-01-01T00:00:00Z" },
          {
            id: "a1",
            role: "assistant",
            content: "Choose a module",
            ts: "2026-01-01T00:00:01Z",
            toolCalls: [{
              id: "call-1",
              name: "configure_site_module",
              arguments: { module: "booking" },
              state: "completed",
              result: "configured",
            }],
          },
          {
            id: "t1",
            role: "tool",
            content: "configured",
            ts: "2026-01-01T00:00:02Z",
            toolCallId: "call-1",
          },
        ],
      };
    });
    const addMessage = vi.fn(async (_sessionId, role, content) => ({
      id: `message-${role}`,
      role,
      content,
      ts: new Date().toISOString(),
    }));
    const sessionStore = {
      prepareContinuation,
      addMessage,
      updateMessage: vi.fn(async () => true),
    };
    const deps = loopDeps(scope);
    deps.getSessionStore = () => sessionStore;

    const continuationRequest = () => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
        "idempotency-key": "continue-1",
      },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        stream: true,
        user: "user-1",
        messages: [{ role: "tool", tool_call_id: "call-1", content: "configured" }],
        polpo: {
          continuation: {
            type: "client_tool",
            tool_call_id: "call-1",
            expected_session_version: 2,
          },
          delivery: { onDisconnect: "continue" },
        },
      }),
    });

    const first = await completionRoutes(() => deps).request("/", continuationRequest());
    expect(first.status).toBe(200);
    expect(first.headers.get("x-session-id")).toBe("session-1");
    expect(first.headers.get("x-session-version")).toBe("4");
    expect(await first.text()).toContain("[DONE]");
    const runId = first.headers.get("x-polpo-run-id");
    expect(runId).toBe(reservedRunId);

    const second = await completionRoutes(() => deps).request("/", continuationRequest());
    expect(second.status).toBe(200);
    expect(second.headers.get("x-polpo-run-id")).toBe(runId);
    expect(await second.text()).toContain("[DONE]");
    expect(prepareContinuation).toHaveBeenCalledTimes(2);
    expect(prepareContinuation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      agent: "timer",
      user: "user-1",
      toolCallId: "call-1",
      expectedSessionVersion: 2,
      idempotencyKey: "continue-1",
    }));
    expect(addMessage.mock.calls.every((call) => call[1] === "assistant")).toBe(true);
  });

  it("carries canonical client-tool history through deterministic tools into an agent step", async () => {
    const scope = deliveryScope();
    const observedModelMessages: unknown[][] = [];
    const executedTools: string[] = [];
    const deps = continuationLoopDeps(scope, observedModelMessages, executedTools);
    deps.getSessionStore = () => ({
      prepareContinuation: vi.fn(async (input: any) => ({
        status: "prepared",
        sessionVersion: 8,
        runId: input.runId,
        messages: [
          { id: "u1", role: "user", content: "Add Calendly", ts: "2026-01-01T00:00:00Z" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            ts: "2026-01-01T00:00:01Z",
            toolCalls: [{
              id: "call-1",
              name: "configure_site_connector",
              arguments: { connector: "calendly" },
              state: "completed",
              result: "configured",
            }],
          },
          {
            id: "t1",
            role: "tool",
            content: "configured",
            ts: "2026-01-01T00:00:02Z",
            toolCallId: "call-1",
          },
        ],
      })),
      addMessage: vi.fn(async (_sessionId, role, content) => ({
        id: `message-${role}`,
        role,
        content,
        ts: new Date().toISOString(),
      })),
      updateMessage: vi.fn(async () => true),
    } as any);

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
        "idempotency-key": "continue-1",
      },
      body: JSON.stringify({
        agent: "leo",
        loop: "leo-change-site",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "configured" }],
        polpo: {
          continuation: {
            type: "client_tool",
            tool_call_id: "call-1",
            expected_session_version: 7,
          },
          delivery: { onDisconnect: "continue" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("implemented");
    expect(executedTools).toEqual(["site_context_get", "site_checkout"]);
    expect(observedModelMessages).toHaveLength(1);
    expect(observedModelMessages[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "tool" }),
    ]));
  });

  it("runs an agent step from deterministic loop context without sending an empty prompt", async () => {
    const observedModelMessages: unknown[][] = [];
    const executedTools: string[] = [];
    const deps = continuationLoopDeps(
      deliveryScope(),
      observedModelMessages,
      executedTools,
    );

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "leo",
        loop: "leo-change-site",
        stream: true,
        messages: [{ role: "user", content: "" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("implemented");
    expect(executedTools).toEqual(["site_context_get", "site_checkout"]);
    expect(observedModelMessages).toHaveLength(1);
    expect(observedModelMessages[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user" }),
    ]));
  });

  it("rejects an orphan client-tool result before any project-loop side effect", async () => {
    const observedModelMessages: unknown[][] = [];
    const executedTools: string[] = [];
    const deps = continuationLoopDeps(deliveryScope(), observedModelMessages, executedTools);

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
      },
      body: JSON.stringify({
        agent: "leo",
        loop: "leo-change-site",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "configured" }],
        polpo: { delivery: { onDisconnect: "continue" } },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "client_tool_continuation_required" },
    });
    expect(executedTools).toEqual([]);
    expect(observedModelMessages).toEqual([]);
  });

  it("fails closed before loop tools when canonical continuation history has no model prompt", async () => {
    const observedModelMessages: unknown[][] = [];
    const executedTools: string[] = [];
    const deps = continuationLoopDeps(deliveryScope(), observedModelMessages, executedTools);
    deps.getSessionStore = () => ({
      prepareContinuation: vi.fn(async (input: any) => ({
        status: "prepared",
        sessionVersion: 2,
        runId: input.runId,
        messages: [{
          id: "t1",
          role: "tool",
          content: "configured",
          ts: "2026-01-01T00:00:02Z",
          toolCallId: "call-1",
        }],
      })),
    } as any);

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
        "idempotency-key": "continue-corrupt",
      },
      body: JSON.stringify({
        agent: "leo",
        loop: "leo-change-site",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "configured" }],
        polpo: {
          continuation: {
            type: "client_tool",
            tool_call_id: "call-1",
            expected_session_version: 1,
          },
          delivery: { onDisconnect: "continue" },
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "project_loop_prompt_required" },
    });
    expect(executedTools).toEqual([]);
    expect(observedModelMessages).toEqual([]);
  });
});
