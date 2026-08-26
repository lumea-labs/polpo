import { describe, expect, it } from "vitest";
import {
  LoopResultProjectionError,
  prepareProjectLoopResult,
} from "./result.js";

describe("prepareProjectLoopResult", () => {
  const context = {
    implementation: {
      response: "The preview is ready.",
      summary: "Update the primary CTA",
    },
    finalization: {
      previewUrl: "https://preview.example.test/revision-42",
      revisionId: "revision-42",
    },
  };

  it("projects structured data and a provider-neutral presentation", () => {
    expect(prepareProjectLoopResult({
      data: { $context: "finalization" },
      presentation: {
        text: { $context: "implementation.response" },
        actions: [
          {
            id: "open-preview",
            label: "Open preview",
            type: "open_url",
            url: { $context: "finalization.previewUrl" },
          },
          {
            id: "change-site",
            label: "Change site",
            type: "postback",
            value: "change-site",
          },
        ],
      },
    }, context)).toEqual({
      data: {
        previewUrl: "https://preview.example.test/revision-42",
        revisionId: "revision-42",
      },
      presentation: {
        text: "The preview is ready.",
        actions: [
          {
            id: "open-preview",
            label: "Open preview",
            type: "open_url",
            url: "https://preview.example.test/revision-42",
          },
          {
            id: "change-site",
            label: "Change site",
            type: "postback",
            value: "change-site",
          },
        ],
      },
    });
  });

  it("fails closed when a terminal binding is missing", () => {
    expect(() => prepareProjectLoopResult({
      presentation: { text: { $context: "implementation.missing" } },
    }, context)).toThrowError(expect.objectContaining({
      code: "loop_binding_missing",
    }));
  });

  it.each([
    ["non-string text", { presentation: { text: { $context: "implementation" } } }],
    ["empty text", { presentation: { text: "   " } }],
    ["unsafe URL", {
      presentation: {
        text: "Done",
        actions: [{ id: "open", label: "Open", type: "open_url", url: "javascript:alert(1)" }],
      },
    }],
    ["unknown action field", {
      presentation: {
        text: "Done",
        actions: [{ id: "open", label: "Open", type: "postback", value: "open", trusted: true }],
      },
    }],
  ])("rejects %s", (_label, config) => {
    expect(() => prepareProjectLoopResult(config, context)).toThrow(LoopResultProjectionError);
  });

  it("does not mutate or alias values from shared context", () => {
    const prepared = prepareProjectLoopResult({ data: { $context: "finalization" } }, context);
    expect(prepared.data).not.toBe(context.finalization);
    (prepared.data as Record<string, unknown>).revisionId = "changed";
    expect(context.finalization.revisionId).toBe("revision-42");
  });
});
