import { describe, expect, it, vi } from "vitest";
import {
  GuardrailAbortedError,
  GuardrailApprovalRequiredError,
  GuardrailBlockedError,
  RuntimeGuardrailEngine,
  createConfiguredRunOutputPolicy,
  createRunOutputPolicy,
  normalizeRuntimeGuardrailSettings,
  type RuntimeGuardrailPolicy,
} from "../guardrails/index.js";

function policy(
  action: "redact" | "rewrite" | "block" | "approval",
  value?: unknown,
): RuntimeGuardrailPolicy {
  return {
    id: `output.${action}`,
    phases: ["output"],
    evaluate: () => ({
      action,
      risk: "high",
      reason: `${action} output`,
      ...(action === "redact" || action === "rewrite" ? { value } : {}),
    }),
  };
}

describe("output guardrails", () => {
  it("returns the rewritten output in enforce mode", async () => {
    const outputPolicy = createRunOutputPolicy(
      new RuntimeGuardrailEngine([policy("redact", "safe")]),
    );

    await expect(outputPolicy.evaluate({
      output: "secret",
      mode: "enforce",
      context: { surface: "agent" },
    })).resolves.toMatchObject({
      output: "safe",
      enforced: true,
      decisions: [expect.objectContaining({ action: "redact" })],
    });
  });

  it("keeps the delivered output unchanged in audit mode", async () => {
    const outputPolicy = createRunOutputPolicy(
      new RuntimeGuardrailEngine([policy("redact", "safe")]),
    );

    await expect(outputPolicy.evaluate({
      output: "already streamed secret",
      mode: "audit",
      context: { surface: "agent" },
    })).resolves.toMatchObject({
      output: "already streamed secret",
      enforced: false,
      decisions: [expect.objectContaining({ action: "redact" })],
    });
  });

  it("blocks or requests approval only in enforce mode", async () => {
    const blocked = createRunOutputPolicy(
      new RuntimeGuardrailEngine([policy("block")]),
    );
    const approval = createRunOutputPolicy(
      new RuntimeGuardrailEngine([policy("approval")]),
    );

    await expect(blocked.evaluate({
      output: "unsafe",
      mode: "enforce",
      context: {},
    })).rejects.toBeInstanceOf(GuardrailBlockedError);
    await expect(approval.evaluate({
      output: "review",
      mode: "enforce",
      context: {},
    })).rejects.toBeInstanceOf(GuardrailApprovalRequiredError);

    await expect(blocked.evaluate({
      output: "already delivered",
      mode: "audit",
      context: {},
    })).resolves.toMatchObject({
      output: "already delivered",
      enforced: false,
      decisions: [expect.objectContaining({ action: "block" })],
    });
  });

  it("honors output approval and fails closed on denial", async () => {
    const approved = createRunOutputPolicy(
      new RuntimeGuardrailEngine([policy("approval")]),
      { approval: async (): Promise<"approved"> => "approved" },
    );
    const denied = createRunOutputPolicy(
      new RuntimeGuardrailEngine([policy("approval")]),
      { approval: async (): Promise<"denied"> => "denied" },
    );

    await expect(approved.evaluate({
      output: "reviewed",
      mode: "enforce",
      context: {},
    })).resolves.toMatchObject({
      output: "reviewed",
      enforced: true,
    });
    await expect(denied.evaluate({
      output: "rejected",
      mode: "enforce",
      context: {},
    })).rejects.toThrow("approval was denied");
  });

  it("fails closed when a policy rewrites output to a non-string value", async () => {
    const outputPolicy = createRunOutputPolicy(
      new RuntimeGuardrailEngine([policy("rewrite", { unsafe: true })]),
    );

    await expect(outputPolicy.evaluate({
      output: "text",
      mode: "enforce",
      context: {},
    })).rejects.toBeInstanceOf(GuardrailBlockedError);
  });

  it("propagates cancellation without evaluating policies", async () => {
    const evaluate = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const outputPolicy = createRunOutputPolicy(
      new RuntimeGuardrailEngine([{
        id: "never",
        phases: ["output"],
        evaluate,
      }]),
    );

    await expect(outputPolicy.evaluate({
      output: "text",
      mode: "enforce",
      context: {},
      signal: controller.signal,
    })).rejects.toBeInstanceOf(GuardrailAbortedError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects an untyped invalid enforcement mode", async () => {
    const outputPolicy = createRunOutputPolicy(
      new RuntimeGuardrailEngine([]),
    );

    await expect(outputPolicy.evaluate({
      output: "text",
      mode: "invalid" as "enforce",
      context: {},
    })).rejects.toThrow('must be "enforce" or "audit"');
  });

  it("configures output enforcement independently from tool middleware", async () => {
    const settings = normalizeRuntimeGuardrailSettings({
      outputPolicyPack: "default",
      streamingOutputMode: "buffer",
    });
    const outputPolicy = createConfiguredRunOutputPolicy(settings);

    expect(settings).toEqual({
      outputPolicyPack: "default",
      streamingOutputMode: "buffer",
    });
    expect(outputPolicy?.streamingMode).toBe("buffer");
    await expect(outputPolicy?.evaluate({
      output: "token sk-abcdefghijklmnopqrstuvwxyzABCDEFGH123456",
      mode: "enforce",
      context: {},
    })).resolves.toMatchObject({
      output: "token [REDACTED]",
    });
  });

  it("defaults configured streaming output to audit and validates dependent settings", () => {
    expect(normalizeRuntimeGuardrailSettings({
      outputPolicyPack: "default",
    })).toEqual({
      outputPolicyPack: "default",
      streamingOutputMode: "audit",
    });
    expect(() => normalizeRuntimeGuardrailSettings({
      streamingOutputMode: "buffer",
    })).toThrow("requires guardrails.outputPolicyPack");
    expect(() => normalizeRuntimeGuardrailSettings({
      outputPolicyPack: "default",
      streamingOutputMode: "invalid",
    })).toThrow('must be "audit" or "buffer"');
    expect(normalizeRuntimeGuardrailSettings({
      futurePolicyPack: "future",
    })).toBeUndefined();
  });
});
