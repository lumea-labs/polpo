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
    // Same tool_call lifecycle (calling → completed/error), same order.
    expect(toolStates(viaRun)).toEqual(toolStates(inline));
    expect(toolStates(viaRun)).toContain("calling");
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
      "call_1:calling",
      "call_1:error",
      "call_2:calling",
      "call_2:error",
    ]);
    expect(lifecycle(viaRun)).toEqual(lifecycle(inline));
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
    const inline = await postStream({ messages });

    setChatExecution("run");
    setMockModel(model());
    const viaRun = await postStream({ messages });

    expect(toolStates(viaRun)).toEqual(toolStates(inline));
    expect(toolStates(viaRun)).not.toContain("calling");
    expect(finishReason(viaRun)).toBe("tool_calls");
  });
});
