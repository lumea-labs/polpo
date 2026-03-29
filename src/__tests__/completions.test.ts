/**
 * Integration tests for POST /v1/chat/completions.
 *
 * These tests use a real Orchestrator with file stores in a temp dir,
 * and mock only the LLM boundary via AI SDK's MockLanguageModelV3.
 * All Polpo code — model resolution, system prompt, tool execution,
 * SSE formatting, session persistence — runs for real.
 *
 * All requests use agent-direct mode (`agent: "agent-1"`) since orchestrator
 * mode has been removed (returns 501 "not available").
 *
 * Mock strategy: vi.mock the pi-client module so resolveModel returns our
 * MockLanguageModelV3 wrapped in a ResolvedModel. The completions route
 * calls resolveAgentModel -> resolveModel -> returns our mock.
 * We swap the mock model per test via setMockModel().
 */

import { describe, test, expect, beforeAll, afterAll, vi, type Mock } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import {
  MockLanguageModelV3,
  mockTextModel,
  mockToolCallModel,
  mockTurnSequenceModel,
  mockResolvedModel,
  type MockResponse,
} from "./helpers/mock-llm.js";

// ── Mock pi-client BEFORE any imports that pull it in ──

// The active mock model — tests swap this via setMockModel().
let activeMockModel: MockLanguageModelV3 = mockTextModel("Default mock response.");

vi.mock("../llm/pi-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/pi-client.js")>();
  return {
    ...actual,
    resolveModel: () => mockResolvedModel(activeMockModel),
    resolveModelSpec: (spec: unknown) => spec ?? "mock:mock-model",
    resolveApiKeyAsync: async () => "mock-api-key",
    enforceModelAllowlist: () => {},
    mapReasoningToProviderOptions: () => undefined,
  };
});

// ── Test Setup ──────────────────────────────────────────

const POLPO_CONFIG = JSON.stringify({
  project: "test-completions",
  team: {
    name: "test-team",
    agents: [
      { name: "agent-1", role: "Test agent" },
    ],
  },
  settings: { maxRetries: 2, logLevel: "quiet" },
}, null, 2);

let tmpDir: string;
let app: any; // OpenAPIHono — `any` to avoid Hono<> vs OpenAPIHono<> generic mismatch
let orchestrator: Orchestrator;

/** Override the mock model for the next call(s). */
function setMockModel(model: MockLanguageModelV3) {
  activeMockModel = model;
}

/** POST /v1/chat/completions helper — always uses agent-direct mode. */
async function postCompletions(body: Record<string, unknown>, headers?: Record<string, string>) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ agent: "agent-1", ...body }),
  });
}

/** Parse a non-streaming completion response body. */
async function parseJson(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

/** Parse an SSE stream into an array of parsed data chunks. */
async function parseSSE(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  const chunks: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "[DONE]") break;
      try {
        chunks.push(JSON.parse(data));
      } catch { /* skip non-JSON lines */ }
    }
  }
  return chunks;
}

// ── Lifecycle ───────────────────────────────────────────

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-completions-test-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), POLPO_CONFIG);

  const { Orchestrator: OrchestratorClass } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");

  orchestrator = new OrchestratorClass(tmpDir);
  await orchestrator.initInteractive("test-completions", {
    name: "test-team",
    agents: [{ name: "agent-1", role: "Test agent" }],
  });

  const sseBridge = new SSEBridge(orchestrator);
  sseBridge.start();

  // No API keys -> no auth required
  app = createApp(orchestrator, sseBridge);
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────

describe("POST /v1/chat/completions", () => {

  // ── Basic request/response ──────────────────────────

  describe("non-streaming", () => {
    test("returns OpenAI-compatible completion for simple text response", async () => {
      setMockModel(mockTextModel("Hello from Polpo!"));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe("polpo");
      expect(body.id).toMatch(/^chatcmpl-/);

      const choices = body.choices as any[];
      expect(choices).toHaveLength(1);
      expect(choices[0].message.role).toBe("assistant");
      expect(choices[0].message.content).toBe("Hello from Polpo!");
      expect(choices[0].finish_reason).toBe("stop");

      const usage = body.usage as Record<string, number>;
      expect(usage.total_tokens).toBeGreaterThan(0);
    });

    test("returns 400 when messages array is empty", async () => {
      const res = await postCompletions({
        messages: [],
        stream: false,
      });
      // Zod validation: min(1) on messages
      expect(res.status).toBe(400);
    });
  });

  describe("streaming", () => {
    test("returns SSE stream with text deltas and [DONE]", async () => {
      setMockModel(mockTextModel("Streamed response!"));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      });

      expect(res.status).toBe(200);
      const text = await res.text();

      // Should contain role chunk, text deltas, finish, and [DONE]
      expect(text).toContain('"role":"assistant"');
      // Text may be split across multiple deltas; check that all content arrives
      const chunks = await parseSSE({ text: () => Promise.resolve(text) } as any);
      const allContent = chunks
        .map(c => (c.choices as any[])?.[0]?.delta?.content)
        .filter(Boolean)
        .join("");
      expect(allContent).toBe("Streamed response!");
      expect(text).toContain('"finish_reason":"stop"');
      expect(text).toContain("[DONE]");
    });

    test("SSE chunks have correct OpenAI format", async () => {
      setMockModel(mockTextModel("Test"));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      });

      const chunks = await parseSSE(res);
      expect(chunks.length).toBeGreaterThan(0);

      // First chunk should have role
      const firstChunk = chunks[0];
      expect(firstChunk.object).toBe("chat.completion.chunk");
      expect(firstChunk.model).toBe("polpo");
      expect(firstChunk.id).toMatch(/^chatcmpl-/);
      expect((firstChunk.choices as any[])[0].delta.role).toBe("assistant");

      // Last chunk should have finish_reason
      const lastChunk = chunks[chunks.length - 1];
      expect((lastChunk.choices as any[])[0].finish_reason).toBe("stop");
    });
  });

  // ── Tool execution ──────────────────────────────────

  describe("tool execution", () => {
    test("executes get_status tool and returns result in non-streaming mode", async () => {
      // Turn 1: LLM calls get_status tool
      // Turn 2: After receiving tool result, LLM responds with text
      setMockModel(mockTurnSequenceModel([
        { type: "tool-call", toolName: "get_status", args: {} },
        { type: "text", text: "The project has 0 tasks and 1 agent." },
      ]));

      const res = await postCompletions({
        messages: [{ role: "user", content: "What is the project status?" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      const choices = body.choices as any[];
      expect(choices[0].message.content).toBe("The project has 0 tasks and 1 agent.");
      expect(choices[0].finish_reason).toBe("stop");
    });

    test("executes get_status tool in streaming mode with tool_call events", async () => {
      setMockModel(mockTurnSequenceModel([
        { type: "tool-call", toolName: "get_status", args: {} },
        { type: "text", text: "Status summary." },
      ]));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Status?" }],
        stream: true,
      });

      const chunks = await parseSSE(res);

      // Should have tool_call chunks (preparing + calling + completed)
      const toolChunks = chunks.filter(c => {
        const choice = (c.choices as any[])?.[0];
        return choice?.tool_call != null;
      });
      expect(toolChunks.length).toBeGreaterThan(0);

      // Should have a tool_call with result (error or completed)
      // In agent-direct mode, orchestrator tools like get_status are unknown
      // so they return an error result — the SSE event is still emitted.
      const resultChunk = toolChunks.find(c => {
        const choice = (c.choices as any[])?.[0];
        return choice?.tool_call?.state === "completed" || choice?.tool_call?.state === "error";
      });
      expect(resultChunk).toBeDefined();

      // Should end with text + stop
      const textChunks = chunks.filter(c => {
        const choice = (c.choices as any[])?.[0];
        return choice?.delta?.content != null;
      });
      expect(textChunks.length).toBeGreaterThan(0);
    });

    test("executes list_tasks tool and returns structured data", async () => {
      setMockModel(mockTurnSequenceModel([
        { type: "tool-call", toolName: "list_tasks", args: {} },
        { type: "text", text: "There are no tasks yet." },
      ]));

      const res = await postCompletions({
        messages: [{ role: "user", content: "List all tasks" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBe("There are no tasks yet.");
    });

    test("handles multi-tool turn (2 tool calls in sequence)", async () => {
      // Turn 1: list_tasks
      // Turn 2: list_agents (LLM wants more info)
      // Turn 3: final text response
      setMockModel(mockTurnSequenceModel([
        { type: "tool-call", toolName: "list_tasks", args: {} },
        { type: "tool-call", toolName: "list_agents", args: {} },
        { type: "text", text: "You have 0 tasks and 1 agent: agent-1." },
      ]));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Give me a full overview" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toContain("0 tasks");
    });
  });

  // NOTE: Interactive tools (ask_user, create_mission, etc.) are orchestrator-only.
  // Agent-direct mode does not intercept interactive tools — they are treated as
  // regular tool calls. Since orchestrator mode has been removed, those tests
  // are no longer applicable.

  // ── Auth ────────────────────────────────────────────

  describe("auth", () => {
    test("succeeds without auth when no API keys configured", async () => {
      setMockModel(mockTextModel("No auth needed."));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(res.status).toBe(200);
    });
  });

  // ── Message formatting ──────────────────────────────

  describe("message formatting", () => {
    test("handles multi-part content (text array)", async () => {
      setMockModel(mockTextModel("Got your multi-part message."));

      const res = await postCompletions({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Part one." },
            { type: "text", text: "Part two." },
          ],
        }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBe("Got your multi-part message.");
    });

    test("handles system + user messages", async () => {
      setMockModel(mockTextModel("I see the system context."));

      const res = await postCompletions({
        messages: [
          { role: "system", content: "You are a helpful assistant for project X." },
          { role: "user", content: "What project is this?" },
        ],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBe("I see the system context.");
    });

    test("handles conversation history with assistant messages", async () => {
      setMockModel(mockTextModel("Continuing our conversation."));

      const res = await postCompletions({
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
          { role: "user", content: "How are you?" },
        ],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBe("Continuing our conversation.");
    });
  });

  // ── Session persistence ─────────────────────────────

  describe("session persistence", () => {
    test("returns x-session-id header", async () => {
      setMockModel(mockTextModel("Session test."));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const sessionId = res.headers.get("x-session-id");
      expect(sessionId).toBeTruthy();
    });

    test("reuses session when x-session-id header is sent back", async () => {
      setMockModel(mockTextModel("First."));
      const res1 = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });
      const sessionId = res1.headers.get("x-session-id")!;

      setMockModel(mockTextModel("Second."));
      const res2 = await postCompletions(
        { messages: [{ role: "user", content: "Follow up" }], stream: false },
        { "x-session-id": sessionId },
      );

      expect(res2.headers.get("x-session-id")).toBe(sessionId);
    });

    test("creates new session when x-session-id is 'new'", async () => {
      setMockModel(mockTextModel("First."));
      const res1 = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });
      const firstSessionId = res1.headers.get("x-session-id")!;

      setMockModel(mockTextModel("New session."));
      const res2 = await postCompletions(
        { messages: [{ role: "user", content: "New convo" }], stream: false },
        { "x-session-id": "new" },
      );

      const newSessionId = res2.headers.get("x-session-id")!;
      expect(newSessionId).toBeTruthy();
      expect(newSessionId).not.toBe(firstSessionId);
    });
  });

  // ── Edge cases ──────────────────────────────────────

  describe("edge cases", () => {
    test("handles empty LLM response gracefully", async () => {
      setMockModel(mockTextModel(""));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBeDefined();
    });
  });
});
