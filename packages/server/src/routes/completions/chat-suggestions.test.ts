import { describe, expect, it, vi } from "vitest";
import { generateChatSuggestions } from "./chat-suggestions.js";

const model = {} as any;

describe("generateChatSuggestions", () => {
  it("returns a bounded, kind-free public primitive", async () => {
    const generate = vi.fn().mockResolvedValue({
      output: {
        suggestions: [
          { label: "  Add tests  ", prompt: "  Add tests for this change.  " },
          { label: "Duplicate", prompt: "Add tests for this change." },
          { label: "Review", prompt: "Review the implementation for edge cases." },
          { label: "Document", prompt: "Document the public API." },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
      providerMetadata: { gateway: { generationId: "gen_1" } },
    });

    const result = await generateChatSuggestions({
      model,
      messages: [{ role: "user", content: "Implement this" }],
      finalText: "The implementation is ready.",
      maxItems: 2,
      generate,
    });

    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions[0]).toEqual({
      id: expect.stringMatching(/^suggestion_/),
      label: "Add tests",
      prompt: "Add tests for this change.",
    });
    expect(result.suggestions[0]).not.toHaveProperty("kind");
    expect(result.suggestions[1]?.label).toBe("Review");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 8, totalTokens: 18 });
    expect(result.providerMetadata).toEqual({ gateway: { generationId: "gen_1" } });
  });

  it("passes only bounded conversation text and project guidance", async () => {
    const generate = vi.fn().mockResolvedValue({ output: { suggestions: [] } });
    await generateChatSuggestions({
      model,
      messages: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index}-${"x".repeat(2_000)}`,
      })),
      finalText: "done",
      maxItems: 3,
      guidance: "Prefer concrete next actions.",
      generate,
    });

    const call = generate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(call.prompt).length).toBeLessThan(10_000);
    expect(String(call.prompt)).toContain("Prefer concrete next actions.");
    expect(call).not.toHaveProperty("tools");
  });

  it("fails open for invalid model output", async () => {
    const result = await generateChatSuggestions({
      model,
      messages: [{ role: "user", content: "hello" }],
      finalText: "hi",
      maxItems: 3,
      generate: vi.fn().mockResolvedValue({ output: { suggestions: "invalid" } }),
    });
    expect(result).toEqual({ suggestions: [] });
  });

  it("fails open when the auxiliary model call rejects", async () => {
    const result = await generateChatSuggestions({
      model,
      messages: [{ role: "user", content: "hello" }],
      finalText: "hi",
      maxItems: 3,
      generate: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });
    expect(result).toEqual({ suggestions: [] });
  });

  it("times out without failing the main completion", async () => {
    const result = await generateChatSuggestions({
      model,
      messages: [{ role: "user", content: "hello" }],
      finalText: "hi",
      maxItems: 3,
      timeoutMs: 5,
      generate: vi.fn().mockImplementation(({ abortSignal }) => new Promise((_, reject) => {
        abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })),
    });
    expect(result).toEqual({ suggestions: [] });
  });

  it("skips generation for blank assistant output", async () => {
    const generate = vi.fn();
    const result = await generateChatSuggestions({
      model,
      messages: [{ role: "user", content: "hello" }],
      finalText: "   ",
      maxItems: 3,
      generate,
    });
    expect(result).toEqual({ suggestions: [] });
    expect(generate).not.toHaveBeenCalled();
  });
});


it("generates up to five and includes request context without exposing system/tool messages", async () => {
  const generate = vi.fn().mockResolvedValue({ output: { suggestions:
    Array.from({ length: 5 }, (_, i) => ({ label: `Next ${i}`, prompt: `Do step ${i}` })),
  } });
  const result = await generateChatSuggestions({ model, maxItems: 5, finalText: "Site ready",
    guidance: "Agent guidance", requestGuidance: "Help personalize the site",
    context: { published: true, modificationsLeft: 0 },
    messages: [{ role: "user", content: "Make my site" },
      { role: "system", content: "private system" },
      ...Array.from({ length: 10 }, () => ({ role: "tool", content: "private tool result" }))],
    generate,
  });
  expect(result.suggestions).toHaveLength(5);
  const prompt = JSON.parse(generate.mock.calls[0][0].prompt);
  expect(prompt.context).toEqual({ published: true, modificationsLeft: 0 });
  expect(prompt.guidance).toBe("Agent guidance");
  expect(prompt.requestGuidance).toBe("Help personalize the site");
  expect(prompt.conversation).toEqual([{ role: "user", content: "Make my site" }]);
});


it("returns promptly on abort even when a provider ignores its signal", async () => {
  const controller = new AbortController();
  const pending = generateChatSuggestions({ model, messages: [], finalText: "done", maxItems: 3,
    signal: controller.signal, generate: () => new Promise(() => {}),
  });
  controller.abort();
  expect(await pending).toEqual({ suggestions: [] });
});
