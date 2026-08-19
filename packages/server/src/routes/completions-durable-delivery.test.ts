import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRunCancellationStore,
  InMemoryRunEventStore,
  InMemoryRunExecutionLeaseStore,
} from "@polpo-ai/core/run-delivery";
import { InMemoryRunEventNotifier } from "@polpo-ai/core/run-delivery-follower";
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
});
