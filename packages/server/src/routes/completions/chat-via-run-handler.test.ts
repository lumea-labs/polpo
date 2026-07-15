import { describe, expect, it, vi } from "vitest";
import { completionRoutes, type CompletionRouteDeps } from "../completions.js";

function parseSse(body: string): any[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

function baseDeps(overrides: Partial<CompletionRouteDeps> = {}): CompletionRouteDeps {
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
        name: "Mock Model",
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
      hooks.onEvent({
        type: "usage",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        providerMetadata: { gateway: { generationId: "gen_1" } },
      });
      return { status: "completed", result: { exitCode: 0, stdout: "hello", stderr: "" } };
    },
    ...overrides,
  };
}

describe("chat via Run driver", () => {
  it("uses the host runtime prompt assembler for chat Run injection", async () => {
    const buildRuntimePrompt = vi.fn(async () => "host-composed-runtime-prompt");
    const runChatViaRun = vi.fn(async (inject: any, hooks: any) => {
      expect(inject.systemPrompt).toBe("host-composed-runtime-prompt");
      hooks.onEvent({ type: "text-delta", text: "hello" });
      return { status: "completed", result: { exitCode: 0, stdout: "hello", stderr: "" } };
    });
    const deps = baseDeps({ buildRuntimePrompt, runChatViaRun });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "agent-1",
        stream: true,
        messages: [
          { role: "system", content: "caller context" },
          { role: "user", content: "hello" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ name: "agent-1" }),
      {
        mode: "chat",
        extraSystemParts: ["caller context"],
        includeAgentMemory: true,
      },
    );
    expect(runChatViaRun).toHaveBeenCalledTimes(1);
  });

  it("preserves provider-tool observability, usage callback, session persistence, and cleanup", async () => {
    const onCompletionFinished = vi.fn();
    const cleanup = vi.fn(async () => {});
    const updateMessage = vi.fn(async () => true);
    let messageIndex = 0;
    const sessionStore = {
      create: vi.fn(async () => "session-1"),
      addMessage: vi.fn(async (_sessionId: string, role: string, content: unknown) => ({
        id: `message-${++messageIndex}`,
        role,
        content,
      })),
      updateMessage,
    };

    const deps = baseDeps({
      getSessionStore: () => sessionStore,
      onCompletionFinished,
      resolveAgentTools: async () => ({
        tools: [],
        extraAiTools: { search_web: { type: "provider-defined" } },
        executor: async () => { throw new Error("provider tool must not run locally"); },
        cleanup,
      }),
      runChatViaRun: async (_inject, hooks) => {
        hooks.onEvent({ type: "tool_input_start", toolId: "call_1", tool: "search_web" });
        hooks.onEvent({ type: "tool_input_delta", toolId: "call_1", delta: "{\"query\":\"Polpo\"}" });
        hooks.onEvent({
          type: "tool_result",
          toolId: "call_1",
          tool: "search_web",
          input: { query: "Polpo" },
          content: "{\"results\":[]}",
          providerExecuted: true,
          isError: false,
        });
        hooks.onEvent({ type: "text-delta", text: "done" });
        hooks.onEvent({
          type: "usage",
          usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
          providerMetadata: { gateway: { generationId: "gen_provider" } },
        });
        return { status: "completed", result: { exitCode: 0, stdout: "done", stderr: "" } };
      },
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent-1", stream: true, messages: [{ role: "user", content: "search" }] }),
    });
    expect(response.status).toBe(200);
    const chunks = parseSse(await response.text());
    const toolEvents = chunks.map((chunk) => chunk.choices?.[0]?.tool_call).filter(Boolean);
    expect(toolEvents.some((event) => event.state === "preparing")).toBe(true);
    expect(toolEvents.some((event) => event.state === "calling" || event.state === "completed")).toBe(false);
    expect(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter(Boolean).join("")).toBe("done");

    expect(updateMessage).toHaveBeenCalledWith(
      "session-1",
      "message-2",
      "done",
      [expect.objectContaining({
        id: "call_1",
        name: "search_web",
        arguments: { query: "Polpo" },
        providerExecuted: true,
        state: "completed",
      })],
    );
    expect(onCompletionFinished).toHaveBeenCalledWith(expect.objectContaining({
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
      providerMetadata: { gateway: { generationId: "gen_provider" } },
      model: "mock-model",
      resolvedModel: {
        id: "mock-model",
        name: "Mock Model",
        provider: "mock",
        runtimeMode: "provider",
      },
      agent: "agent-1",
      sessionId: "session-1",
    }));
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it("surfaces a failed Run instead of returning a silent empty completion", async () => {
    const deps = baseDeps({
      runChatViaRun: async () => ({
        status: "failed",
        result: { exitCode: 1, stdout: "", stderr: "sandbox acquisition timed out" },
      }),
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent-1", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    const chunks = parseSse(await response.text());
    expect(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter(Boolean).join(""))
      .toContain("sandbox acquisition timed out");
    expect(chunks.find((chunk) => chunk.choices?.[0]?.error)?.choices[0].error).toMatchObject({
      type: "model_error",
      code: "model_request_failed",
      message: "sandbox acquisition timed out",
    });
  });

  it("does not route orchestrator mode through an agent-only Run injection", async () => {
    const runChatViaRun = vi.fn();
    const deps = baseDeps({
      runChatViaRun,
      resolveOrchestratorContext: async () => ({
        systemPrompt: "orchestrate",
        model: {
          id: "mock-model",
          name: "Mock Model",
          provider: "mock",
          runtimeMode: "provider",
          aiModel: {} as any,
          contextWindow: 200_000,
          maxTokens: 8192,
        },
        tools: [],
        executor: async () => "ok",
        isInteractive: () => false,
      }),
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(400);
    expect(runChatViaRun).not.toHaveBeenCalled();
  });
});
