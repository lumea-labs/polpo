import { describe, expect, it, vi } from "vitest";
import { runDeliveryRoutes } from "./run-delivery.js";
import { chatRoutes } from "./chat.js";
import { InMemoryRunEventStore, InMemoryRunExecutionLeaseStore, InMemoryRunCancellationStore } from "@polpo-ai/core/run-delivery";
import { MockLanguageModelV3 } from "ai/test";
import { completionRoutes, runConversationTurn, type CompletionRouteDeps } from "./completions.js";

function fixture() {
  const messages: any[] = [{ id: "older", role: "assistant", content: "Your restaurant is called Luna." }];
  const store = {
    getSession: vi.fn(async () => ({ id: "session-1", version: 1 })),
    create: vi.fn(async () => "session-1"),
    getMessages: vi.fn(async () => messages),
    addMessage: vi.fn(async (_session: string, role: string, content: string) => {
      const message = { id: `m${messages.length}`, role, content };
      messages.push(message); return message;
    }),
    updateMessage: vi.fn(async (_session: string, id: string, content: string, _tools: unknown, suggestions: unknown) => {
      Object.assign(messages.find(m => m.id === id), { content, suggestions });
    }),
  };
  const generate = vi.fn(async () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ suggestions: Array.from({ length: 5 }, (_, i) => ({ label: `Idea ${i}`, prompt: `Tell me about option ${i}` })) }) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } }, warnings: [],
  }));
  const model = new MockLanguageModelV3({ doGenerate: generate } as any);
  const agent = { name: "leo", model: "mock", assignedLoops: ["create-site"], allowedTools: ["build_site"],
    chat: { suggestions: { enabled: true, guidance: "Stay concise" } } };
  const deps: CompletionRouteDeps = {
    getAgents: async () => [agent], getConfig: () => ({}), getMemoryStore: () => null,
    getSessionStore: () => store, getStore: () => null, emit: () => {}, buildAgentPrompt: () => "",
    resolveAgentModel: vi.fn(async () => ({ model: { id: "mock", provider: "mock", aiModel: model, contextWindow: 10000, maxTokens: 1000 } })),
    resolveAgentTools: async () => ({ tools: [{ name: "build_site", description: "build", inputSchema: { type: "object", properties: {} } }], executor: async () => "Your site is ready" }),
    getProjectLoop: async () => ({ name: "create-site", start: "build", steps: {
      build: { type: "tool", tool: "build_site", saveAs: "site.text", next: "end" },
    }, result: { presentation: { text: { $context: "site.text" } } } }),
    onAuxiliaryModelFinished: vi.fn(),
  };
  const body = { stream: false, agent: "leo", loop: "create-site", messages: [{ role: "user" as const, content: "Create my site" }],
    polpo: { capabilities: { suggestions: { enabled: true, maxItems: 5, guidance: "Site just created", context: { published: false } } } } };
  return { deps, body, agent, store, messages, generate };
}

async function post(deps: CompletionRouteDeps, body: unknown) {
  return completionRoutes(() => deps).request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const applicationActions = [
  { kind: "action", id: "publish", label: "Publish", action: { type: "open_url", url: "https://app.example.test/private-action-target" } },
  { kind: "action", id: "billing", label: "View plan", action: { type: "postback", value: "private-action-value" } },
] as const;

describe("deterministic application actions after Loops", () => {
  it.each([false, true])("persists the exact ordered mixed list, stream=%s", async stream => {
    const { deps, body, messages, generate, store } = fixture();
    const response = await post(deps, { ...body, stream, polpo: {
      capabilities: { suggestions: { maxItems: 5, actions: applicationActions } },
    } });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const suggestions = stream
      ? raw.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
        .map(line => JSON.parse(line.slice(6))).find(chunk => chunk.polpo?.suggestions)?.polpo.suggestions
      : JSON.parse(raw).polpo?.suggestions;
    expect(suggestions).toHaveLength(5);
    expect(suggestions.slice(0, 2)).toEqual(applicationActions);
    expect(suggestions.slice(2).every((item: any) => item.kind === "message" && item.prompt)).toBe(true);
    expect(messages.at(-1).suggestions).toEqual(suggestions);
    const history = await chatRoutes(() => ({ sessionStore: store as any })).request("/sessions/session-1/messages");
    expect((await history.json() as any).data.messages.at(-1).suggestions).toEqual(suggestions);
    const modelInput = JSON.stringify(generate.mock.calls);
    expect(modelInput).not.toContain("private-action-target");
    expect(modelInput).not.toContain("private-action-value");
    if (stream) expect(raw.indexOf('"suggestions"')).toBeLessThan(raw.indexOf('"finish_reason":"stop"'));
  });

  it("can return only deterministic actions without resolving an auxiliary model", async () => {
    const { deps, body, generate, messages } = fixture();
    const result = await runConversationTurn(deps, { body: { ...body, polpo: {
      capabilities: { suggestions: { maxItems: 2, actions: [...applicationActions] } },
    } } });
    expect(result.suggestions).toEqual(applicationActions);
    expect(messages.at(-1).suggestions).toEqual(applicationActions);
    expect(deps.resolveAgentModel).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(["resolution", "inference", "timeout"])("retains actions when auxiliary %s fails", async failure => {
    const { deps, body, generate, messages } = fixture();
    if (failure === "resolution") deps.resolveAgentModel = vi.fn().mockRejectedValue(new Error("offline"));
    if (failure === "inference") generate.mockRejectedValue(new Error("offline"));
    if (failure === "timeout") deps.resolveAgentModel = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const pending = runConversationTurn(deps, { body: { ...body, polpo: {
        capabilities: { suggestions: { maxItems: 5, actions: [...applicationActions] } },
      } } });
      await vi.advanceTimersByTimeAsync(15_001);
      const result = await pending;
      expect(result.text).toBe("Your site is ready");
      expect(result.suggestions).toEqual(applicationActions);
      expect(messages.at(-1).suggestions).toEqual(applicationActions);
    } finally { vi.useRealTimers(); }
  });

  it.each(["client", "agent"])("honors the %s opt-out even with actions supplied", async policy => {
    const { deps, body, agent } = fixture();
    if (policy === "agent") agent.chat.suggestions.enabled = false;
    const result = await runConversationTurn(deps, { body: { ...body, polpo: {
      capabilities: { suggestions: { enabled: policy !== "client", actions: [...applicationActions] } },
    } } });
    expect(result.suggestions ?? []).toEqual([]);
  });

  it("omits all suggestions when the caller aborts during mixed-list inference", async () => {
    const { deps, body, generate, messages } = fixture();
    const controller = new AbortController();
    generate.mockImplementation(() => {
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    });
    const result = await runConversationTurn(deps, { signal: controller.signal, body: {
      ...body, polpo: { capabilities: { suggestions: { maxItems: 5, actions: [...applicationActions] } } },
    } });
    expect(generate).toHaveBeenCalledOnce();
    expect(result.suggestions ?? []).toEqual([]);
    expect(messages.at(-1).suggestions ?? []).toEqual([]);
    expect(result.text).toBe("Your site is ready");
  });
});

describe("Loop completion suggestions", () => {
  it.each([
    { agentReasoning: "off", projectReasoning: "high", expected: "off" },
    { agentReasoning: "low", projectReasoning: "medium", expected: "low" },
    { agentReasoning: undefined, projectReasoning: "low", expected: "low" },
  ])("uses the agent reasoning override before project defaults: $expected", async ({ agentReasoning, projectReasoning, expected }) => {
    const { deps, body, agent } = fixture();
    Object.assign(agent, { reasoning: agentReasoning });
    deps.getConfig = () => ({ settings: { reasoning: projectReasoning } } as any);
    const response = await post(deps, body);
    expect(response.status).toBe(200);
    expect((await response.json() as any).polpo.suggestions).toHaveLength(5);
    expect(deps.resolveAgentModel).toHaveBeenCalledWith(expect.objectContaining({ name: "leo" }), expected);
  });

  it.each([false, true])("returns and persists the same five suggestions, stream=%s", async (stream) => {
    const { deps, body, messages, generate, store } = fixture();
    const res = await post(deps, { ...body, stream });
    expect(res.status).toBe(200);
    let suggestions: unknown;
    if (stream) {
      const text = await res.text();
      const chunks = text.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6)));
      suggestions = chunks.find(chunk => chunk.polpo?.suggestions)?.polpo.suggestions;
      expect(text.indexOf('"suggestions"')).toBeGreaterThan(-1);
      expect(text.indexOf('"suggestions"')).toBeLessThan(text.indexOf('"finish_reason":"stop"'));
      expect(text.indexOf('"suggestions"')).toBeLessThan(text.indexOf("[DONE]"));
    } else {
      const json = await res.json() as any;
      expect(json.choices[0].message.content).toBe("Your site is ready");
      suggestions = json.polpo?.suggestions;
    }
    expect(suggestions).toHaveLength(5);
    expect(messages.at(-1)?.suggestions).toEqual(suggestions);
    const history = await chatRoutes(() => ({ sessionStore: store as any })).request("/sessions/session-1/messages");
    expect(history.status).toBe(200);
    expect((await history.json() as any).data.messages.at(-1).suggestions).toEqual(suggestions);
    const prompt = JSON.stringify(generate.mock.calls[0]);
    expect(prompt).toContain("Your restaurant is called Luna");
    expect(prompt).toContain("Site just created");
    expect(prompt).toContain("published");
    expect(deps.onAuxiliaryModelFinished).toHaveBeenCalledOnce();
  });

  it("supports the transport-independent runner and the boolean default of three", async () => {
    const { deps, body, messages } = fixture();
    const result = await runConversationTurn(deps, { body: { ...body, polpo: { capabilities: { suggestions: true } } } });
    expect(result.suggestions).toHaveLength(3);
    expect(messages.at(-1).suggestions).toEqual(result.suggestions);
  });

  it.each(["client", "agent", "channel"])("does not resolve an auxiliary model when disabled by %s", async (policy) => {
    const { deps, body, agent, generate } = fixture();
    if (policy === "agent") agent.chat.suggestions.enabled = false;
    const result = await runConversationTurn(deps, { body: { ...body,
      ...(policy === "client" ? { polpo: { capabilities: { suggestions: false } } } : {}),
    }, ...(policy === "channel" ? { runtime: { surface: "channel", source: "channel" } as const } : {}) });
    expect(result.suggestions ?? []).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(deps.resolveAgentModel).not.toHaveBeenCalled();
  });

  it("fails open when model resolution fails", async () => {
    const { deps, body, messages } = fixture();
    deps.resolveAgentModel = vi.fn().mockRejectedValue(new Error("offline"));
    const res = await post(deps, body);
    expect(res.status).toBe(200);
    expect((await res.json() as any).choices[0].message.content).toBe("Your site is ready");
    expect(messages.at(-1).content).toBe("Your site is ready");
  });

  it.each([{ maxItems: 6 }, { guidance: "x".repeat(501) }, { context: { large: "x".repeat(8193) } }])("rejects invalid request options", async (suggestions) => {
    const { deps, body, generate } = fixture();
    expect((await post(deps, { ...body, polpo: { capabilities: { suggestions } } })).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });
});


it.each([false, true])("journals suggestions once before DONE for durable replay (actions=%s)", async withActions => {
  const { deps, body, generate, messages } = fixture();
  const scope = { eventStore: new InMemoryRunEventStore(), leaseStore: new InMemoryRunExecutionLeaseStore(),
    cancellationStore: new InMemoryRunCancellationStore(), owner: "test", token: "attempt" };
  deps.createRunDeliveryScope = async () => scope;
  const response = await post(deps, { ...body, stream: true, polpo: {
    ...body.polpo, delivery: { onDisconnect: "continue" },
    ...(withActions ? { capabilities: { suggestions: { maxItems: 5, actions: [...applicationActions] } } } : {}),
  } });
  const text = await response.text();
  expect(text).toContain('"suggestions"');
  const runId = response.headers.get("x-polpo-run-id")!;
  const events = (await scope.eventStore.listAfter(runId)).events;
  const suggestionEvent = events.findIndex(event => String(event.data.data).includes('"suggestions"'));
  expect(suggestionEvent).toBeGreaterThan(-1);
  expect(suggestionEvent).toBeLessThan(events.findIndex(event => event.type === "response.done"));
  const frame = JSON.parse(String(events[suggestionEvent].data.data));
  expect(frame.polpo.suggestions).toEqual(messages.at(-1).suggestions);
  if (withActions) expect(frame.polpo.suggestions.slice(0, 2)).toEqual(applicationActions);
  const replay = await runDeliveryRoutes(() => ({ resolveRunDelivery: async () => scope })).request(`/${runId}/events`);
  expect(replay.status).toBe(200);
  const replayText = await replay.text();
  expect(replayText).toContain("suggestion_");
  expect(replayText).toContain("run.completed");
  if (withActions) {
    expect(replayText).toContain(applicationActions[0].action.url);
    expect(replayText).toContain(applicationActions[1].action.value);
  }
  expect(generate).toHaveBeenCalledOnce();
});

it("skips suggestions for a failed Loop", async () => {
  const { deps, body, generate } = fixture();
  deps.resolveAgentTools = async () => ({ tools: [], executor: async () => { throw new Error("build failed"); } });
  const response = await post(deps, body);
  expect(await response.text()).not.toContain('"suggestions"');
  expect(generate).not.toHaveBeenCalled();
});

it("bounds stalled model resolution and preserves the successful Loop", async () => {
  const { deps, body, messages, generate } = fixture();
  deps.resolveAgentModel = () => new Promise(() => {});
  vi.useFakeTimers();
  try {
    const result = runConversationTurn(deps, { body });
    const finished = vi.fn();
    void result.then(finished);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).text).toBe("Your site is ready");
    expect(messages.at(-1).content).toBe("Your site is ready");
    expect(generate).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("allows a slow auxiliary response and persists it on the successful Loop", async () => {
  const { deps, body, messages, generate } = fixture();
  const response = await generate();
  generate.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    return response;
  });
  generate.mockClear();
  vi.useFakeTimers();
  try {
    const pending = runConversationTurn(deps, { body });
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending;
    expect(result.text).toBe("Your site is ready");
    expect(result.suggestions).toHaveLength(5);
    expect(messages.at(-1).suggestions).toEqual(result.suggestions);
    expect(generate).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("shares one deadline across Loop preparation and generation", async () => {
  const { deps, body, messages, generate } = fixture();
  const resolve = deps.resolveAgentModel;
  deps.resolveAgentModel = async (...args) => {
    await new Promise(resolved => setTimeout(resolved, 10_000));
    return resolve(...args);
  };
  generate.mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    const pending = runConversationTurn(deps, { body });
    const finished = vi.fn();
    void pending.then(finished);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).text).toBe("Your site is ready");
    expect(messages.at(-1).content).toBe("Your site is ready");
    expect(messages.at(-1).suggestions ?? []).toEqual([]);
    expect(generate).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});


it("uses the guarded presentation and excludes conversation after this turn's placeholder", async () => {
  const { deps, body, store, messages, generate } = fixture();
  store.getMessages.mockImplementation(async () => [...messages, { id: "future", role: "user", content: "DO NOT LEAK LATER TURN" }]);
  deps.runOutputPolicy = { streamingMode: "buffer", evaluate: async () => ({ output: "Approved presentation" }) } as any;
  const response = await post(deps, body);
  expect(response.status).toBe(200);
  const prompt = JSON.stringify(generate.mock.calls[0]);
  expect(prompt).not.toContain("DO NOT LEAK LATER TURN");
  expect(prompt).toContain("Approved presentation");
});
