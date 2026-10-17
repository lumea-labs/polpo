import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRunCancellationStore,
  InMemoryRunEventStore,
  InMemoryRunExecutionLeaseStore,
} from "@polpo-ai/core/run-delivery";
import { InMemoryRunEventNotifier } from "@polpo-ai/core/run-delivery-follower";
import { MemoryLoopRunStore } from "@polpo-ai/core/loop-run-store";
import { InMemorySteeringController } from "@polpo-ai/core/steering";
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

function loopDeps(
  scope: CompletionRunDeliveryScope,
  loopRunStore?: MemoryLoopRunStore,
  executedTools?: string[],
): CompletionRouteDeps {
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
      executor: async (name) => {
        executedTools?.push(name);
        return String(time++);
      },
    }),
    createRunDeliveryScope: async () => scope,
    ...(loopRunStore ? { getLoopRunStore: () => loopRunStore } : {}),
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
    const loopRunStore = new MemoryLoopRunStore();
    const res = await completionRoutes(() => loopDeps(scope, loopRunStore)).request("/", request({
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
    const loopRuns = await loopRunStore.listRuns();
    expect(loopRuns).toHaveLength(1);
    expect(loopRuns[0]?.metadata?.deliveryRunId).toBe(runId);
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
    const executedTools: string[] = [];
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
    const deps = loopDeps(scope, undefined, executedTools);
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
    expect(executedTools).toEqual(["unix_time"]);
  });

  it("replays a terminal continuation without starting its producer again", async () => {
    const scope = deliveryScope();
    const classify = vi.fn();
    const resolveExecutionRouteClassifier = vi.fn(async () => ({ classify }));
    let reservedRunId: string | undefined;
    const prepareContinuation = vi.fn(async (input: any) => {
      const status = reservedRunId === undefined ? "prepared" as const : "replay" as const;
      reservedRunId ??= input.runId;
      return {
        status,
        sessionVersion: 3,
        runId: reservedRunId,
        messages: [
          { id: "u1", role: "user", content: "Continue", ts: "2026-01-01T00:00:00Z" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            ts: "2026-01-01T00:00:01Z",
            toolCalls: [{
              id: "call-1",
              name: "client_action",
              arguments: {},
              state: "completed",
              result: "done",
            }],
          },
          {
            id: "t1",
            role: "tool",
            content: "done",
            ts: "2026-01-01T00:00:02Z",
            toolCallId: "call-1",
          },
        ],
      };
    });
    const runChatViaRun = vi.fn(async (_inject: unknown, hooks: any) => {
      hooks.onEvent({ type: "text-delta", text: "continued" });
      return {
        status: "completed",
        result: { exitCode: 0, stdout: "continued", stderr: "" },
      };
    });
    const deps = viaRunDeps({
      getAgents: async () => [{
        name: "agent-1",
        role: "Test agent",
        model: "mock",
        assignedLoops: ["research"],
        executionRouter: { mode: "auto", allowedLoops: ["research"] },
      }],
      getProjectLoop: async (name) => ({
        name,
        start: "run",
        steps: { run: { type: "agent", next: "end" } },
      }),
      resolveExecutionRouteClassifier,
      createRunDeliveryScope: async () => ({
        ...scope,
        token: `attempt-${Math.random()}`,
      }),
      getSessionStore: () => ({
        prepareContinuation,
        addMessage: vi.fn(async (_sessionId, role, content) => ({
          id: `message-${role}`,
          role,
          content,
          ts: new Date().toISOString(),
        })),
        updateMessage: vi.fn(async () => true),
      } as any),
      runChatViaRun,
    });
    const continuationRequest = () => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
        "idempotency-key": "continue-1",
      },
      body: JSON.stringify({
        agent: "agent-1",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "done" }],
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
    expect(await first.text()).toContain("[DONE]");
    const runId = first.headers.get("x-polpo-run-id")!;
    const firstEvents = (await scope.eventStore.listAfter(runId)).events;
    expect(firstEvents.at(-1)?.type).toBe("run.completed");

    const replay = await completionRoutes(() => deps).request("/", continuationRequest());
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-polpo-run-id")).toBe(runId);
    expect(await replay.text()).toContain("[DONE]");
    await vi.waitFor(() => expect(runChatViaRun).toHaveBeenCalledTimes(1));

    const replayedEvents = (await scope.eventStore.listAfter(runId)).events;
    expect(replayedEvents).toEqual(firstEvents);
    expect(replayedEvents.findIndex((event) => event.type === "run.completed"))
      .toBe(replayedEvents.length - 1);
    expect(resolveExecutionRouteClassifier).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("fences a prepared request delayed behind a concurrent replay of the same reserved run", async () => {
    const baseScope = deliveryScope();
    const baseLeases = baseScope.leaseStore;
    let claimCalls = 0;
    let secondClaimEntered!: () => void;
    const secondClaimWaiting = new Promise<void>((resolve) => { secondClaimEntered = resolve; });
    let releaseSecondClaim!: () => void;
    const secondClaimReleased = new Promise<void>((resolve) => { releaseSecondClaim = resolve; });
    const leaseStore = {
      get: baseLeases.get.bind(baseLeases),
      renew: baseLeases.renew.bind(baseLeases),
      release: baseLeases.release.bind(baseLeases),
      claim: async (...args: Parameters<typeof baseLeases.claim>) => {
        const call = ++claimCalls;
        if (call === 1) await secondClaimWaiting;
        if (call === 2) {
          secondClaimEntered();
          await secondClaimReleased;
        }
        return baseLeases.claim(...args);
      },
    };
    const executions: Promise<unknown>[] = [];
    const requestCleanups: Array<ReturnType<typeof vi.fn>> = [];
    const scope: CompletionRunDeliveryScope = {
      ...baseScope,
      leaseStore,
      trackExecution: (_runId, execution) => { executions.push(execution); },
    };
    let reservedRunId: string | undefined;
    const prepareContinuation = vi.fn(async (input: any) => {
      const status = reservedRunId === undefined ? "prepared" as const : "replay" as const;
      reservedRunId ??= input.runId;
      return {
        status,
        sessionVersion: 3,
        runId: reservedRunId,
        messages: [
          { id: "u1", role: "user", content: "Continue", ts: "2026-01-01T00:00:00Z" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            ts: "2026-01-01T00:00:01Z",
            toolCalls: [{ id: "call-1", name: "client_action", state: "completed", result: "done" }],
          },
          { id: "t1", role: "tool", content: "done", ts: "2026-01-01T00:00:02Z", toolCallId: "call-1" },
        ],
      };
    });
    const runChatViaRun = vi.fn(async (_inject: unknown, hooks: any) => {
      hooks.onEvent({ type: "text-delta", text: "continued once" });
      return {
        status: "completed",
        result: { exitCode: 0, stdout: "continued once", stderr: "" },
      };
    });
    const deps = viaRunDeps({
      createRunDeliveryScope: async () => ({
        ...scope,
        token: `attempt-${Math.random()}`,
      }),
      getSessionStore: () => ({
        prepareContinuation,
        addMessage: vi.fn(async (_sessionId, role, content) => ({
          id: `message-${role}`,
          role,
          content,
          ts: new Date().toISOString(),
        })),
        updateMessage: vi.fn(async () => true),
      } as any),
      resolveAgentTools: async () => {
        const cleanup = vi.fn(async () => undefined);
        requestCleanups.push(cleanup);
        return { tools: [], executor: async () => "ok", cleanup };
      },
      runChatViaRun,
    });
    const continuationRequest = () => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
        "idempotency-key": "continue-1",
      },
      body: JSON.stringify({
        agent: "agent-1",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "done" }],
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
    const second = await completionRoutes(() => deps).request("/", continuationRequest());
    const firstBodyPromise = first.text();
    const secondBodyPromise = second.text();
    await secondClaimWaiting;
    const firstBody = await firstBodyPromise;
    const secondBody = await secondBodyPromise;
    expect(firstBody).toContain("continued once");
    expect(secondBody).toContain("continued once");
    releaseSecondClaim();
    await Promise.all(executions);

    expect(runChatViaRun).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(requestCleanups).toHaveLength(2);
      expect(requestCleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    });
    expect(first.headers.get("x-polpo-run-id")).toBe(reservedRunId);
    expect(second.headers.get("x-polpo-run-id")).toBe(reservedRunId);
    expect((await scope.eventStore.listAfter(reservedRunId!)).events.map(
      (event) => event.type,
    ).at(-1)).toBe("run.completed");
  });

  it("registers Project Loop steering only after the durable owner wins admission", async () => {
    const baseScope = deliveryScope();
    const baseLeases = baseScope.leaseStore;
    let claimCalls = 0;
    let secondClaimEntered!: () => void;
    const secondClaimWaiting = new Promise<void>((resolve) => { secondClaimEntered = resolve; });
    let winnerProducerEntered!: () => void;
    const winnerProducerActive = new Promise<void>((resolve) => { winnerProducerEntered = resolve; });
    let losingClaimFinished!: () => void;
    const losingClaimSettled = new Promise<void>((resolve) => { losingClaimFinished = resolve; });
    const leaseStore = {
      get: baseLeases.get.bind(baseLeases),
      renew: baseLeases.renew.bind(baseLeases),
      release: baseLeases.release.bind(baseLeases),
      claim: async (...args: Parameters<typeof baseLeases.claim>) => {
        const call = ++claimCalls;
        if (call === 1) await secondClaimWaiting;
        if (call === 2) {
          secondClaimEntered();
          await winnerProducerActive;
          const claimed = await baseLeases.claim(...args);
          losingClaimFinished();
          return claimed;
        }
        return baseLeases.claim(...args);
      },
    };
    const executions: Promise<unknown>[] = [];
    const scope: CompletionRunDeliveryScope = {
      ...baseScope,
      leaseStore,
      trackExecution: (_runId, execution) => { executions.push(execution); },
    };
    let reservedRunId: string | undefined;
    const prepareContinuation = vi.fn(async (input: any) => {
      const status = reservedRunId === undefined ? "prepared" as const : "replay" as const;
      reservedRunId ??= input.runId;
      return {
        status,
        sessionVersion: 3,
        runId: reservedRunId,
        messages: [
          { id: "u1", role: "user", content: "Build a site", ts: "2026-01-01T00:00:00Z" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            ts: "2026-01-01T00:00:01Z",
            toolCalls: [{ id: "call-1", name: "client_action", state: "completed", result: "done" }],
          },
          { id: "t1", role: "tool", content: "done", ts: "2026-01-01T00:00:02Z", toolCallId: "call-1" },
        ],
      };
    });
    let finishWinner!: () => void;
    const winnerCanFinish = new Promise<void>((resolve) => { finishWinner = resolve; });
    const executedTools: string[] = [];
    const deps = loopDeps(scope, undefined, executedTools);
    deps.createRunDeliveryScope = async () => ({
      ...scope,
      token: `attempt-${Math.random()}`,
    });
    const steering = new InMemorySteeringController();
    const closeSteering = vi.spyOn(steering, "close");
    const releaseSteering = vi.fn(async () => undefined);
    const createRunSteeringScope = vi.fn(async () => ({
      steering,
      release: releaseSteering,
    }));
    deps.createRunSteeringScope = createRunSteeringScope;
    deps.resolveAgentTools = async () => ({
      tools: [{
        name: "unix_time",
        description: "Return the current time",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      executor: async (name) => {
        executedTools.push(name);
        winnerProducerEntered();
        await winnerCanFinish;
        return "100";
      },
    });
    deps.getSessionStore = () => ({
      prepareContinuation,
      addMessage: vi.fn(async (_sessionId, role, content) => ({
        id: `message-${role}`,
        role,
        content,
        ts: new Date().toISOString(),
      })),
      updateMessage: vi.fn(async () => true),
    } as any);
    const continuationRequest = () => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
        "idempotency-key": "continue-loop-1",
      },
      body: JSON.stringify({
        agent: "timer",
        loop: "time-tracker",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "done" }],
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
    const second = await completionRoutes(() => deps).request("/", continuationRequest());
    const firstBody = first.text();
    const secondBody = second.text();
    await winnerProducerActive;
    await losingClaimSettled;

    expect(createRunSteeringScope).toHaveBeenCalledOnce();
    expect(closeSteering).not.toHaveBeenCalled();
    expect(releaseSteering).not.toHaveBeenCalled();

    finishWinner();
    await expect(firstBody).resolves.toContain("[DONE]");
    await expect(secondBody).resolves.toContain("[DONE]");
    await Promise.all(executions);

    expect(executedTools).toEqual(["unix_time"]);
    expect(releaseSteering).toHaveBeenCalledOnce();
    expect((await scope.eventStore.listAfter(reservedRunId!)).events.at(-1)?.type)
      .toBe("run.completed");
  });

  it.each(["run.failed", "run.cancelled"] as const)(
    "does not restart a continuation whose delivery ended with %s",
    async (terminalType) => {
      const scope = deliveryScope();
      const runId = `chatcmpl-${terminalType}`;
      await scope.eventStore.append(runId, {
        id: "run.started",
        type: "run.started",
        data: {},
      });
      await scope.eventStore.append(runId, {
        id: terminalType,
        type: terminalType,
        data: terminalType === "run.failed" ? { message: "failed" } : {},
      });
      const originalEvents = (await scope.eventStore.listAfter(runId)).events;
      const runChatViaRun = vi.fn();
      const deps = viaRunDeps({
        createRunDeliveryScope: async () => ({
          ...scope,
          token: `attempt-${Math.random()}`,
        }),
        getSessionStore: () => ({
          prepareContinuation: vi.fn(async () => ({
            status: "replay",
            sessionVersion: 3,
            runId,
            messages: [
              { id: "u1", role: "user", content: "Continue", ts: "2026-01-01T00:00:00Z" },
              {
                id: "a1",
                role: "assistant",
                content: "",
                ts: "2026-01-01T00:00:01Z",
                toolCalls: [{ id: "call-1", name: "client_action", state: "completed", result: "done" }],
              },
              { id: "t1", role: "tool", content: "done", ts: "2026-01-01T00:00:02Z", toolCallId: "call-1" },
            ],
          })),
        } as any),
        runChatViaRun,
      });

      const response = await completionRoutes(() => deps).request("/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "session-1",
          "idempotency-key": "continue-1",
        },
        body: JSON.stringify({
          agent: "agent-1",
          stream: true,
          messages: [{ role: "tool", tool_call_id: "call-1", content: "done" }],
          polpo: {
            continuation: { type: "client_tool", tool_call_id: "call-1", expected_session_version: 2 },
            delivery: { onDisconnect: "continue" },
          },
        }),
      });

      expect(response.status).toBe(200);
      await response.text();
      expect(runChatViaRun).not.toHaveBeenCalled();
      expect((await scope.eventStore.listAfter(runId)).events).toEqual(originalEvents);
    },
  );

  it("starts the reserved continuation when admission committed before run.started", async () => {
    const scope = deliveryScope();
    const runId = "chatcmpl-accepted-without-start";
    const runChatViaRun = vi.fn(async (_inject: unknown, hooks: any) => {
      hooks.onEvent({ type: "text-delta", text: "recovered" });
      return {
        status: "completed",
        result: { exitCode: 0, stdout: "recovered", stderr: "" },
      };
    });
    const deps = viaRunDeps({
      createRunDeliveryScope: async () => ({
        ...scope,
        token: `attempt-${Math.random()}`,
      }),
      getSessionStore: () => ({
        prepareContinuation: vi.fn(async () => ({
          status: "replay",
          sessionVersion: 3,
          runId,
          messages: [
            { id: "u1", role: "user", content: "Continue", ts: "2026-01-01T00:00:00Z" },
            {
              id: "a1",
              role: "assistant",
              content: "",
              ts: "2026-01-01T00:00:01Z",
              toolCalls: [{ id: "call-1", name: "client_action", state: "completed", result: "done" }],
            },
            { id: "t1", role: "tool", content: "done", ts: "2026-01-01T00:00:02Z", toolCallId: "call-1" },
          ],
        })),
        addMessage: vi.fn(async (_sessionId, role, content) => ({
          id: `message-${role}`,
          role,
          content,
          ts: new Date().toISOString(),
        })),
        updateMessage: vi.fn(async () => true),
      } as any),
      runChatViaRun,
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
        "idempotency-key": "continue-1",
      },
      body: JSON.stringify({
        agent: "agent-1",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "done" }],
        polpo: {
          continuation: { type: "client_tool", tool_call_id: "call-1", expected_session_version: 2 },
          delivery: { onDisconnect: "continue" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("recovered");
    expect(runChatViaRun).toHaveBeenCalledOnce();
    expect((await scope.eventStore.listAfter(runId)).events.at(-1)?.type)
      .toBe("run.completed");
  });

  it("terminalizes an ownerless started continuation without replaying it", async () => {
    const scope = deliveryScope();
    const runId = "chatcmpl-ownerless-started";
    await scope.eventStore.append(runId, {
      id: "run.started",
      type: "run.started",
      data: {},
    });
    const runChatViaRun = vi.fn();
    const deps = viaRunDeps({
      createRunDeliveryScope: async () => ({
        ...scope,
        token: `attempt-${Math.random()}`,
      }),
      getSessionStore: () => ({
        prepareContinuation: vi.fn(async () => ({
          status: "replay",
          sessionVersion: 3,
          runId,
          messages: [
            { id: "u1", role: "user", content: "Continue", ts: "2026-01-01T00:00:00Z" },
            {
              id: "a1",
              role: "assistant",
              content: "",
              ts: "2026-01-01T00:00:01Z",
              toolCalls: [{ id: "call-1", name: "client_action", state: "completed", result: "done" }],
            },
            { id: "t1", role: "tool", content: "done", ts: "2026-01-01T00:00:02Z", toolCallId: "call-1" },
          ],
        })),
      } as any),
      runChatViaRun,
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
        "idempotency-key": "continue-1",
      },
      body: JSON.stringify({
        agent: "agent-1",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "done" }],
        polpo: {
          continuation: { type: "client_tool", tool_call_id: "call-1", expected_session_version: 2 },
          delivery: { onDisconnect: "continue" },
        },
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(runChatViaRun).not.toHaveBeenCalled();
    expect((await scope.eventStore.listAfter(runId)).events.at(-1)).toMatchObject({
      type: "run.failed",
      data: { code: "run_execution_interrupted" },
    });
  });

  it("follows an active continuation owner without starting a competing producer", async () => {
    const scope = deliveryScope();
    const runId = "chatcmpl-active-owner";
    await scope.leaseStore.claim(runId, {
      owner: "original-worker",
      token: "original-attempt",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await scope.eventStore.append(runId, {
      id: "run.started",
      type: "run.started",
      data: {},
    });
    const runChatViaRun = vi.fn();
    const classify = vi.fn();
    const resolveExecutionRouteClassifier = vi.fn(async () => ({ classify }));
    const deps = viaRunDeps({
      getAgents: async () => [{
        name: "agent-1",
        role: "Test agent",
        model: "mock",
        assignedLoops: ["research"],
        executionRouter: { mode: "auto", allowedLoops: ["research"] },
      }],
      getProjectLoop: async (name) => ({
        name,
        start: "run",
        steps: { run: { type: "agent", next: "end" } },
      }),
      resolveExecutionRouteClassifier,
      createRunDeliveryScope: async () => ({
        ...scope,
        token: `attempt-${Math.random()}`,
      }),
      getSessionStore: () => ({
        prepareContinuation: vi.fn(async () => ({
          status: "replay",
          sessionVersion: 3,
          runId,
          messages: [
            { id: "u1", role: "user", content: "Continue", ts: "2026-01-01T00:00:00Z" },
            {
              id: "a1",
              role: "assistant",
              content: "",
              ts: "2026-01-01T00:00:01Z",
              toolCalls: [{ id: "call-1", name: "client_action", state: "completed", result: "done" }],
            },
            { id: "t1", role: "tool", content: "done", ts: "2026-01-01T00:00:02Z", toolCallId: "call-1" },
          ],
        })),
      } as any),
      runChatViaRun,
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
        "idempotency-key": "continue-1",
      },
      body: JSON.stringify({
        agent: "agent-1",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "done" }],
        polpo: {
          continuation: { type: "client_tool", tool_call_id: "call-1", expected_session_version: 2 },
          delivery: { onDisconnect: "continue" },
        },
      }),
    });
    const body = response.text();
    await scope.eventStore.append(runId, {
      type: "response.done",
      data: { data: "[DONE]" },
    });
    await scope.eventStore.append(runId, {
      id: "run.completed",
      type: "run.completed",
      data: {},
    });
    await scope.notifier?.publish(runId, "3");

    expect(await body).toContain("[DONE]");
    expect(runChatViaRun).not.toHaveBeenCalled();
    expect(resolveExecutionRouteClassifier).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    await expect(scope.leaseStore.get(runId)).resolves.toMatchObject({
      owner: "original-worker",
      token: "original-attempt",
    });
  });

  it("atomically continues a cancelled client tool in direct chat", async () => {
    const scope = deliveryScope();
    const observedModelMessages: unknown[][] = [];
    const executedTools: string[] = [];
    const deps = continuationLoopDeps(scope, observedModelMessages, executedTools);
    const prepareContinuation = vi.fn(async (input: any) => ({
      status: "prepared" as const,
      sessionVersion: 55,
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
            result: '{"cancelled":true}',
          }],
        },
        {
          id: "t1",
          role: "tool",
          content: '{"cancelled":true}',
          ts: "2026-01-01T00:00:02Z",
          toolCallId: "call-1",
        },
      ],
    }));
    deps.getSessionStore = () => ({
      prepareContinuation,
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
        "idempotency-key": "cancel-1",
      },
      body: JSON.stringify({
        agent: "leo",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: '{"cancelled":true}' }],
        polpo: {
          continuation: {
            type: "client_tool",
            tool_call_id: "call-1",
            expected_session_version: 54,
          },
          delivery: { onDisconnect: "continue" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-session-version")).toBe("56");
    expect(await res.text()).toContain("implemented");
    expect(prepareContinuation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      toolCallId: "call-1",
      result: '{"cancelled":true}',
    }));
    expect(observedModelMessages).toHaveLength(1);
    expect(observedModelMessages[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "tool" }),
    ]));
    expect(executedTools).toEqual([]);
    expect((await scope.eventStore.listAfter(res.headers.get("x-polpo-run-id")!)).events.at(-1)?.type)
      .toBe("run.completed");
  });

  it.each([
    {
      name: "isolated",
      messages: [{ role: "tool", tool_call_id: "call-1", content: '{"cancelled":true}' }],
    },
    {
      name: "before its assistant call",
      messages: [
        { role: "tool", tool_call_id: "call-1", content: '{"cancelled":true}' },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "configure_site_connector", arguments: "{}" },
          }],
        },
      ],
    },
    {
      name: "duplicated",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "configure_site_connector", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call-1", content: '{"cancelled":true}' },
        { role: "tool", tool_call_id: "call-1", content: '{"cancelled":true}' },
      ],
    },
  ])("rejects a $name direct-chat tool result before invoking the model", async ({ messages }) => {
    const observedModelMessages: unknown[][] = [];
    const deps = continuationLoopDeps(deliveryScope(), observedModelMessages, []);

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-1",
      },
      body: JSON.stringify({
        agent: "leo",
        stream: true,
        messages,
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "client_tool_continuation_required" },
    });
    expect(observedModelMessages).toEqual([]);
  });

  it("keeps a complete OpenAI-compatible direct tool history supported", async () => {
    const observedModelMessages: unknown[][] = [];
    const deps = continuationLoopDeps(deliveryScope(), observedModelMessages, []);

    const res = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "leo",
        stream: true,
        messages: [
          { role: "user", content: "Add Calendly" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "configure_site_connector", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call-1", content: '{"cancelled":true}' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("implemented");
    expect(observedModelMessages[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "tool" }),
    ]));
  });

  it("fails closed when a direct continuation rebuilds no model-visible history", async () => {
    const observedModelMessages: unknown[][] = [];
    const deps = continuationLoopDeps(deliveryScope(), observedModelMessages, []);
    deps.getSessionStore = () => ({
      prepareContinuation: vi.fn(async (input: any) => ({
        status: "prepared",
        sessionVersion: 2,
        runId: input.runId,
        messages: [{
          id: "t1",
          role: "tool",
          content: '{"cancelled":true}',
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
        "idempotency-key": "cancel-corrupt",
      },
      body: JSON.stringify({
        agent: "leo",
        stream: true,
        messages: [{ role: "tool", tool_call_id: "call-1", content: '{"cancelled":true}' }],
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
      error: { code: "client_tool_continuation_prompt_required" },
    });
    expect(observedModelMessages).toEqual([]);
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
