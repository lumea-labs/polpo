import { describe, expect, it, vi } from "vitest";
import {
  GuardrailAbortedError,
  GuardrailApprovalRequiredError,
  GuardrailBlockedError,
  RuntimeGuardrailEngine,
  createConfiguredRunToolMiddleware,
  createRunToolMiddleware,
  type RuntimeGuardrailPolicy,
} from "../guardrails/index.js";

const ids = () => {
  let sequence = 0;
  return () => `decision-${++sequence}`;
};

describe("RuntimeGuardrailEngine", () => {
  it("evaluates policies in deterministic priority and declaration order", async () => {
    const calls: string[] = [];
    const policy = (id: string, priority: number): RuntimeGuardrailPolicy => ({
      id,
      priority,
      phases: ["input"],
      evaluate: () => {
        calls.push(id);
        return { action: "audit", risk: "low", reason: id };
      },
    });
    const engine = new RuntimeGuardrailEngine(
      [policy("late", 200), policy("first", 100), policy("second", 100)],
      { createId: ids() },
    );

    const result = await engine.evaluate({
      phase: "input",
      value: "hello",
      context: {},
    });

    expect(calls).toEqual(["first", "second", "late"]);
    expect(result.decisions.map((decision) => decision.policyId)).toEqual([
      "first",
      "second",
      "late",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(result.decisions.every(Object.isFrozen)).toBe(true);
  });

  it("passes rewritten values to later policies without mutating the caller value", async () => {
    const original = { token: "secret", nested: { count: 1 } };
    const observed: unknown[] = [];
    const engine = new RuntimeGuardrailEngine(
      [
        {
          id: "redact",
          phases: ["input"],
          evaluate: (input) => ({
            action: "redact",
            risk: "high",
            reason: "secret",
            value: { ...(input.value as Record<string, unknown>), token: "[REDACTED]" },
          }),
        },
        {
          id: "observe",
          phases: ["input"],
          evaluate: (input) => {
            observed.push(input.value);
            return null;
          },
        },
      ],
      { createId: ids() },
    );

    const result = await engine.evaluate({
      phase: "input",
      value: original,
      context: {},
    });

    expect(result.value).toEqual({ token: "[REDACTED]", nested: { count: 1 } });
    expect(observed).toEqual([{ token: "[REDACTED]", nested: { count: 1 } }]);
    expect(original).toEqual({ token: "secret", nested: { count: 1 } });
  });

  it("fails closed when a policy fails on a side-effecting tool", async () => {
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "broken",
        phases: ["tool.before"],
        evaluate: () => {
          throw new Error("classifier unavailable");
        },
      }],
      { createId: ids() },
    );

    const result = await engine.evaluate({
      phase: "tool.before",
      value: {},
      tool: { name: "send_email", sideEffect: "write" },
      context: {},
    });

    expect(result.terminalAction).toBe("block");
    expect(result.decisions).toEqual([
      expect.objectContaining({
        policyId: "broken",
        action: "block",
        risk: "high",
        fallbackUsed: true,
      }),
    ]);
  });

  it("audits and continues when a policy fails on a read-only tool", async () => {
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "broken",
        phases: ["tool.before"],
        evaluate: () => {
          throw new Error("classifier unavailable");
        },
      }],
      { createId: ids() },
    );

    const result = await engine.evaluate({
      phase: "tool.before",
      value: {},
      tool: { name: "read_file", sideEffect: "read" },
      context: {},
    });

    expect(result.terminalAction).toBeUndefined();
    expect(result.decisions[0]).toEqual(expect.objectContaining({
      action: "audit",
      risk: "medium",
      fallbackUsed: true,
    }));
  });

  it("stops evaluating after a terminal block", async () => {
    const later = vi.fn();
    const engine = new RuntimeGuardrailEngine(
      [
        {
          id: "block",
          phases: ["output"],
          evaluate: () => ({
            action: "block",
            risk: "critical",
            reason: "unsafe",
          }),
        },
        {
          id: "later",
          phases: ["output"],
          evaluate: later,
        },
      ],
      { createId: ids() },
    );

    const result = await engine.evaluate({
      phase: "output",
      value: "unsafe",
      context: {},
    });

    expect(result.terminalAction).toBe("block");
    expect(later).not.toHaveBeenCalled();
  });

  it("emits a secret-free audit event without the evaluated value or schema", async () => {
    const audit: unknown[] = [];
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "audit",
        phases: ["tool.before"],
        evaluate: () => ({
          action: "audit",
          risk: "high",
          reason: "secret-shaped input",
        }),
      }],
      {
        createId: ids(),
        onDecision: (event) => {
          audit.push(event);
        },
      },
    );

    await engine.evaluate({
      phase: "tool.before",
      value: { token: "must-not-leak" },
      tool: {
        name: "send",
        sideEffect: "write",
        schema: { type: "object", secretDescription: "must-not-leak" },
      },
      context: { planId: "plan-1" },
    });

    expect(audit).toEqual([{
      decision: expect.objectContaining({ policyId: "audit" }),
      context: { planId: "plan-1" },
      tool: {
        name: "send",
        callId: undefined,
        sideEffect: "write",
      },
    }]);
    expect(JSON.stringify(audit)).not.toContain("must-not-leak");
  });

  it("does not evaluate a late policy result after cancellation", async () => {
    const controller = new AbortController();
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "slow",
        phases: ["input"],
        evaluate: async () => {
          controller.abort();
          await Promise.resolve();
          return { action: "allow", risk: "none", reason: "late" };
        },
      }],
      { createId: ids() },
    );

    await expect(engine.evaluate({
      phase: "input",
      value: "hello",
      context: {},
      signal: controller.signal,
    })).rejects.toBeInstanceOf(GuardrailAbortedError);
  });

  it("keeps enforcement independent from a failing audit sink", async () => {
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "deny",
        phases: ["tool.before"],
        evaluate: () => ({
          action: "block",
          risk: "critical",
          reason: "denied",
        }),
      }],
      {
        createId: ids(),
        onDecision: () => {
          throw new Error("audit storage unavailable");
        },
      },
    );

    const result = await engine.evaluate({
      phase: "tool.before",
      value: {},
      context: {},
      tool: { name: "write", sideEffect: "write" },
    });

    expect(result.terminalAction).toBe("block");
    expect(result.decisions).toHaveLength(1);
  });

  it("does not copy a thrown policy error into decisions or audit events", async () => {
    const audit: unknown[] = [];
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "broken",
        phases: ["tool.before"],
        evaluate: () => {
          throw new Error("credential sk-this-must-not-leak");
        },
      }],
      {
        createId: ids(),
        onDecision: (event) => {
          audit.push(event);
        },
      },
    );

    const result = await engine.evaluate({
      phase: "tool.before",
      value: {},
      context: {},
      tool: { name: "write", sideEffect: "write" },
    });

    expect(result.decisions[0]?.reason).toBe("Policy evaluation failed");
    expect(JSON.stringify(audit)).not.toContain("sk-this-must-not-leak");
  });
});

describe("RunToolMiddleware", () => {
  it("stays disabled by reference when no serialized policy pack is configured", () => {
    expect(createConfiguredRunToolMiddleware(undefined)).toBeUndefined();
  });

  it("constructs the explicit default policy pack from serializable settings", async () => {
    const middleware = createConfiguredRunToolMiddleware({
      toolPolicyPack: "default",
    });
    const next = vi.fn(async () => "must not execute");

    await expect(middleware!.execute(
      {
        name: "http_request",
        args: { url: "http://169.254.169.254/latest/meta-data" },
        context: {},
      },
      next,
    )).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes redacted arguments to the tool and redacts output before returning it", async () => {
    const received: unknown[] = [];
    const engine = new RuntimeGuardrailEngine(
      [
        {
          id: "before-redaction",
          phases: ["tool.before"],
          evaluate: () => ({
            action: "redact",
            risk: "high",
            reason: "credential",
            value: { token: "[REDACTED]" },
          }),
        },
        {
          id: "after-redaction",
          phases: ["tool.after"],
          evaluate: (input) => ({
            action: "redact",
            risk: "high",
            reason: "credential",
            value: String(input.value).replace("secret", "[REDACTED]"),
          }),
        },
      ],
      { createId: ids() },
    );
    const middleware = createRunToolMiddleware(engine);

    const result = await middleware.execute(
      {
        callId: "call-1",
        name: "echo",
        args: { token: "secret" },
        sideEffect: "read",
        context: {},
      },
      async (request) => {
        received.push(request.args);
        return "the secret escaped";
      },
    );

    expect(received).toEqual([{ token: "[REDACTED]" }]);
    expect(result.output).toBe("the [REDACTED] escaped");
    expect(result.decisions).toHaveLength(2);
  });

  it("never executes a blocked tool", async () => {
    const next = vi.fn(async () => "should not run");
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "deny",
        phases: ["tool.before"],
        evaluate: () => ({
          action: "block",
          risk: "critical",
          reason: "denied",
        }),
      }],
      { createId: ids() },
    );

    await expect(createRunToolMiddleware(engine).execute(
      { name: "bash", args: {}, sideEffect: "write", context: {} },
      next,
    )).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("requires an explicit approval handler and executes once after approval", async () => {
    const next = vi.fn(async () => "ok");
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "approve",
        phases: ["tool.before"],
        evaluate: () => ({
          action: "approval",
          risk: "high",
          reason: "side effect",
        }),
      }],
      { createId: ids() },
    );

    await expect(createRunToolMiddleware(engine).execute(
      { name: "deploy", args: {}, sideEffect: "write", context: {} },
      next,
    )).rejects.toBeInstanceOf(GuardrailApprovalRequiredError);
    expect(next).not.toHaveBeenCalled();

    const approval = vi.fn(async () => "approved" as const);
    const result = await createRunToolMiddleware(engine, { approval }).execute(
      { name: "deploy", args: {}, sideEffect: "write", context: {} },
      next,
    );
    expect(result.output).toBe("ok");
    expect(approval).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not execute when approval is denied", async () => {
    const next = vi.fn(async () => "should not run");
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "approve",
        phases: ["tool.before"],
        evaluate: () => ({
          action: "approval",
          risk: "high",
          reason: "side effect",
        }),
      }],
      { createId: ids() },
    );

    await expect(createRunToolMiddleware(engine, {
      approval: async () => "denied" as const,
    }).execute(
      { name: "deploy", args: {}, sideEffect: "write", context: {} },
      next,
    )).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("bounds and normalizes tool output before after policies and the model see it", async () => {
    let observed = "";
    const engine = new RuntimeGuardrailEngine(
      [{
        id: "observe",
        phases: ["tool.after"],
        evaluate: (input) => {
          observed = String(input.value);
          return null;
        },
      }],
      { createId: ids() },
    );

    const result = await createRunToolMiddleware(engine, {
      maxOutputCharacters: 8,
    }).execute(
      { name: "read", args: {}, sideEffect: "read", context: {} },
      async () => "a\r\nbcdefghijkl",
    );

    expect(observed).toBe("a\nbcdefg\n[TRUNCATED]");
    expect(result.output).toBe(observed);
    expect(result.outputTruncated).toBe(true);
  });

  it("does not execute when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const next = vi.fn(async () => "should not run");
    const engine = new RuntimeGuardrailEngine([], { createId: ids() });

    await expect(createRunToolMiddleware(engine).execute(
      {
        name: "read",
        args: {},
        sideEffect: "read",
        context: {},
        signal: controller.signal,
      },
      next,
    )).rejects.toBeInstanceOf(GuardrailAbortedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("marks a side-effecting outcome uncertain when cancellation happens after dispatch", async () => {
    const controller = new AbortController();
    const next = vi.fn(async () => {
      controller.abort();
      return "possibly committed";
    });
    const engine = new RuntimeGuardrailEngine([], { createId: ids() });

    await expect(createRunToolMiddleware(engine).execute(
      {
        name: "send_email",
        args: {},
        sideEffect: "write",
        context: {},
        signal: controller.signal,
      },
      next,
    )).rejects.toMatchObject({
      code: "guardrail_aborted",
      outcomeUncertain: true,
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it("never retries a tool when an after-policy blocks its output", async () => {
    const next = vi.fn(async () => "sensitive output");
    const engine = new RuntimeGuardrailEngine([{
      id: "deny-output",
      phases: ["tool.after"],
      evaluate: () => ({
        action: "block",
        risk: "high",
        reason: "unsafe output",
      }),
    }]);

    await expect(createRunToolMiddleware(engine).execute(
      {
        name: "write",
        args: {},
        sideEffect: "write",
        context: {},
      },
      next,
    )).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(next).toHaveBeenCalledOnce();
  });
});
