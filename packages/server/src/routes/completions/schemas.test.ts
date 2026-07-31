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
