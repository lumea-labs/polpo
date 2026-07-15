import { describe, expect, it } from "vitest";
import {
  MODEL_RUNTIME_MODES,
  isModelRuntimeMode,
  type ModelInvocationRecord,
  type ModelRuntimeAdapter,
} from "./model-runtime.js";

describe("model runtime contracts", () => {
  it("only exposes provider and gateway as public runtime modes", () => {
    expect(MODEL_RUNTIME_MODES).toEqual(["provider", "gateway"]);
    expect(isModelRuntimeMode("provider")).toBe(true);
    expect(isModelRuntimeMode("gateway")).toBe(true);
    expect(isModelRuntimeMode("managed-gateway")).toBe(false);
  });

  it("allows platform billing to be a ledger decoration instead of a runtime mode", () => {
    const record: ModelInvocationRecord = {
      mode: "gateway",
      operation: "chat",
      requestedModel: "anthropic/claude-sonnet-5",
      status: "succeeded",
      costSource: "gateway-metadata",
      billingOwner: "platform",
      billableCostUsd: 0.01,
    };

    expect(record.mode).toBe("gateway");
    expect(record.billingOwner).toBe("platform");
  });

  it("keeps hosted gateway implementation details out of the adapter shape", () => {
    const adapter: Pick<ModelRuntimeAdapter, "mode" | "classifyError"> = {
      mode: "gateway",
      classifyError: () => ({ class: "unknown", retryable: false }),
    };

    expect(adapter.mode).toBe("gateway");
    expect(Object.keys(adapter)).not.toContain("managed");
  });
});
