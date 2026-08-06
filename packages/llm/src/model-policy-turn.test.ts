import { Output, type ModelMessage, type ToolSet } from "ai";
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
  it("preserves structured output across provider fallback attempts", async () => {
    const outputs: unknown[] = [];
    const output = Output.json();

    await runModelPolicyTurn({
      selection: {
        primary: "anthropic/claude-sonnet-5",
        fallbacks: ["openai/gpt-4o"],
      },
      messages,
      output,
      resolveAttempt: (attempt) => ({ model: fakeModel(attempt.model) }),
      classifyError: error => ({
        class: "overloaded",
        retryable: true,
        message: error instanceof Error ? error.message : "error",
      }),
      runAttempt: async (input) => {
        outputs.push(input.output);
        if (outputs.length === 1) throw new Error("retry");
        return fakeResult("ok");
      },
    });

    expect(outputs).toEqual([output, output]);
  });

  it("preserves active tool selection across provider fallback attempts", async () => {
    const activeToolsByAttempt: Array<readonly string[] | undefined> = [];
    const tools = {
      tool_search: {} as any,
      hidden_tool: {} as any,
    };

    await runModelPolicyTurn({
      selection: {
        primary: "anthropic/claude-sonnet-5",
        fallbacks: ["openai/gpt-4o"],
      },
      messages,
      tools,
      activeTools: ["tool_search"],
      resolveAttempt: (attempt) => ({ model: fakeModel(attempt.model) }),
      classifyError: error => ({
        class: "overloaded",
        retryable: true,
        message: error instanceof Error ? error.message : "error",
      }),
      runAttempt: async (input) => {
        activeToolsByAttempt.push(input.activeTools as readonly string[] | undefined);
        if (activeToolsByAttempt.length === 1) throw new Error("retry");
        return fakeResult<typeof tools>("ok");
      },
    });

    expect(activeToolsByAttempt).toEqual([["tool_search"], ["tool_search"]]);
  });

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
    const events: ModelTurnEvent[] = [];

    await expect(runModelPolicyTurn({
      selection: "openai/gpt-4o",
      messages,
      resolveAttempt: (attempt) => ({ model: fakeModel(attempt.model) }),
      preserveSingleAttemptError: true,
      runAttempt: async (_input, onEvent) => {
        await onEvent?.({ type: "error", error: originalError });
        throw originalError;
      },
    }, event => {
      events.push(event);
    })).rejects.toBe(originalError);

    expect(events).toEqual([{ type: "error", error: originalError }]);
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

function fakeResult<TOOLS extends ToolSet = ToolSet>(text: string): ModelTurnResult<TOOLS> {
  return {
    text,
    toolCalls: [],
    toolResults: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
    responseMessages: [],
  } as unknown as ModelTurnResult<TOOLS>;
}
