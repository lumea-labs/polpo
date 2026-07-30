import { describe, expect, it, vi } from "vitest";
import {
  RuntimeGuardrailEngine,
  createRunToolMiddleware,
  type RuntimeGuardrailEvaluationInput,
} from "@polpo-ai/core";
import { createGuardedCompletionToolExecutor } from "./tool-guardrails.js";

describe("createGuardedCompletionToolExecutor", () => {
  it("preserves the legacy executor reference when middleware is disabled", () => {
    const executor = vi.fn(async () => "ok");
    expect(createGuardedCompletionToolExecutor({
      executor,
      tools: [],
      context: {},
    })).toBe(executor);
  });

  it("provides the actual schema, call id, signal, and runtime context to policies", async () => {
    const observed: RuntimeGuardrailEvaluationInput[] = [];
    const engine = new RuntimeGuardrailEngine([{
      id: "observe",
      phases: ["tool.before", "tool.after"],
      evaluate: (input) => {
        observed.push(input);
        return null;
      },
    }]);
    const executor = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      JSON.stringify(args)
    );
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{
        name: "search",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }],
      middleware: createRunToolMiddleware(engine),
      context: {
        planId: "plan-1",
        agent: "researcher",
        sessionId: "session-1",
      },
    });
    const controller = new AbortController();

    await expect(guarded("search", { query: "polpo" }, {
      callId: "call-1",
      signal: controller.signal,
    })).resolves.toBe('{"query":"polpo"}');

    expect(executor).toHaveBeenCalledWith(
      "search",
      { query: "polpo" },
      { callId: "call-1", signal: controller.signal },
    );
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual(expect.objectContaining({
      phase: "tool.before",
      context: expect.objectContaining({
        planId: "plan-1",
        agent: "researcher",
        sessionId: "session-1",
      }),
      tool: expect.objectContaining({
        name: "search",
        callId: "call-1",
        sideEffect: "read",
        schema: expect.objectContaining({ type: "object" }),
      }),
      signal: controller.signal,
    }));
  });

  it("uses the runtime executor only once with guardrail-rewritten arguments", async () => {
    const engine = new RuntimeGuardrailEngine([{
      id: "rewrite",
      phases: ["tool.before"],
      evaluate: () => ({
        action: "rewrite",
        risk: "low",
        reason: "canonical query",
        value: { query: "canonical" },
      }),
    }]);
    const executor = vi.fn(async () => "ok");
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [],
      middleware: createRunToolMiddleware(engine),
      context: {},
    });

    await guarded("search", { query: "raw" });

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(
      "search",
      { query: "canonical" },
      { callId: undefined, signal: undefined },
    );
  });
});
