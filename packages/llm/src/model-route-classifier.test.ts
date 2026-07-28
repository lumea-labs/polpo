import { describe, expect, it, vi } from "vitest";
import { createStructuredModelRouteClassifier } from "./model-route-classifier.js";

describe("createStructuredModelRouteClassifier", () => {
  it("uses strict structured output and forwards only the compact classifier contract", async () => {
    const generate = vi.fn(async () => ({
      output: {
        profile: "fast",
        confidence: 0.91,
        reason: "Latency-sensitive request.",
        labels: ["latency"],
      },
    }));
    const classifier = createStructuredModelRouteClassifier({
      model: { modelId: "test-router" } as never,
      generate,
    });
    const abort = new AbortController();
    const input = Object.freeze({
      version: 1 as const,
      surface: "channel" as const,
      source: "channel" as const,
      input: "Reply briefly.",
      profiles: Object.freeze(["fast", "balanced"]),
      labels: Object.freeze(["telegram"]),
    });

    const result = await classifier.classify(input, {
      signal: abort.signal,
    });

    expect(result).toEqual({
      profile: "fast",
      confidence: 0.91,
      reason: "Latency-sensitive request.",
      labels: ["latency"],
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      model: { modelId: "test-router" },
      abortSignal: abort.signal,
      temperature: 0,
      maxOutputTokens: 256,
      output: expect.anything(),
      system: expect.stringContaining("Select exactly one allowed semantic model profile"),
      prompt: JSON.stringify(input),
    }));
    const firstCall = generate.mock.calls[0] as unknown as [Record<string, unknown>];
    const serialized = JSON.stringify(firstCall[0]);
    expect(serialized).not.toContain("tool schema");
    expect(serialized).not.toContain("conversation history");
  });

  it("throws when the provider returns no structured output", async () => {
    const classifier = createStructuredModelRouteClassifier({
      model: {} as never,
      generate: vi.fn(async () => ({ output: undefined })),
    });

    await expect(classifier.classify({
      version: 1,
      surface: "agent",
      source: "request",
      input: "hello",
      profiles: ["fast", "balanced"],
      labels: [],
    }, {
      signal: new AbortController().signal,
    })).rejects.toThrow("did not return structured output");
  });

  it("allows hosts to replace the classifier instructions without exposing them in config", async () => {
    const generate = vi.fn(async () => ({
      output: {
        profile: "balanced",
        confidence: 1,
        reason: "Default",
        labels: [],
      },
    }));
    const classifier = createStructuredModelRouteClassifier({
      model: {} as never,
      system: "private host classifier",
      generate,
    });

    await classifier.classify({
      version: 1,
      surface: "task",
      source: "task",
      input: "do work",
      profiles: ["balanced"],
      labels: [],
    }, {
      signal: new AbortController().signal,
    });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      system: "private host classifier",
    }));
  });
});
