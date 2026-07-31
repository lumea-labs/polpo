import { describe, expect, it, vi } from "vitest";
import { createStructuredExecutionRouteClassifier } from "./execution-route-classifier.js";

const input = Object.freeze({
  version: 1 as const,
  surface: "channel" as const,
  source: "channel" as const,
  input: "Build a launch page.",
  loops: Object.freeze([
    Object.freeze({
      name: "build",
      label: "Build",
      description: "Create or modify project files.",
    }),
  ]),
  labels: Object.freeze(["telegram"]),
  loopHints: Object.freeze({
    build: "Use for deterministic file-producing work.",
  }),
  guidance: "Prefer direct execution for simple questions.",
});

describe("createStructuredExecutionRouteClassifier", () => {
  it("uses strict structured output and forwards only the compact router contract", async () => {
    const generate = vi.fn(async () => ({
      output: {
        mode: "loop",
        loop: "build",
        confidence: 0.94,
        reason: "The request needs a deterministic build workflow.",
      },
    }));
    const classifier = createStructuredExecutionRouteClassifier({
      model: { modelId: "test-router" } as never,
      generate,
    });
    const abort = new AbortController();

    const result = await classifier.classify(input, {
      signal: abort.signal,
    });

    expect(result).toEqual({
      mode: "loop",
      loop: "build",
      confidence: 0.94,
      reason: "The request needs a deterministic build workflow.",
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      model: { modelId: "test-router" },
      abortSignal: abort.signal,
      temperature: 0,
      maxOutputTokens: 256,
      output: expect.anything(),
      system: expect.stringContaining("direct execution or exactly one allowed loop"),
      prompt: JSON.stringify(input),
    }));
    const firstCall = generate.mock.calls[0] as unknown as [Record<string, unknown>];
    const serialized = JSON.stringify(firstCall[0]);
    expect(serialized).not.toContain("systemPrompt");
    expect(serialized).not.toContain("allowedTools");
    expect(serialized).not.toContain("modelId\":\"provider/");
    expect(firstCall[0].prompt).toContain(
      '"loopHints":{"build":"Use for deterministic file-producing work."}',
    );
    expect(firstCall[0].prompt).toContain(
      '"guidance":"Prefer direct execution for simple questions."',
    );
  });

  it("supports direct decisions and rejects missing structured output", async () => {
    const direct = createStructuredExecutionRouteClassifier({
      model: {} as never,
      generate: vi.fn(async () => ({
        output: {
          mode: "direct",
          confidence: 0.99,
          reason: "A normal response is enough.",
        },
      })),
    });
    await expect(direct.classify(input, {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ mode: "direct" });

    const missing = createStructuredExecutionRouteClassifier({
      model: {} as never,
      generate: vi.fn(async () => ({ output: null })),
    });
    await expect(missing.classify(input, {
      signal: new AbortController().signal,
    })).rejects.toThrow("did not return structured output");
  });

  it("keeps classifier instructions host-private and forwards provider options", async () => {
    const generate = vi.fn(async () => ({
      output: {
        mode: "direct",
        confidence: 1,
        reason: "Default",
      },
    }));
    const classifier = createStructuredExecutionRouteClassifier({
      model: {} as never,
      system: "private host classifier",
      providerOptions: { gateway: { order: ["fast-provider"] } },
      generate,
    });

    await classifier.classify(input, {
      signal: new AbortController().signal,
    });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      system: "private host classifier",
      providerOptions: { gateway: { order: ["fast-provider"] } },
    }));
  });
});
