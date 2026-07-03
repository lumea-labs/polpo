/**
 * Mock LLM helpers for deterministic integration tests.
 *
 * Uses AI SDK test utilities: MockLanguageModelV3, simulateReadableStream, mockValues.
 * Provides factory functions that create MockLanguageModelV3 instances configured
 * to return specific responses (text, tool calls, multi-turn sequences).
 *
 * The mock model is injected through the `resolveAgentModel` dep in the completions
 * route — no vi.mock of the LLM module is needed for completions tests.
 */

import {
  MockLanguageModelV3,
  simulateReadableStream,
  mockValues,
} from "ai/test";
import { convertArrayToReadableStream } from "ai/test";
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  LanguageModelV3FinishReason,
} from "@ai-sdk/provider";
import type { ResolvedModel } from "../../llm/pi-client.js";

// Re-export AI SDK test utilities for convenience
export { MockLanguageModelV3, simulateReadableStream, mockValues };

// ── Usage helper ──────────────────────────────────────

function mockUsage(overrides: Partial<LanguageModelV3Usage> = {}): LanguageModelV3Usage {
  return {
    inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: undefined, reasoning: undefined },
    ...overrides,
  };
}

const stopFinishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };
const toolCallsFinishReason: LanguageModelV3FinishReason = { unified: "tool-calls", raw: undefined };

// ── doGenerate result factories ───────────────────────

/** Create a doGenerate result for a text-only response. */
export function mockTextGenerateResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: stopFinishReason,
    usage: mockUsage(),
    warnings: [],
  };
}

/** Create a doGenerate result for a tool call response. */
export function mockToolCallGenerateResult(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): LanguageModelV3GenerateResult {
  return {
    content: [{
      type: "tool-call",
      toolCallId: toolCallId ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      toolName,
      input: JSON.stringify(args),
    }],
    finishReason: toolCallsFinishReason,
    usage: mockUsage(),
    warnings: [],
  };
}

// ── doStream result factories ─────────────────────────

/**
 * Build stream parts for a text-only response.
 * Mirrors what a real provider emits: stream-start -> text-start -> text-delta(s) -> text-end -> finish.
 */
function textStreamParts(text: string): LanguageModelV3StreamPart[] {
  const textId = `text-${Date.now()}`;
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: textId },
  ];

  // Split text into chunks (simulate streaming)
  const chunkSize = Math.max(1, Math.ceil(text.length / 3));
  for (let i = 0; i < text.length; i += chunkSize) {
    parts.push({
      type: "text-delta",
      id: textId,
      delta: text.slice(i, i + chunkSize),
    });
  }

  parts.push(
    { type: "text-end", id: textId },
    { type: "finish", finishReason: stopFinishReason, usage: mockUsage() },
  );

  return parts;
}

/**
 * Build stream parts for a tool call response.
 * Emits: stream-start -> tool-input-start -> tool-input-delta -> tool-input-end -> tool-call -> finish.
 */
function toolCallStreamParts(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): LanguageModelV3StreamPart[] {
  const id = toolCallId ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const argsJson = JSON.stringify(args);

  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: argsJson },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName, input: argsJson },
    { type: "finish", finishReason: toolCallsFinishReason, usage: mockUsage() },
  ];
}

/** Create a doStream result from an array of stream parts. */
function streamResult(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
  return {
    stream: convertArrayToReadableStream(parts),
  };
}

// ── MockLanguageModelV3 factories ─────────────────────

/** Create a MockLanguageModelV3 that returns a text response (both generate and stream). */
export function mockTextModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: mockTextGenerateResult(text),
    doStream: streamResult(textStreamParts(text)),
  });
}

/** Create a MockLanguageModelV3 that returns a tool call response (both generate and stream). */
export function mockToolCallModel(
  toolName: string,
  args: Record<string, unknown>,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: mockToolCallGenerateResult(toolName, args),
    doStream: streamResult(toolCallStreamParts(toolName, args)),
  });
}

/**
 * Create a MockLanguageModelV3 that plays a sequence of responses (multi-turn).
 *
 * Each doGenerate/doStream call returns the next response in the sequence.
 * After the sequence is exhausted, returns the last response repeatedly.
 *
 * Responses are specified as simple descriptors:
 *   { type: "text", text: "Hello" }
 *   { type: "tool-call", toolName: "get_status", args: {} }
 */
export type MockResponse =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string; args: Record<string, unknown> };

export function mockTurnSequenceModel(responses: MockResponse[]): MockLanguageModelV3 {
  let generateIndex = 0;
  let streamIndex = 0;

  return new MockLanguageModelV3({
    doGenerate: async () => {
      const idx = Math.min(generateIndex++, responses.length - 1);
      const r = responses[idx];
      if (r.type === "text") return mockTextGenerateResult(r.text);
      return mockToolCallGenerateResult(r.toolName, r.args);
    },
    doStream: async () => {
      const idx = Math.min(streamIndex++, responses.length - 1);
      const r = responses[idx];
      if (r.type === "text") return streamResult(textStreamParts(r.text));
      return streamResult(toolCallStreamParts(r.toolName, r.args));
    },
  });
}

// ── ResolvedModel factory ─────────────────────────────

/** Create a minimal mock ResolvedModel that wraps a MockLanguageModelV3. */
export function mockResolvedModel(aiModel?: MockLanguageModelV3): ResolvedModel {
  const model = aiModel ?? mockTextModel("Default mock response.");
  return {
    id: "mock-model",
    name: "Mock Model",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    aiModel: model,
  };
}

// ── Legacy API compatibility ──────────────────────────
// Keep the same exported function names used by the old tests where possible,
// but return AI SDK types instead of pi-ai types.

/** Create a text response — returns a MockLanguageModelV3. */
export function mockTextResponse(text: string): MockLanguageModelV3 {
  return mockTextModel(text);
}

/** Create a tool call response — returns a MockLanguageModelV3. */
export function mockToolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
): MockLanguageModelV3 {
  return mockToolCallModel(toolName, args);
}

/** Create a text response as a ResolvedModel (for tests that need the full shape). */
export function mockTextResponseAsResolved(text: string): ResolvedModel {
  return mockResolvedModel(mockTextModel(text));
}

/**
 * Create a model that plays a sequence of turns.
 * Each doGenerate/doStream call returns the next response.
 */
export function mockTurnSequence(responses: MockResponse[]): MockLanguageModelV3 {
  return mockTurnSequenceModel(responses);
}
