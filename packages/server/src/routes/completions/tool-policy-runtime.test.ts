import { describe, expect, it, vi } from "vitest";
import {
  createPolicyGuardedToolExecutor,
  filterToolDefinitionsByPolicy,
  filterToolRecordByPolicy,
  resolveExecutionToolPolicy,
  toolPolicyAuditData,
} from "./tool-policy-runtime.js";

describe("execution tool policy runtime", () => {
  const agent = {
    allowedTools: ["site_*", "ask_user_question", "apply_site_change"],
    chat: { allowedTools: ["ask_user_question", "apply_site_change"] },
    channels: { allowedTools: ["ask_user_question"] },
  };

  it("recalculates Loop policy without carrying chat or Channel restrictions", () => {
    const loop = resolveExecutionToolPolicy({
      agent,
      mode: "loop",
      loopAllowedTools: ["site_*"],
      stepAllowedTools: ["site_checkout", "site_validate"],
    });

    expect(filterToolDefinitionsByPolicy([
      { name: "ask_user_question" },
      { name: "site_checkout" },
      { name: "site_validate" },
    ], loop)).toEqual([
      { name: "site_checkout" },
      { name: "site_validate" },
    ]);
  });

  it("applies route restrictions only to Channel turns", () => {
    const channel = resolveExecutionToolPolicy({
      agent,
      mode: "channels",
      routeAllowedTools: ["apply_site_change"],
    });
    const loop = resolveExecutionToolPolicy({
      agent,
      mode: "loop",
      routeAllowedTools: [],
      loopAllowedTools: ["site_checkout"],
    });

    expect(filterToolRecordByPolicy({
      apply_site_change: {},
      ask_user_question: {},
    }, channel)).toEqual({});
    expect(filterToolRecordByPolicy({ site_checkout: {} }, loop)).toEqual({
      site_checkout: {},
    });
  });

  it("lets execution and trusted grant restrictions narrow but never expand", () => {
    const policy = resolveExecutionToolPolicy({
      agent,
      mode: "loop",
      executionAllowedTools: ["site_checkout", "admin_delete"],
      grantAllowedTools: ["site_checkout", "admin_delete"],
    });

    expect(filterToolRecordByPolicy({
      admin_delete: {},
      site_checkout: {},
    }, policy)).toEqual({ site_checkout: {} });
  });

  it("fails closed if a denied tool bypasses model-visible filtering", async () => {
    const execute = vi.fn(async () => "ok");
    const policy = resolveExecutionToolPolicy({
      agent,
      mode: "chat",
    });
    const guarded = createPolicyGuardedToolExecutor(execute, policy);

    await expect(guarded("site_checkout", {})).rejects.toMatchObject({
      code: "tool_policy_denied",
      toolName: "site_checkout",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("produces deterministic secret-free audit data", () => {
    const policy = resolveExecutionToolPolicy({ agent, mode: "chat" });
    expect(toolPolicyAuditData({
      policy,
      requested: ["site_checkout", "ask_user_question", "ask_user_question"],
      mode: "chat",
    })).toMatchObject({
      requested: ["ask_user_question", "site_checkout"],
      effective: ["ask_user_question"],
      denied: ["site_checkout"],
      mode: "chat",
    });
  });
});
