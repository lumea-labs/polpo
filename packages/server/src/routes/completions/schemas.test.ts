import { describe, expect, it } from "vitest";
import { completionRequestSchema } from "./schemas.js";

const request = {
  messages: [{ role: "user" as const, content: "hello" }],
  agent: "support",
};

describe("completion request guardrail policy", () => {
  it("accepts only an explicit strict request policy", () => {
    expect(completionRequestSchema.parse({
      ...request,
      guardrails: { policyPack: "strict" },
    }).guardrails).toEqual({ policyPack: "strict" });
  });

  it.each([
    { policyPack: "standard" },
    { policyPack: "custom" },
    { policyPack: "strict", unknown: true },
    {},
    "strict",
  ])("rejects a non-monotonic or malformed request policy %#", (guardrails) => {
    expect(completionRequestSchema.safeParse({
      ...request,
      guardrails,
    }).success).toBe(false);
  });
});

describe("completion request sandbox lifecycle", () => {
  it.each([
    { isolation: "reuse" },
    { isolation: "shared", lifecycle: { onRelease: "pool" } },
    { isolation: "fresh", lifecycle: { onRelease: "pool" } },
    {
      isolation: "fresh",
      lifecycle: { onRelease: "pool", idleTtlMinutes: 30 },
    },
    { isolation: "reuse", lifecycle: { onRelease: "destroy" } },
  ])("accepts valid sandbox policy %#", (sandbox) => {
    expect(completionRequestSchema.parse({ ...request, sandbox }).sandbox).toEqual(sandbox);
  });

  it.each([
    { lifecycle: { onRelease: "archive" } },
    { lifecycle: { onRelease: "pool", idleTtlMinutes: 0 } },
    { lifecycle: { onRelease: "pool", idleTtlMinutes: 1.5 } },
    { lifecycle: { onRelease: "pool", idleTtlMinutes: 10_081 } },
    { lifecycle: { onRelease: "destroy", idleTtlMinutes: 10 } },
    { lifecycle: { onRelease: "pool", unknown: true } },
    { lifecycle: "pool" },
    { isolation: "reuse", unknown: true },
  ])("rejects malformed sandbox policy %#", (sandbox) => {
    expect(completionRequestSchema.safeParse({ ...request, sandbox }).success).toBe(false);
  });
});
