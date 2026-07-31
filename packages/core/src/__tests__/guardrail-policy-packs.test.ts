import { describe, expect, it, vi } from "vitest";
import {
  GuardrailBlockedError,
  createConfiguredRunOutputPolicy,
  createConfiguredRunPreflightPolicy,
  createConfiguredRunToolMiddleware,
  normalizeRuntimeGuardrailSettings,
  resolveRuntimeGuardrailRequestPolicy,
  type RuntimeGuardrailPolicy,
} from "../guardrails/index.js";

describe("guardrail policy packs", () => {
  it("keeps the legacy default tool/output settings backward compatible", () => {
    expect(normalizeRuntimeGuardrailSettings({
      toolPolicyPack: "default",
      outputPolicyPack: "default",
    })).toEqual({
      toolPolicyPack: "default",
      outputPolicyPack: "default",
      streamingOutputMode: "audit",
    });
  });

  it("normalizes the explicit standard pack and keeps guardrails opt-in", () => {
    expect(normalizeRuntimeGuardrailSettings(undefined)).toBeUndefined();
    expect(normalizeRuntimeGuardrailSettings({})).toBeUndefined();
    expect(normalizeRuntimeGuardrailSettings({
      policyPack: "standard",
    })).toEqual({
      policyPack: "standard",
      streamingOutputMode: "audit",
    });
  });

  it("upgrades a standard project policy to a bounded strict request policy", () => {
    expect(resolveRuntimeGuardrailRequestPolicy(
      {
        policyPack: "standard",
        maxInputCharacters: 2_000_000,
        maxContextCharacters: 500_000,
        maxModelInputCharacters: 4_000_000,
        maxToolOutputCharacters: 8_000,
        maxFinalOutputCharacters: 4_000,
        readOnlyPolicyFailure: "audit",
        streamingOutputMode: "audit",
      },
      { policyPack: "strict" },
    )).toEqual({
      policyPack: "strict",
      maxInputCharacters: 1_000_000,
      maxContextCharacters: 500_000,
      maxModelInputCharacters: 2_000_000,
      maxToolOutputCharacters: 8_000,
      maxFinalOutputCharacters: 4_000,
      readOnlyPolicyFailure: "block",
      streamingOutputMode: "buffer",
    });
  });

  it("keeps an existing strict policy stable for a strict request", () => {
    const strict = normalizeRuntimeGuardrailSettings({
      policyPack: "strict",
      maxInputCharacters: 250_000,
    });

    expect(resolveRuntimeGuardrailRequestPolicy(
      strict,
      { policyPack: "strict" },
    )).toEqual(strict);
  });

  it.each([
    [undefined, "not configured"],
    [{}, "not configured"],
    [
      {
        policyPack: "custom",
        contentRules: [{
          id: "custom.rule",
          phases: ["input"],
          action: "block",
          risk: "high",
          containsAny: ["private"],
        }],
      },
      "custom",
    ],
  ] as const)(
    "rejects a strict request that cannot monotonically narrow %#",
    (projectPolicy, message) => {
      expect(() => resolveRuntimeGuardrailRequestPolicy(
        projectPolicy,
        { policyPack: "strict" },
      )).toThrow(message);
    },
  );

  it("rejects unknown or weaker request policy fields", () => {
    expect(() => resolveRuntimeGuardrailRequestPolicy(
      { policyPack: "strict" },
      { policyPack: "standard" } as never,
    )).toThrow("strict");
    expect(() => resolveRuntimeGuardrailRequestPolicy(
      { policyPack: "strict" },
      { policyPack: "strict", unknown: true } as never,
    )).toThrow("unknown field");
  });

  it("makes strict policy failures and destructive operations fail closed", async () => {
    const settings = normalizeRuntimeGuardrailSettings({
      policyPack: "strict",
    });
    const middleware = createConfiguredRunToolMiddleware(settings);
    const next = vi.fn(async () => "should not run");

    expect(settings).toEqual({
      policyPack: "strict",
      readOnlyPolicyFailure: "block",
      streamingOutputMode: "buffer",
    });
    await expect(middleware?.execute({
      name: "bash",
      args: { command: "rm -rf /" },
      sideEffect: "write",
      context: {},
    }, next)).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("runs standard input policy before the model and redacts secrets", async () => {
    const policy = createConfiguredRunPreflightPolicy({
      policyPack: "standard",
    });

    await expect(policy?.evaluate({
      phase: "input",
      value: "token ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      mode: "enforce",
      context: { surface: "agent" },
    })).resolves.toMatchObject({
      value: "token [REDACTED]",
      enforced: true,
      decisions: [expect.objectContaining({
        policyId: "secrets.preflight",
        action: "redact",
      })],
    });
  });

  it("keeps rewritten content unchanged in observational mode", async () => {
    const policy = createConfiguredRunPreflightPolicy({
      policyPack: "standard",
    });
    const input = "token ghp_abcdefghijklmnopqrstuvwxyz1234567890";

    await expect(policy?.evaluate({
      phase: "input",
      value: input,
      mode: "audit",
      context: {},
    })).resolves.toMatchObject({
      value: input,
      enforced: false,
      decisions: [expect.objectContaining({ action: "redact" })],
    });
  });

  it("supports bounded deterministic custom content rules", async () => {
    const policy = createConfiguredRunPreflightPolicy({
      policyPack: "custom",
      contentRules: [{
        id: "support.no-passwords",
        phases: ["input", "output"],
        action: "block",
        risk: "high",
        containsAny: ["password reset token", "one-time password"],
      }],
    });

    await expect(policy?.evaluate({
      phase: "input",
      value: "Please expose the PASSWORD RESET TOKEN",
      mode: "enforce",
      context: {},
    })).rejects.toMatchObject({
      code: "guardrail_blocked",
      decisions: [expect.objectContaining({
        policyId: "support.no-passwords",
      })],
    });
  });

  it("redacts every literal match without regular-expression semantics", async () => {
    const policy = createConfiguredRunPreflightPolicy({
      policyPack: "custom",
      contentRules: [{
        id: "content.literal-redaction",
        phases: ["input"],
        action: "redact",
        risk: "medium",
        containsAny: ["A+B"],
        replacement: "[TERM]",
      }],
    });

    await expect(policy?.evaluate({
      phase: "input",
      value: "a+b A+B a.*b",
      mode: "enforce",
      context: {},
    })).resolves.toMatchObject({
      value: "[TERM] [TERM] a.*b",
    });
  });

  it("blocks oversized input before running later host policies", async () => {
    const hostPolicy: RuntimeGuardrailPolicy = {
      id: "host.must-not-run",
      phases: ["input"],
      evaluate: vi.fn(() => null),
    };
    const policy = createConfiguredRunPreflightPolicy({
      policyPack: "standard",
      maxInputCharacters: 8,
    }, {
      policies: [hostPolicy],
    });

    await expect(policy?.evaluate({
      phase: "input",
      value: "123456789",
      mode: "enforce",
      context: {},
    })).rejects.toMatchObject({
      code: "guardrail_blocked",
      decisions: [expect.objectContaining({
        policyId: "input.bounded-value",
      })],
    });
    expect(hostPolicy.evaluate).not.toHaveBeenCalled();
  });

  it("accepts host policies without serializing classifier implementations", async () => {
    const classify = vi.fn<RuntimeGuardrailPolicy["evaluate"]>(() => ({
      action: "block",
      risk: "high",
      reason: "Host classifier rejected the request",
    }));
    const hostPolicy: RuntimeGuardrailPolicy = {
      id: "host.content-classifier",
      phases: ["model.preflight"],
      evaluate: classify,
    };
    const policy = createConfiguredRunPreflightPolicy(
      { policyPack: "standard" },
      { policies: [hostPolicy] },
    );

    await expect(policy?.evaluate({
      phase: "model.preflight",
      value: "bounded model input",
      mode: "enforce",
      context: {},
    })).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(classify).toHaveBeenCalledOnce();
  });

  it("fails closed when a host content classifier throws", async () => {
    const policy = createConfiguredRunPreflightPolicy(
      { policyPack: "standard" },
      {
        policies: [{
          id: "host.unavailable-classifier",
          phases: ["input"],
          evaluate: () => {
            throw new Error("classifier unavailable");
          },
        }],
      },
    );

    await expect(policy?.evaluate({
      phase: "input",
      value: "ordinary request",
      mode: "enforce",
      context: {},
    })).rejects.toMatchObject({
      code: "guardrail_blocked",
      decisions: [expect.objectContaining({
        policyId: "host.unavailable-classifier",
        action: "block",
        fallbackUsed: true,
      })],
    });
  });

  it("applies custom output rules through the same unified pack", async () => {
    const policy = createConfiguredRunOutputPolicy({
      policyPack: "custom",
      contentRules: [{
        id: "output.customer-name",
        phases: ["output"],
        action: "redact",
        risk: "medium",
        containsAny: ["Private Customer"],
        replacement: "[CUSTOMER]",
      }],
    });

    await expect(policy?.evaluate({
      output: "Result for private customer",
      mode: "enforce",
      context: {},
    })).resolves.toMatchObject({
      output: "Result for [CUSTOMER]",
      enforced: true,
    });
  });

  it("preserves __proto__ as inert data while redacting nested input", async () => {
    const value = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"token":"ghp_abcdefghijklmnopqrstuvwxyz1234567890"}',
    );
    const policy = createConfiguredRunPreflightPolicy({
      policyPack: "standard",
    });

    const result = await policy?.evaluate({
      phase: "input",
      value,
      mode: "enforce",
      context: {},
    });

    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.getPrototypeOf(result?.value)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result?.value, "__proto__")).toBe(true);
    expect(result?.value).toMatchObject({
      token: "[REDACTED]",
    });
  });

  it("rejects policy id collisions instead of producing ambiguous audit records", () => {
    expect(() => createConfiguredRunPreflightPolicy({
      policyPack: "custom",
      contentRules: [{
        id: "secrets.preflight",
        phases: ["input"],
        action: "block",
        risk: "high",
        containsAny: ["x"],
      }],
    })).toThrow('Duplicate guardrail policy id "secrets.preflight"');
  });

  it.each([
    {
      policyPack: "standard",
      toolPolicyPack: "default",
    },
    {
      policyPack: "custom",
    },
    {
      policyPack: "standard",
      contentRules: [],
    },
    {
      policyPack: "custom",
      contentRules: [{
        id: "invalid",
        phases: ["tool.before"],
        action: "block",
        risk: "high",
        containsAny: ["x"],
      }],
    },
    {
      policyPack: "custom",
      contentRules: [{
        id: "invalid",
        phases: ["input"],
        action: "approval",
        risk: "high",
        containsAny: ["x"],
      }],
    },
    {
      policyPack: "custom",
      contentRules: [{
        id: "invalid id with spaces",
        phases: ["input"],
        action: "block",
        risk: "high",
        containsAny: ["x"],
      }],
    },
  ])("rejects unsafe or ambiguous pack configuration %#", (settings) => {
    expect(() => normalizeRuntimeGuardrailSettings(settings)).toThrow();
  });
});
