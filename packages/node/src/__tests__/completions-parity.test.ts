/**
 * F1c parity: chat completions must produce the SAME OpenAI SSE whether they
 * run through the inline chat-handler (`chatExecution:"inline"`) or through the
 * shared executeRun lifecycle + loop-engine (`chatExecution:"run"`).
 *
 * Drives identical requests under both modes against a mock model and asserts
 * the streamed content and tool_call event sequence match. Same harness as
 * completions.test.ts (real Orchestrator + file stores + createApp).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { mockResolvedModel, mockTurnSequenceModel } from "./helpers/mock-llm.js";
import { Orchestrator } from "../core/orchestrator.js";

let activeMockModel: MockLanguageModelV3;
vi.mock("@polpo-ai/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polpo-ai/llm")>();
  return {
    ...actual,
    resolveModel: () => mockResolvedModel(activeMockModel),
    resolveModelSpec: (spec: unknown) => spec ?? "mock:mock-model",
    resolveApiKeyAsync: async () => "mock-api-key",
    enforceModelAllowlist: () => {},
    mapReasoningToProviderOptions: () => undefined,
  };
});

const POLPO_CONFIG = JSON.stringify({
  project: "test-parity",
  team: { name: "test-team", agents: [{ name: "agent-1", role: "Test agent" }] },
  settings: { logLevel: "quiet" },
}, null, 2);

let tmpDir: string;
let app: any;
let orchestrator: Orchestrator;
let sseBridge: { dispose(): void };

function setMockModel(m: MockLanguageModelV3) { activeMockModel = m; }
function setChatExecution(mode: "inline" | "run") {
  const cfg = orchestrator.getConfig() as any;
  cfg.settings = cfg.settings ?? {};
  cfg.settings.chatExecution = mode;
}

async function postStream(body: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "agent-1", stream: true, ...body }),
  });
  const text = await res.text();
  const chunks: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") break;
    try { chunks.push(JSON.parse(data)); } catch { /* skip */ }
  }
  return chunks;
}

async function postNonStream(body: Record<string, unknown>) {
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "agent-1", stream: false, ...body }),
  });
  return {
    status: response.status,
    body: await response.json() as any,
  };
}

/** Concatenate delta.content across chunks. */
function content(chunks: Record<string, unknown>[]): string {
  return chunks.map((ch) => ((ch.choices as any)?.[0]?.delta?.content ?? "")).join("");
}
/** Extract the tool_call event states (calling/completed/error) in order. */
function toolStates(chunks: Record<string, unknown>[]): string[] {
  return chunks
    .map((ch) => (ch.choices as any)?.[0]?.tool_call?.state)
    .filter((s): s is string => typeof s === "string");
}
function toolEvents(chunks: Record<string, unknown>[]): any[] {
  return chunks
    .map((ch) => (ch.choices as any)?.[0]?.tool_call)
    .filter(Boolean);
}
/** The finish_reason of the terminal chunk, if any. */
function finishReason(chunks: Record<string, unknown>[]): string | undefined {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const fr = (chunks[i].choices as any)?.[0]?.finish_reason;
    if (fr) return fr;
  }
  return undefined;
}

const profileResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "profile",
    strict: true,
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        tier: { type: "string", enum: ["free", "paid"] },
      },
      required: ["name", "tier"],
      additionalProperties: false,
    },
  },
} as const;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-parity-test-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), POLPO_CONFIG);

  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");

  orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("test-parity", {
    name: "test-team",
    agents: [{ name: "agent-1", role: "Test agent" }],
  });
  sseBridge = new SSEBridge(orchestrator);
  sseBridge.start();
  app = createApp(orchestrator, sseBridge);
});

afterAll(async () => {
  sseBridge?.dispose();
  await orchestrator?.gracefulStop();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("F1c parity: inline vs run", () => {
  it("pure text: streamed content + finish_reason are identical", async () => {
    const messages = [{ role: "user", content: "Say hello" }];

    setChatExecution("inline");
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "hello from the agent" }]));
    const inline = await postStream({ messages });

    setChatExecution("run");
    setMockModel(mockTurnSequenceModel([{ type: "text", text: "hello from the agent" }]));
    const viaRun = await postStream({ messages });

    expect(content(viaRun)).toBe("hello from the agent");
    expect(content(viaRun)).toBe(content(inline));
    expect(finishReason(viaRun)).toBe("stop");
    expect(finishReason(viaRun)).toBe(finishReason(inline));
  });

  it("single tool call: content + tool_call event states are identical", async () => {
    const messages = [{ role: "user", content: "Use a tool" }];
    const seq = () => mockTurnSequenceModel([
      { type: "tool-call", toolName: "definitely_not_a_real_tool", args: { x: 1 } },
      { type: "text", text: "done after the tool" },
    ]);

    setChatExecution("inline");
    setMockModel(seq());
    const inline = await postStream({ messages });

    setChatExecution("run");
    setMockModel(seq());
    const viaRun = await postStream({ messages });

    // Same final text.
    expect(content(viaRun)).toBe("done after the tool");
    expect(content(viaRun)).toBe(content(inline));
    // Unknown/invalid tool calls are rejected before local dispatch.
    expect(toolStates(viaRun)).toEqual(toolStates(inline));
    expect(toolStates(viaRun)).not.toContain("calling");
    expect(toolStates(viaRun)).toContain("error");
    expect(finishReason(viaRun)).toBe(finishReason(inline));
  });

  it("multiple local tool calls preserve inline calling/result order", async () => {
    const messages = [{ role: "user", content: "Use two tools" }];
    const seq = () => mockTurnSequenceModel([
      {
        type: "tool-calls",
        calls: [
          { toolCallId: "call_1", toolName: "missing_one", args: { value: 1 } },
          { toolCallId: "call_2", toolName: "missing_two", args: { value: 2 } },
        ],
      },
      { type: "text", text: "finished" },
    ]);

    setChatExecution("inline");
    setMockModel(seq());
    const inline = await postStream({ messages });

    setChatExecution("run");
    setMockModel(seq());
    const viaRun = await postStream({ messages });

    const lifecycle = (chunks: Record<string, unknown>[]) => toolEvents(chunks)
      .filter((event) => event.state !== "preparing")
      .map((event) => `${event.id}:${event.state}`);
    expect(lifecycle(viaRun)).toEqual([
      "call_1:error",
      "call_2:error",
    ]);
    expect(lifecycle(viaRun)).toEqual(lifecycle(inline));
  });

  it("duplicate invalid call ids cannot fall through to chat execution", async () => {
    const messages = [{ role: "user", content: "Use invalid tools" }];
    const seq = () => mockTurnSequenceModel([
      {
        type: "tool-calls",
        calls: [
          {
            toolCallId: "duplicate",
            toolName: "missing_one",
            args: { value: 1 },
          },
          {
            toolCallId: "duplicate",
            toolName: "missing_two",
            args: { value: 2 },
          },
        ],
      },
      { type: "text", text: "recovered" },
    ]);

    setChatExecution("inline");
    setMockModel(seq());
    const inline = await postStream({ messages });

    setChatExecution("run");
    setMockModel(seq());
    const viaRun = await postStream({ messages });

    const terminalStates = (chunks: Record<string, unknown>[]) =>
      toolEvents(chunks)
        .filter((event) => event.state !== "preparing")
        .map((event) => event.state);
    expect(terminalStates(viaRun)).toEqual(["error", "error"]);
    expect(terminalStates(viaRun)).toEqual(terminalStates(inline));
    expect(content(viaRun)).toBe("recovered");
  });

  it("client-side tools interrupt without a fake server-side calling event", async () => {
    const messages = [{ role: "user", content: "Ask me" }];
    const model = () => mockTurnSequenceModel([{
      type: "tool-call",
      toolName: "ask_user_question",
      args: { questions: [{ question: "Continue?", options: ["Yes", "No"] }] },
    }]);

    setChatExecution("inline");
    setMockModel(model());
    const inline = await postStream({ messages, response_format: profileResponseFormat });

    setChatExecution("run");
    setMockModel(model());
    const viaRun = await postStream({ messages, response_format: profileResponseFormat });

    expect(toolStates(viaRun)).toEqual(toolStates(inline));
    expect(toolStates(viaRun)).not.toContain("calling");
    expect(finishReason(viaRun)).toBe("tool_calls");
  });

  it("returns structured output in OpenAI message.content for non-streaming calls", async () => {
    const request = {
      messages: [{ role: "user", content: "Return a profile" }],
      response_format: profileResponseFormat,
    };
    const response = '{ "name": "Ada", "tier": "paid" }';

    setChatExecution("inline");
    setMockModel(mockTurnSequenceModel([{ type: "text", text: response }]));
    const inline = await postNonStream(request);

    setChatExecution("run");
    setMockModel(mockTurnSequenceModel([{ type: "text", text: response }]));
    const viaRun = await postNonStream(request);

    expect(inline.status).toBe(200);
    expect(viaRun.status).toBe(200);
    expect(inline.body.choices[0].message.content).toBe('{"name":"Ada","tier":"paid"}');
    expect(viaRun.body.choices[0].message.content).toBe(
      inline.body.choices[0].message.content,
    );
  });

  it("buffers and canonicalizes json_schema output identically", async () => {
    const messages = [{ role: "user", content: "Return a profile" }];
    const response = '{\n  "name": "Ada",\n  "tier": "paid"\n}';

    setChatExecution("inline");
    setMockModel(mockTurnSequenceModel([{ type: "text", text: response }]));
    const inline = await postStream({ messages, response_format: profileResponseFormat });

    setChatExecution("run");
    setMockModel(mockTurnSequenceModel([{ type: "text", text: response }]));
    const viaRun = await postStream({ messages, response_format: profileResponseFormat });

    expect(content(inline)).toBe('{"name":"Ada","tier":"paid"}');
    expect(content(viaRun)).toBe(content(inline));
    expect(inline.filter((chunk) => (chunk.choices as any)?.[0]?.delta?.content)).toHaveLength(1);
    expect(viaRun.filter((chunk) => (chunk.choices as any)?.[0]?.delta?.content)).toHaveLength(1);
    expect(finishReason(viaRun)).toBe("stop");
  });

  it("does not validate an intermediate tool-call turn as structured output", async () => {
    const messages = [{ role: "user", content: "Use a tool, then return a profile" }];
    const sequence = () => mockTurnSequenceModel([
      { type: "tool-call", toolName: "definitely_not_a_real_tool", args: { value: 1 } },
      { type: "text", text: '{"name":"Ada","tier":"free"}' },
    ]);

    setChatExecution("inline");
    setMockModel(sequence());
    const inline = await postStream({ messages, response_format: profileResponseFormat });

    setChatExecution("run");
    setMockModel(sequence());
    const viaRun = await postStream({ messages, response_format: profileResponseFormat });

    expect(content(inline)).toBe('{"name":"Ada","tier":"free"}');
    expect(content(viaRun)).toBe(content(inline));
    expect(toolStates(viaRun)).toEqual(toolStates(inline));
    expect(toolStates(viaRun)).toContain("error");
  });

  it("returns an OpenAI error envelope when structured output violates the schema", async () => {
    const messages = [{ role: "user", content: "Return a profile" }];
    const invalid = '{"name":"Ada","tier":"enterprise"}';

    setChatExecution("inline");
    setMockModel(mockTurnSequenceModel([{ type: "text", text: invalid }]));
    const inline = await postStream({ messages, response_format: profileResponseFormat });

    setChatExecution("run");
    setMockModel(mockTurnSequenceModel([{ type: "text", text: invalid }]));
    const viaRun = await postStream({ messages, response_format: profileResponseFormat });

    const errorOf = (chunks: Record<string, unknown>[]) => chunks
      .map((chunk) => (chunk.choices as any)?.[0]?.error)
      .find(Boolean);
    const inlineError = errorOf(inline);
    const runError = errorOf(viaRun);
    expect(inlineError).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_response_format_output",
      param: "response_format",
    });
    expect(runError).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_response_format_output",
      param: "response_format",
    });
    expect(content(inline)).toBe("");
    expect(content(viaRun)).toBe("");
  });
});
