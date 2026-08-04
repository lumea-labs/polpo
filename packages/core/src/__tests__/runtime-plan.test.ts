import { describe, expect, it } from "vitest";
import {
  createRuntimePlan,
  createRuntimePlanResolvedEvent,
  normalizeRuntimePlan,
  type RuntimePlanGuardrailDecision,
} from "../runtime-plan/index.js";

const fixedFactory = {
  createId: () => "plan-fixed",
  now: () => new Date("2026-07-28T10:00:00.000Z"),
};

describe("createRuntimePlan", () => {
  it("resolves deterministic safe defaults", () => {
    const plan = createRuntimePlan(
      {
        surface: "agent",
        source: "request",
        model: {
          selection: "  openai/gpt-5  ",
          source: "agent",
        },
      },
      fixedFactory,
    );

    expect(plan).toEqual({
      id: "plan-fixed",
      surface: "agent",
      source: "request",
      execution: {
        mode: "direct",
        source: "default",
      },
      model: {
        selection: "openai/gpt-5",
        source: "agent",
      },
      sandbox: {
        isolation: "reuse",
        source: "default",
        lifecycle: {
          onRelease: "pool",
          source: "default",
        },
      },
      tools: {
        exposure: "direct",
        allowed: [],
      },
      guardrails: [],
      context: {},
      audit: {
        resolvedAt: "2026-07-28T10:00:00.000Z",
        planner: "runtime-default",
        reasons: [],
        warnings: [],
        policyIds: [],
        fallbackUsed: false,
      },
    });
  });

  it("normalizes explicit decisions without sharing mutable input", () => {
    const guardrail: RuntimePlanGuardrailDecision = {
      id: "decision-1",
      policyId: "secrets",
      policyVersion: "1",
      phase: "input",
      action: "audit",
      risk: "low",
      reason: "Potential secret shape",
      latencyMs: 2,
      fallbackUsed: false,
    };
    const input = {
      surface: "channel" as const,
      source: "channel" as const,
      execution: {
        mode: "loop" as const,
        loop: "  support  ",
        source: "request" as const,
      },
      model: {
        selection: {
          primary: " openai/gpt-5 ",
          fallbacks: ["anthropic/claude", "anthropic/claude", " google/gemini "],
        },
        profile: " balanced ",
        source: "router" as const,
      },
      sandbox: {
        isolation: "fresh" as const,
        source: "request" as const,
        lifecycle: {
          onRelease: "pool" as const,
          idleTtlMinutes: 20,
          source: "agent" as const,
        },
      },
      tools: {
        exposure: "router" as const,
        allowed: ["bash", " read ", "", "bash"],
      },
      guardrails: [guardrail],
      context: {
        policy: "bounded",
        maxTokens: 8_000,
        sources: ["history", "memory"],
      },
      audit: {
        planner: "host-planner",
        reasons: ["explicit request"],
        warnings: ["classifier skipped"],
        policyIds: ["policy-1", "policy-1"],
        confidence: 0.98,
        latencyMs: {
          modelRouter: 12,
          executionRouter: 0,
        },
        fallbackUsed: true,
      },
    };

    const plan = createRuntimePlan(input, fixedFactory);

    expect(plan.execution).toEqual({
      mode: "loop",
      loop: "support",
      source: "request",
    });
    expect(plan.model).toEqual({
      selection: {
        primary: "openai/gpt-5",
        fallbacks: ["anthropic/claude", "google/gemini"],
      },
      profile: "balanced",
      source: "router",
    });
    expect(plan.sandbox).toEqual({
      isolation: "fresh",
      source: "request",
      lifecycle: {
        onRelease: "pool",
        idleTtlMinutes: 20,
        source: "agent",
      },
    });
    expect(plan.tools.allowed).toEqual(["bash", "read"]);
    expect(plan.guardrails).toEqual([guardrail]);
    expect(plan.context).toEqual(input.context);
    expect(plan.audit).toMatchObject({
      planner: "host-planner",
      reasons: ["explicit request"],
      warnings: ["classifier skipped"],
      policyIds: ["policy-1"],
      confidence: 0.98,
      latencyMs: {
        modelRouter: 12,
        executionRouter: 0,
      },
      fallbackUsed: true,
    });

    input.tools.allowed.push("write");
    input.context.sources.push("brain");
    input.audit.latencyMs.modelRouter = 999;
    expect(plan.tools.allowed).toEqual(["bash", "read"]);
    expect(plan.context.sources).toEqual(["history", "memory"]);
    expect(plan.audit.latencyMs?.modelRouter).toBe(12);
  });

  it("freezes the complete plan and its event envelope", () => {
    const plan = createRuntimePlan(
      {
        surface: "task",
        source: "task",
        model: { selection: "openai/gpt-5", source: "default" },
        tools: { allowed: ["bash"] },
        context: { sources: ["task"] },
      },
      fixedFactory,
    );
    const event = createRuntimePlanResolvedEvent(plan);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.model)).toBe(true);
    expect(Object.isFrozen(plan.tools.allowed)).toBe(true);
    expect(Object.isFrozen(plan.context.sources)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(event).toEqual({
      type: "runtime.plan.resolved",
      plan,
    });
  });

  it("drops unknown sensitive input instead of retaining it in the audit contract", () => {
    const plan = createRuntimePlan(
      {
        surface: "webhook",
        source: "request",
        model: { selection: "openai/gpt-5", source: "request" },
        prompt: "private system prompt",
        messages: [{ role: "user", content: "private message" }],
        credentials: { apiKey: "sk-secret" },
        headers: { authorization: "Bearer secret" },
      } as any,
      fixedFactory,
    );

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("private system prompt");
    expect(serialized).not.toContain("private message");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("Bearer secret");
  });

  it("normalizes untrusted host output and strips unknown fields", () => {
    const original = createRuntimePlan(
      {
        surface: "channel",
        source: "channel",
        model: { selection: "openai/gpt-5", source: "agent" },
      },
      fixedFactory,
    );
    const normalized = normalizeRuntimePlan({
      ...original,
      credentials: { apiKey: "secret" },
      prompt: "private prompt",
      audit: {
        ...original.audit,
        rawClassifierOutput: "private classifier response",
      },
    });

    expect(normalized).toEqual(original);
    expect(normalized).not.toBe(original);
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private classifier response");
  });

  it("rejects malformed plans returned by an untyped host", () => {
    expect(() => normalizeRuntimePlan({ id: "plan-1" })).toThrow(
      "Runtime plan execution must be an object",
    );
    expect(() => normalizeRuntimePlan({
      id: "plan-1",
      surface: "agent",
      source: "request",
      execution: { mode: "direct", source: "default" },
      model: { selection: "openai/gpt-5", source: "default" },
      sandbox: { isolation: "reuse", source: "default" },
      tools: { exposure: "direct", allowed: [] },
      guardrails: [],
      context: {},
      audit: {
        resolvedAt: "not-a-date",
        planner: "host",
        reasons: [],
        warnings: [],
        policyIds: [],
        fallbackUsed: false,
      },
    })).toThrow("valid date");
  });

  it("normalizes legacy plans without lifecycle to the pooled default", () => {
    const plan = createRuntimePlan({
      surface: "agent",
      source: "request",
      model: { selection: "openai/gpt-5", source: "default" },
    }, fixedFactory);
    const legacyPlan = {
      ...plan,
      sandbox: { isolation: "reuse", source: "default" },
    };

    expect(normalizeRuntimePlan(legacyPlan).sandbox).toEqual({
      isolation: "reuse",
      source: "default",
      lifecycle: { onRelease: "pool", source: "default" },
    });
  });

  it("rejects contradictory sandbox lifecycle decisions", () => {
    expect(() => createRuntimePlan({
      surface: "agent",
      source: "request",
      model: { selection: "openai/gpt-5", source: "default" },
      sandbox: {
        lifecycle: {
          onRelease: "destroy",
          idleTtlMinutes: 5,
          source: "request",
        },
      },
    }, fixedFactory)).toThrow(/idle TTL cannot be used with destroy/i);
  });

  it("records explicit shared isolation in the runtime plan", () => {
    const plan = createRuntimePlan({
      surface: "agent",
      source: "request",
      model: { selection: "openai/gpt-5", source: "default" },
      sandbox: {
        isolation: "shared",
        source: "request",
        lifecycle: { onRelease: "pool", source: "agent" },
      },
    }, fixedFactory);

    expect(plan.sandbox).toEqual({
      isolation: "shared",
      source: "request",
      lifecycle: { onRelease: "pool", source: "agent" },
    });
  });

  it.each([
    {
      name: "unknown surface",
      input: {
        surface: "chat",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
      },
      error: "Runtime plan surface",
    },
    {
      name: "loop execution without a loop",
      input: {
        surface: "agent",
        source: "request",
        execution: { mode: "loop", source: "request" },
        model: { selection: "openai/gpt-5", source: "default" },
      },
      error: "loop name",
    },
    {
      name: "direct execution carrying a loop",
      input: {
        surface: "agent",
        source: "request",
        execution: { mode: "direct", loop: "unexpected", source: "request" },
        model: { selection: "openai/gpt-5", source: "default" },
      },
      error: "Direct runtime plans",
    },
    {
      name: "invalid confidence",
      input: {
        surface: "agent",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
        audit: { confidence: 2 },
      },
      error: "confidence",
    },
    {
      name: "negative router latency",
      input: {
        surface: "agent",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
        audit: { latencyMs: { modelRouter: -1 } },
      },
      error: "audit latencyMs",
    },
    {
      name: "non-serializable context",
      input: {
        surface: "agent",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
        context: { transform: () => "unsafe" },
      },
      error: "JSON-serializable",
    },
    {
      name: "invalid model fallback",
      input: {
        surface: "agent",
        source: "request",
        model: {
          selection: { primary: "openai/gpt-5", fallbacks: [42] },
          source: "default",
        },
      },
      error: "model strings",
    },
    {
      name: "non-string tool grant",
      input: {
        surface: "agent",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
        tools: { allowed: ["bash", 42] },
      },
      error: "only strings",
    },
    {
      name: "negative guardrail latency",
      input: {
        surface: "agent",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
        guardrails: [{
          id: "decision-1",
          policyId: "policy-1",
          phase: "input",
          action: "audit",
          risk: "low",
          reason: "test",
          latencyMs: -1,
        }],
      },
      error: "non-negative finite number",
    },
  ])("rejects $name", ({ input, error }) => {
    expect(() => createRuntimePlan(input as any, fixedFactory)).toThrow(error);
  });

  it("rejects cyclic and prototype-polluting context", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const polluted = JSON.parse('{"__proto__":{"admin":true}}');

    expect(() => createRuntimePlan(
      {
        surface: "agent",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
        context: cyclic as any,
      },
      fixedFactory,
    )).toThrow("cyclic value");
    expect(() => createRuntimePlan(
      {
        surface: "agent",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
        context: polluted,
      },
      fixedFactory,
    )).toThrow("__proto__ is not allowed");
  });

  it("rejects invalid factory output before emitting a plan", () => {
    expect(() => createRuntimePlan(
      {
        surface: "agent",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
      },
      {
        createId: () => " ",
        now: () => new Date("invalid"),
      },
    )).toThrow("Runtime plan id");
    expect(() => createRuntimePlan(
      {
        surface: "agent",
        source: "request",
        model: { selection: "openai/gpt-5", source: "default" },
      },
      {
        createId: () => "plan-valid",
        now: () => new Date("invalid"),
      },
    )).toThrow("valid date");
  });
});
