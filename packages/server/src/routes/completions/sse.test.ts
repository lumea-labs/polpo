import { describe, expect, it } from "vitest";
import { modelErrorEnvelope, modelNotFoundEnvelope, sseChunk, visibleModelError } from "./sse.js";

describe("sseChunk", () => {
  it("emits reasoning summaries through the existing thinking extension", () => {
    expect(JSON.parse(sseChunk("chat-1", {}, null, {
      thinking: "Checked the constraints.",
    }))).toMatchObject({
      choices: [{
        delta: {},
        finish_reason: null,
        thinking: "Checked the constraints.",
      }],
    });
  });
});

describe("model error envelopes", () => {
  it("extracts a nested gateway error without leaking the whole response", () => {
    const error = {
      cause: {
        responseBody: JSON.stringify({ error: { message: "thinking.type.enabled is unsupported" } }),
      },
    };
    expect(visibleModelError(error)).toBe("thinking.type.enabled is unsupported");
    expect(modelErrorEnvelope(error)).toEqual({
      message: "thinking.type.enabled is unsupported",
      type: "model_error",
      code: "model_request_failed",
    });
  });

  it("recognizes model-not-found after the Run event wrapper normalized it", () => {
    expect(modelNotFoundEnvelope({
      error: {
        name: "GatewayModelNotFoundError",
        modelId: "provider/removed-model",
      },
    }, undefined, "agent-1")).toMatchObject({
      type: "model_not_found",
      param: { modelId: "provider/removed-model", agent: "agent-1" },
    });
  });
});
