import { describe, expect, it } from "vitest";
import { extractToolUsageRecord } from "../tool-usage.js";

describe("extractToolUsageRecord", () => {
  it("keeps the existing gateway media usage shape compatible", () => {
    const usage = {
      generationId: "gen_img_1",
      marketCostUsd: 0.03,
      actualCostUsd: 0.01,
      resolvedModel: "bfl/flux-pro-1.1",
      finalProvider: "bfl",
      credentialType: "system",
    };

    expect(extractToolUsageRecord("image_generate", { usage })).toEqual({
      toolName: "image_generate",
      mode: "gateway",
      generationId: "gen_img_1",
      marketCostUsd: 0.03,
      actualCostUsd: 0.01,
      resolvedModel: "bfl/flux-pro-1.1",
      finalProvider: "bfl",
      credentialType: "platform",
      billingOwner: "platform",
      costSource: "gateway-metadata",
      status: "succeeded",
      rawMetadata: { usage },
    });
  });

  it("extracts provider/local model usage facts without platform spend", () => {
    expect(extractToolUsageRecord("audio_transcribe", {
      modelUsage: {
        mode: "provider",
        operation: "audio.transcribe",
        requestedProvider: "deepgram",
        requestedModel: "deepgram/nova-2",
        resolvedProvider: "deepgram",
        resolvedModel: "deepgram/nova-2",
        finalProvider: "deepgram",
        credentialType: "project",
        status: "succeeded",
        audioInputSeconds: 12.5,
        costSource: "unknown",
        billingOwner: "external",
      },
    })).toEqual({
      toolName: "audio_transcribe",
      mode: "provider",
      operation: "audio.transcribe",
      requestedProvider: "deepgram",
      requestedModel: "deepgram/nova-2",
      resolvedProvider: "deepgram",
      resolvedModel: "deepgram/nova-2",
      finalProvider: "deepgram",
      credentialType: "project",
      status: "succeeded",
      audioInputSeconds: 12.5,
      costSource: "unknown",
      billingOwner: "external",
    });
  });
});
