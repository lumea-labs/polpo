import { describe, expect, it, vi } from "vitest";
import {
  InMemoryToolExecutionReceiptStore,
  RuntimeGuardrailEngine,
  createRunToolMiddleware,
  type RuntimeGuardrailEvaluationInput,
  type ToolExecutionReceiptStore,
} from "@polpo-ai/core";
import { createGuardedCompletionToolExecutor } from "./tool-guardrails.js";

describe("createGuardedCompletionToolExecutor", () => {
  it("validates against the canonical schema even when middleware is disabled", async () => {
    const executor = vi.fn(async () => "ok");
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{
        name: "calculate",
        parameters: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["sum"] },
            input: {
              type: "object",
              properties: { value: { type: "integer", minimum: 1 } },
              required: ["value"],
              additionalProperties: false,
            },
          },
          required: ["operation", "input"],
          additionalProperties: false,
        },
      }],
      context: {},
    });

    await expect(guarded("calculate", {
      operation: "multiply",
      input: { value: "1", ignored: true },
    })).resolves.toMatch(/^Error: Invalid tool arguments:/);

    expect(executor).not.toHaveBeenCalled();
  });

  it("fails closed for an unknown tool before the executor boundary", async () => {
    const executor = vi.fn(async () => "must not execute");
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [],
      context: {},
    });

    await expect(guarded("hallucinated", {})).resolves.toBe(
      'Error: Tool "hallucinated" is not available for execution.',
    );
    expect(executor).not.toHaveBeenCalled();
  });

  it("treats a missing schema as a closed no-argument contract", async () => {
    const executor = vi.fn(async () => "ok");
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{ name: "ping" }],
      context: {},
    });

    await expect(guarded("ping", {})).resolves.toBe("ok");
    await expect(guarded("ping", { injected: true })).resolves.toMatch(
      /^Error: Invalid tool arguments:/,
    );
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("reuses only explicitly stable reads and stops their fourth identical observation", async () => {
    const executor = vi.fn(async () => "stable result");
    const progress: string[] = [];
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{
        name: "lookup",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          resultStability: "stable",
        },
      }],
      context: {},
      onProgress: ({ decision }) => progress.push(decision.action),
    });

    await expect(guarded("lookup", { id: "same" })).resolves.toBe("stable result");
    await expect(guarded("lookup", { id: "same" })).resolves.toBe("stable result");
    await expect(guarded("lookup", { id: "same" })).resolves.toBe("stable result");
    await expect(guarded("lookup", { id: "same" })).resolves.toBe(
      'Error: Tool "lookup" repeated the same stable read 4 times without progress',
    );

    expect(executor).toHaveBeenCalledTimes(1);
    expect(progress).toEqual(["execute", "reuse", "reuse", "stall"]);
  });

  it("never deduplicates unannotated or side-effecting tools", async () => {
    const executor = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      JSON.stringify(args));
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{
        name: "write",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          resultStability: "stable",
        },
      }],
      context: {},
    });

    for (let observation = 0; observation < 5; observation += 1) {
      await expect(guarded("write", { value: "same" })).resolves.toBe(
        '{"value":"same"}',
      );
    }
    expect(executor).toHaveBeenCalledTimes(5);
  });

  it("replays a completed call receipt without repeating a side effect", async () => {
    const executor = vi.fn(async () => "created");
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{
        name: "create_record",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      }],
      context: {},
    });

    await expect(guarded("create_record", { value: "one" }, { callId: "call-1" }))
      .resolves.toBe("created");
    await expect(guarded("create_record", { value: "one" }, { callId: "call-1" }))
      .resolves.toBe("created");
    await expect(guarded("create_record", { value: "changed" }, { callId: "call-1" }))
      .resolves.toMatch(/^Error \[resume_contract_mismatch\]:/);

    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("replays across executor reconstruction and rejects a changed schema on resume", async () => {
    const receiptStore = new InMemoryToolExecutionReceiptStore();
    const executor = vi.fn(async () => "created");
    const tool = {
      name: "create_record",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    };
    const first = createGuardedCompletionToolExecutor({
      executor, tools: [tool], context: {}, receiptStore,
    });
    const resumed = createGuardedCompletionToolExecutor({
      executor, tools: [structuredClone(tool)], context: {}, receiptStore,
    });

    await expect(first("create_record", { value: "one" }, { callId: "call-1" }))
      .resolves.toBe("created");
    await expect(resumed("create_record", { value: "one" }, { callId: "call-1" }))
      .resolves.toBe("created");

    const changed = createGuardedCompletionToolExecutor({
      executor,
      tools: [{
        ...tool,
        parameters: {
          ...tool.parameters,
          properties: { value: { type: "string", minLength: 1 } },
        },
      }],
      context: {},
      receiptStore,
    });
    await expect(changed("create_record", { value: "one" }, { callId: "call-1" }))
      .resolves.toMatch(/^Error \[resume_contract_mismatch\]:/);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("blocks a concurrent duplicate while the first outcome is unresolved", async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const executor = vi.fn(async () => await pending);
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{ name: "charge", parameters: { type: "object" } }],
      context: {},
    });

    const first = guarded("charge", {}, { callId: "call-charge" });
    await expect(guarded("charge", {}, { callId: "call-charge" }))
      .resolves.toMatch(/^Error \[tool_outcome_unknown\]:/);
    release("charged");
    await expect(first).resolves.toBe("charged");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("returns a successful tool result after retrying only its receipt settlement", async () => {
    const durableStore = new InMemoryToolExecutionReceiptStore();
    const settle = vi.fn()
      .mockRejectedValueOnce(new Error("temporary receipt write failure"))
      .mockImplementation(durableStore.settle.bind(durableStore));
    const receiptStore: ToolExecutionReceiptStore = {
      claim: durableStore.claim.bind(durableStore),
      settle,
    };
    const executor = vi.fn(async () => "created");
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{ name: "create_record", parameters: { type: "object" } }],
      context: {},
      receiptStore,
    });

    await expect(guarded("create_record", {}, { callId: "call-1" }))
      .resolves.toBe("created");
    expect(executor).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls[0]?.[0]).toEqual(settle.mock.calls[1]?.[0]);
  });

  it("keeps the original executor failure when outcome-unknown settlement exhausts retries", async () => {
    const original = new Error("provider may have accepted the write");
    const durableStore = new InMemoryToolExecutionReceiptStore();
    const settle = vi.fn(async () => { throw new Error("receipt database unavailable"); });
    const executor = vi.fn(async () => { throw original; });
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{ name: "charge", parameters: { type: "object" } }],
      context: {},
      receiptStore: {
        claim: durableStore.claim.bind(durableStore),
        settle,
      },
    });

    await expect(guarded("charge", {}, { callId: "call-charge" })).rejects.toBe(original);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(3);
    expect(settle).toHaveBeenCalledWith({
      callId: "call-charge",
      state: "outcome-unknown",
    });
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
      tools: [{
        name: "search",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      }],
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

  it("revalidates guardrail rewrites before the runtime executor", async () => {
    const engine = new RuntimeGuardrailEngine([{
      id: "unsafe-rewrite",
      phases: ["tool.before"],
      evaluate: () => ({
        action: "rewrite",
        risk: "low",
        reason: "broken policy fixture",
        value: { limit: "many" },
      }),
    }]);
    const executor = vi.fn(async () => "must not execute");
    const guarded = createGuardedCompletionToolExecutor({
      executor,
      tools: [{
        name: "search",
        parameters: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1 } },
          required: ["limit"],
          additionalProperties: false,
        },
      }],
      middleware: createRunToolMiddleware(engine),
      context: {},
    });

    await expect(guarded("search", { limit: 1 })).resolves.toMatch(
      /^Error: Invalid tool arguments:/,
    );
    expect(executor).not.toHaveBeenCalled();
  });
});
