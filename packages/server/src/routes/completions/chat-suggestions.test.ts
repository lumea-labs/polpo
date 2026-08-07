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
