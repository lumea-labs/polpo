import { describe, expect, it } from "vitest";
import {
  MODEL_RUNTIME_MODES,
  isModelRuntimeMode,
  type ModelInvocationRecord,
} from "../model-runtime.js";

describe("model runtime facts", () => {
  it("keeps the public runtime modes deployment-agnostic", () => {
    expect(MODEL_RUNTIME_MODES).toEqual(["provider", "gateway"]);
    expect(isModelRuntimeMode("provider")).toBe(true);
    expect(isModelRuntimeMode("gateway")).toBe(true);
    expect(isModelRuntimeMode("managed-gateway")).toBe(false);
  });

  it("represents platform billing as ledger data, not as a runtime mode", () => {
    const record: ModelInvocationRecord = {
      mode: "gateway",
      operation: "chat",
      requestedModel: "anthropic/claude-sonnet-5",
      status: "succeeded",
      inputTokens: 10,
      outputTokens: 2,
      estimatedCostUsd: 0.01,
      billableCostUsd: 0.01,
      costSource: "gateway-metadata",
      billingOwner: "platform",
    };

    expect(record.mode).toBe("gateway");
    expect(record.billingOwner).toBe("platform");
  });
});
