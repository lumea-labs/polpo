import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import type {
  ModelTurnEvent,
  ModelTurnResult,
  StreamModelTurnInput,
} from "./stream-turn.js";
import {
  ModelPolicyTurnError,
  runModelPolicyTurn,
} from "./model-policy-turn.js";

const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

describe("runModelPolicyTurn", () => {
  it("runs a primary-only policy without touching fallback semantics", async () => {
    const attempted: string[] = [];
    const events: ModelTurnEvent[] = [];

    const result = await runModelPolicyTurn({
      selection: "openai/gpt-4o",
      messages,
      resolveAttempt: (attempt) => {
        attempted.push(attempt.model);
        return { model: fakeModel(attempt.model) };
      },
      runAttempt: async (_input, onEvent) => {
        await onEvent?.({ type: "text-delta", id: "txt", text: "ok" });
        await onEvent?.({ type: "finish", finishReason: "stop" });
        return fakeResult("ok");
      },
    }, event => {
      events.push(event);
    });

    expect(attempted).toEqual(["openai/gpt-4o"]);
    expect(result.selectedAttempt).toMatchObject({ index: 0, model: "openai/gpt-4o" });
    expect(result.failedAttempts).toEqual([]);
    expect(events.map(event => event.type)).toEqual(["text-delta", "finish"]);
  });

  it("tries the next candidate after a retryable pre-commit failure", async () => {
    const attempted: string[] = [];
    const events: ModelTurnEvent[] = [];
    const policyEvents: string[] = [];

    const result = await runModelPolicyTurn({
      selection: {
        primary: "anthropic/claude-sonnet-5",
        fallbacks: ["openai/gpt-4o"],
      },
      messages,
      resolveAttempt: (attempt) => {
        attempted.push(attempt.model);
        return { model: fakeModel(attempt.model) };
      },
      classifyError: error => ({
        class: "overloaded",
        retryable: true,
        message: error instanceof Error ? error.message : "error",
      }),
      onPolicyEvent: event => {
        policyEvents.push(event.type);
      },
      runAttempt: async (input, onEvent) => {
        if ((input.model as { modelId?: string }).modelId === "anthropic/claude-sonnet-5") {
          throw new Error("503 overloaded");
        }
        await onEvent?.({ type: "text-delta", id: "txt", text: "fallback" });
        await onEvent?.({ type: "finish", finishReason: "stop" });
        return fakeResult("fallback");
      },
    }, event => {
      events.push(event);
    });

    expect(attempted).toEqual(["anthropic/claude-sonnet-5", "openai/gpt-4o"]);
    expect(result.selectedAttempt).toMatchObject({ index: 1, model: "openai/gpt-4o", isFallback: true });
    expect(result.failedAttempts).toHaveLength(1);
    expect(result.failedAttempts[0]).toMatchObject({ committed: false });
    expect(events.map(event => event.type)).toEqual(["text-delta", "finish"]);
    expect(policyEvents).toEqual([
      "model-attempt-started",
      "model-attempt-failed",
      "model-fallback-selected",
      "model-attempt-started",
      "model-attempt-succeeded",
    ]);
  });

  it("does not fallback after a committed event", async () => {
    const attempted: string[] = [];
    const events: ModelTurnEvent[] = [];

    await expect(runModelPolicyTurn({
      selection: {
        primary: "anthropic/claude-sonnet-5",
        fallbacks: ["openai/gpt-4o"],
      },
      messages,
      resolveAttempt: (attempt) => {
        attempted.push(attempt.model);
        return { model: fakeModel(attempt.model) };
      },
      classifyError: error => ({
        class: "overloaded",
        retryable: true,
        message: error instanceof Error ? error.message : "error",
      }),
      runAttempt: async (_input, onEvent) => {
        await onEvent?.({ type: "text-delta", id: "txt", text: "partial" });
        throw new Error("503 after output");
      },
    }, event => {
      events.push(event);
    })).rejects.toMatchObject({
      name: "ModelPolicyTurnError",
      failures: [{ committed: true }],
    });

    expect(attempted).toEqual(["anthropic/claude-sonnet-5"]);
    expect(events.map(event => event.type)).toEqual(["text-delta"]);
  });

  it("does not fallback for non-retryable pre-commit failures", async () => {
    const attempted: string[] = [];

    await expect(runModelPolicyTurn({
      selection: {
        primary: "anthropic/claude-sonnet-5",
        fallbacks: ["openai/gpt-4o"],
      },
      messages,
      resolveAttempt: (attempt) => {
        attempted.push(attempt.model);
        return { model: fakeModel(attempt.model) };
      },
      classifyError: error => ({
        class: "invalid-request",
        retryable: false,
        message: error instanceof Error ? error.message : "error",
      }),
      runAttempt: async () => {
        throw new Error("messages: text content blocks must be non-empty");
      },
    })).rejects.toBeInstanceOf(ModelPolicyTurnError);

    expect(attempted).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("can preserve the original error for single-attempt compatibility", async () => {
    const originalError = new Error("provider exploded");

    await expect(runModelPolicyTurn({
      selection: "openai/gpt-4o",
      messages,
      resolveAttempt: (attempt) => ({ model: fakeModel(attempt.model) }),
      preserveSingleAttemptError: true,
      runAttempt: async () => {
        throw originalError;
      },
    })).rejects.toBe(originalError);
  });

  it("normalizes candidate order before running attempts", async () => {
    const attempted: string[] = [];

    await runModelPolicyTurn({
      selection: {
        primary: "anthropic/claude-sonnet-5",
        fallbacks: [
          "openai/gpt-4o",
          "anthropic/claude-sonnet-5",
          " openai/gpt-4o ",
        ],
      },
      messages,
      resolveAttempt: (attempt) => {
        attempted.push(attempt.model);
        return { model: fakeModel(attempt.model) };
      },
      runAttempt: async () => fakeResult("ok"),
    });

    expect(attempted).toEqual(["anthropic/claude-sonnet-5"]);
  });
});

function fakeModel(modelId: string): StreamModelTurnInput["model"] {
  return { modelId } as StreamModelTurnInput["model"];
}

function fakeResult(text: string): ModelTurnResult {
  return {
    text,
    toolCalls: [],
    toolResults: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
    responseMessages: [],
  } as unknown as ModelTurnResult;
}
