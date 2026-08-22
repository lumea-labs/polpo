import { Output, type ModelMessage, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import type {
  ModelTurnEvent,
  ModelTurnResult,
  StreamModelTurnInput,
} from "./stream-turn.js";
import {
  ModelPolicyTurnError,
  type ModelPolicyAttempt,
  runModelPolicyTurn,
} from "./model-policy-turn.js";

const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

describe("runModelPolicyTurn", () => {
  it("preserves the parallel tool preference across fallback attempts", async () => {
    const preferences: Array<boolean | undefined> = [];

    await runModelPolicyTurn({
      selection: {
        primary: "anthropic/claude-sonnet-5",
        fallbacks: ["openai/gpt-4o"],
      },
      messages,
      parallelToolCalls: true,
      resolveAttempt: (attempt) => ({ model: fakeModel(attempt.model) }),
      classifyError: error => ({
        class: "overloaded",
        retryable: true,
        message: error instanceof Error ? error.message : "error",
      }),
      runAttempt: async (input) => {
        preferences.push(input.parallelToolCalls);
        if (preferences.length === 1) throw new Error("retry");
        return fakeResult("ok");
      },
    });

    expect(preferences).toEqual([true, true]);
  });

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

  it("retries a transient turn interrupted while streaming tool input", async () => {
    const attempted: ModelPolicyAttempt[] = [];
    const events: ModelTurnEvent[] = [];
    let calls = 0;

    const result = await runModelPolicyTurn({
      selection: "openai/gpt-4o",
      messages,
      resolveAttempt: (attempt) => {
        attempted.push(attempt);
        return { model: fakeModel(attempt.model) };
      },
      runAttempt: async (_input, onEvent) => {
        calls += 1;
        if (calls === 1) {
          await onEvent?.({ type: "tool-input-start", id: "call_edit", name: "edit" });
          await onEvent?.({ type: "tool-input-delta", id: "call_edit", delta: '{"path":"src/app.ts"' });
          throw { message: "upstream temporarily unavailable", statusCode: 503 };
        }
        await onEvent?.({ type: "text-delta", id: "txt", text: "recovered" });
        await onEvent?.({ type: "finish", finishReason: "stop" });
        return fakeResult("recovered");
      },
    }, event => {
      events.push(event);
    });

    expect(result.text).toBe("recovered");
    expect(attempted).toEqual([
      expect.objectContaining({ index: 0, retryIndex: 0 }),
      expect.objectContaining({ index: 0, retryIndex: 1 }),
    ]);
    expect(events).toEqual([
      { type: "tool-input-start", id: "call_edit", name: "edit" },
      { type: "tool-input-delta", id: "call_edit", delta: '{"path":"src/app.ts"' },
      expect.objectContaining({
        type: "tool-input-aborted",
        id: "call_edit",
        name: "edit",
        error: expect.objectContaining({ retryable: true }),
      }),
      { type: "text-delta", id: "txt", text: "recovered" },
      { type: "finish", finishReason: "stop" },
    ]);
    expect(events.find(event => event.type === "tool-input-aborted"))
      .not.toHaveProperty("error.raw");
  });

  it("terminalizes partial tool input and never stringifies plain errors as object Object", async () => {
    const events: ModelTurnEvent[] = [];

    await expect(runModelPolicyTurn({
      selection: "openai/gpt-4o",
      messages,
      preserveSingleAttemptError: true,
      resolveAttempt: (attempt) => ({ model: fakeModel(attempt.model) }),
      runAttempt: async (_input, onEvent) => {
        await onEvent?.({ type: "tool-input-start", id: "call_edit", name: "edit" });
        throw { error: "Invalid arguments passed to the model.", statusCode: 400 };
      },
    }, event => {
      events.push(event);
    })).rejects.toMatchObject({
      name: "ModelPolicyTurnError",
      message: "Invalid arguments passed to the model.",
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool-input-aborted",
      id: "call_edit",
      name: "edit",
      error: expect.objectContaining({
        class: "invalid-request",
        retryable: false,
      }),
    }));
  });

  it("does not replay after text was already delivered, even with partial tool input", async () => {
    const attempted: ModelPolicyAttempt[] = [];
    const events: ModelTurnEvent[] = [];

    await expect(runModelPolicyTurn({
      selection: "openai/gpt-4o",
      messages,
      resolveAttempt: (attempt) => {
        attempted.push(attempt);
        return { model: fakeModel(attempt.model) };
      },
      runAttempt: async (_input, onEvent) => {
        await onEvent?.({ type: "text-delta", id: "txt", text: "visible" });
        await onEvent?.({ type: "tool-input-start", id: "call_edit", name: "edit" });
        throw { message: "upstream temporarily unavailable", statusCode: 503 };
      },
    }, event => {
      events.push(event);
    })).rejects.toBeInstanceOf(ModelPolicyTurnError);

    expect(attempted).toHaveLength(1);
    expect(events.map(event => event.type)).toEqual([
      "text-delta",
      "tool-input-start",
      "tool-input-aborted",
    ]);
  });

  it("does not replay after a complete tool call is emitted", async () => {
    let attempts = 0;

    await expect(runModelPolicyTurn({
      selection: "openai/gpt-4o",
      messages,
      resolveAttempt: (attempt) => ({ model: fakeModel(attempt.model) }),
      runAttempt: async (_input, onEvent) => {
        attempts += 1;
        await onEvent?.({ type: "tool-input-start", id: "call_edit", name: "edit" });
        await onEvent?.({
          type: "tool-call",
          id: "call_edit",
          name: "edit",
          args: { path: "src/app.ts" },
        });
        throw { message: "upstream temporarily unavailable", statusCode: 503 };
      },
    })).rejects.toBeInstanceOf(ModelPolicyTurnError);

    expect(attempts).toBe(1);
  });

  it("treats non-finite retry settings as disabled instead of looping forever", async () => {
    let attempts = 0;

    await expect(runModelPolicyTurn({
      selection: "openai/gpt-4o",
      messages,
      maxRecoverableStreamRetries: Number.POSITIVE_INFINITY,
      resolveAttempt: (attempt) => ({ model: fakeModel(attempt.model) }),
      runAttempt: async (_input, onEvent) => {
        attempts += 1;
        await onEvent?.({ type: "tool-input-start", id: "call_edit", name: "edit" });
        throw { message: "upstream temporarily unavailable", statusCode: 503 };
      },
    })).rejects.toBeInstanceOf(ModelPolicyTurnError);

    expect(attempts).toBe(1);
  });

  it("terminalizes every parallel tool input before retrying", async () => {
    const events: ModelTurnEvent[] = [];
    let calls = 0;

    await runModelPolicyTurn({
      selection: "openai/gpt-4o",
      messages,
      resolveAttempt: (attempt) => ({ model: fakeModel(attempt.model) }),
      runAttempt: async (_input, onEvent) => {
        calls += 1;
        if (calls === 1) {
          await onEvent?.({ type: "tool-input-start", id: "call_a", name: "read" });
          await onEvent?.({ type: "tool-input-start", id: "call_b", name: "search" });
          throw { message: "gateway timeout", statusCode: 504 };
        }
        return fakeResult("ok");
      },
    }, event => {
      events.push(event);
    });

    expect(events.filter(event => event.type === "tool-input-aborted")).toEqual([
      expect.objectContaining({ id: "call_a", name: "read" }),
      expect.objectContaining({ id: "call_b", name: "search" }),
    ]);
  });

  it("falls back only after the recoverable retry of a partial tool input is exhausted", async () => {
    const attempted: ModelPolicyAttempt[] = [];

    const result = await runModelPolicyTurn({
      selection: {
        primary: "openai/gpt-4o",
        fallbacks: ["anthropic/claude-sonnet-5"],
      },
      messages,
      resolveAttempt: (attempt) => {
        attempted.push(attempt);
        return { model: fakeModel(attempt.model) };
      },
      runAttempt: async (attemptInput, onEvent) => {
        if ((attemptInput.model as { modelId?: string }).modelId === "openai/gpt-4o") {
          await onEvent?.({ type: "tool-input-start", id: `call_${attempted.length}`, name: "edit" });
          throw { message: "provider unavailable", statusCode: 503 };
        }
        return fakeResult("fallback");
      },
    });

    expect(result.text).toBe("fallback");
    expect(attempted).toEqual([
      expect.objectContaining({ model: "openai/gpt-4o", retryIndex: 0 }),
      expect.objectContaining({ model: "openai/gpt-4o", retryIndex: 1 }),
      expect.objectContaining({ model: "anthropic/claude-sonnet-5", retryIndex: 0 }),
    ]);
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
