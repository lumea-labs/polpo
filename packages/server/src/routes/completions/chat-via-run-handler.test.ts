import { describe, expect, it, vi } from "vitest";
import { completionRoutes, runConversationTurn, type CompletionRouteDeps } from "../completions.js";
import { runChatTurnViaRun } from "./chat-via-run-handler.js";

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
  it("prepares a non-HTTP conversation turn from completion route deps", async () => {
    const onCompletionFinished = vi.fn();
    const buildRuntimePrompt = vi.fn(async () => "channel-runtime-prompt");
    const updateMessage = vi.fn(async () => true);
    let messageIndex = 0;
    const sessionStore = {
      create: vi.fn(async () => "channel-session-1"),
      addMessage: vi.fn(async (_sessionId: string, role: string, content: unknown) => ({
        id: `message-${++messageIndex}`,
        role,
        content,
      })),
      updateMessage,
    };
    const runChatViaRun = vi.fn(async (inject: any, hooks: any) => {
      expect(inject.systemPrompt).toBe("channel-runtime-prompt");
      expect(inject.seedMessages).toEqual([{ role: "user", content: "hello from slack" }]);
      hooks.onEvent({ type: "text-delta", text: "reply to slack" });
      hooks.onEvent({
        type: "usage",
        usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
      });
      return { status: "completed", result: { exitCode: 0, stdout: "reply to slack", stderr: "" } };
    });
    const deps = baseDeps({
      buildRuntimePrompt,
      getSessionStore: () => sessionStore,
      onCompletionFinished,
      runChatViaRun,
    });

    const result = await runConversationTurn(deps, {
      body: {
        agent: "agent-1",
        stream: false,
        user: "slack:T1:U1",
        metadata: {
          source: "channel",
          provider: "slack",
          channelId: "channel-1",
        },
        messages: [{ role: "user", content: "hello from slack" }],
      },
    });

    expect(result).toMatchObject({
      text: "reply to slack",
      sessionId: "channel-session-1",
      runStatus: "completed",
      usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
    });
    expect(sessionStore.create).toHaveBeenCalledWith({
      title: "hello from slack",
      agent: "agent-1",
      user: "slack:T1:U1",
      metadata: {
        source: "channel",
        provider: "slack",
        channelId: "channel-1",
      },
    });
    expect(sessionStore.addMessage).toHaveBeenNthCalledWith(
      1,
      "channel-session-1",
      "user",
      "hello from slack",
    );
    expect(updateMessage).toHaveBeenCalledWith(
      "channel-session-1",
      "message-2",
      "reply to slack",
      [],
    );
    expect(buildRuntimePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ name: "agent-1" }),
      {
        mode: "chat",
        extraSystemParts: [],
        includeAgentMemory: true,
      },
    );
    expect(onCompletionFinished).toHaveBeenCalledWith(expect.objectContaining({
      agent: "agent-1",
      sessionId: "channel-session-1",
      user: "slack:T1:U1",
    }));
  });

  it("runs a non-HTTP chat turn through the same Run lifecycle", async () => {
    const onCompletionFinished = vi.fn();
    const updateMessage = vi.fn(async () => true);
    const sessionStore = {
      addMessage: vi.fn(async (_sessionId: string, role: string, content: unknown) => ({
        id: role === "assistant" ? "assistant-message" : "user-message",
        role,
        content,
      })),
      updateMessage,
    };
    const deps = baseDeps({
      getSessionStore: () => sessionStore,
      onCompletionFinished,
      runChatViaRun: async (_inject, hooks) => {
        hooks.onEvent({ type: "text-delta", text: "hello from channel" });
        hooks.onEvent({
          type: "usage",
          usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
          providerMetadata: { gateway: { generationId: "gen_channel" } },
        });
        return {
          status: "completed",
          result: { exitCode: 0, stdout: "hello from channel", stderr: "" },
        };
      },
    });

    const result = await runChatTurnViaRun({
      deps,
      body: { agent: "agent-1", user: "slack:U123" },
      completionId: "chatcmpl-channel",
      agentConfig: { name: "agent-1", role: "Test agent", model: "mock" },
      agentMode: true,
      fullSystemPrompt: "You are a test agent.",
      m: {
        id: "mock-model",
        name: "Mock Model",
        provider: "mock",
        runtimeMode: "provider",
        aiModel: {} as any,
        contextWindow: 200_000,
        maxTokens: 8192,
      },
      modelSelection: { primary: "mock-model", fallbacks: [] },
      effectiveTools: [],
      effectiveToolExecutor: async () => "ok",
      aiMessages: [{ role: "user", content: "hello" }],
      sessionStore,
      sessionId: "channel-session-1",
    });

    expect(result).toMatchObject({
      text: "hello from channel",
      usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
      providerMetadata: { gateway: { generationId: "gen_channel" } },
      runStatus: "completed",
    });
    expect(updateMessage).toHaveBeenCalledWith(
      "channel-session-1",
      "assistant-message",
      "hello from channel",
      [],
    );
    expect(onCompletionFinished).toHaveBeenCalledWith(expect.objectContaining({
      usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
      agent: "agent-1",
      sessionId: "channel-session-1",
      user: "slack:U123",
    }));
  });

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

  it("passes model policy and fallback resolver into chat Run injection", async () => {
    const resolvedModels: string[] = [];
    const runChatViaRun = vi.fn(async (inject: any, hooks: any) => {
      expect(inject.modelSelection).toEqual({
        primary: "mock/primary",
        fallbacks: ["mock/fallback"],
      });
      const fallback = await inject.resolveModelAttempt("mock/fallback");
      expect(fallback.model.id).toBe("fallback");
      hooks.onEvent({ type: "text-delta", text: "hello" });
      return { status: "completed", result: { exitCode: 0, stdout: "hello", stderr: "" } };
    });
    const deps = baseDeps({
      getAgents: async () => [{
        name: "agent-1",
        role: "Test agent",
        model: {
          primary: "mock/primary",
          fallbacks: ["mock/fallback"],
        },
      }],
      resolveAgentModel: async (agentConfig: any) => {
        resolvedModels.push(agentConfig.model);
        const id = String(agentConfig.model).slice(String(agentConfig.model).indexOf("/") + 1);
        return {
          model: {
            id,
            name: id,
            provider: "mock",
            runtimeMode: "provider",
            aiModel: {} as any,
            contextWindow: 200_000,
            maxTokens: 8192,
          },
        };
      },
      runChatViaRun,
    });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "agent-1",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(resolvedModels).toEqual(["mock/primary", "mock/fallback"]);
    expect(runChatViaRun).toHaveBeenCalledTimes(1);
  });

  it("passes request sandbox policy into chat Run injection", async () => {
    const runChatViaRun = vi.fn(async (inject: any, hooks: any) => {
      expect(inject.sandbox).toEqual({ isolation: "fresh" });
      hooks.onEvent({ type: "text-delta", text: "hello" });
      return { status: "completed", result: { exitCode: 0, stdout: "hello", stderr: "" } };
    });
    const deps = baseDeps({ runChatViaRun });

    const response = await completionRoutes(() => deps).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "agent-1",
        stream: true,
        sandbox: { isolation: "fresh" },
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
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
