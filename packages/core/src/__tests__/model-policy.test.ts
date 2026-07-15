import { describe, expect, it } from "vitest";
import {
  MAX_MODEL_FALLBACKS,
  isModelConfig,
  normalizeModelPolicy,
} from "../model-policy.js";

describe("model policy normalization", () => {
  it("keeps a string model as a primary-only policy", () => {
    expect(normalizeModelPolicy(" openai/gpt-4o-mini ")).toEqual({
      primary: "openai/gpt-4o-mini",
      fallbacks: [],
      candidates: ["openai/gpt-4o-mini"],
    });
  });

  it("normalizes object policies and deduplicates primary/fallback repeats", () => {
    expect(
      normalizeModelPolicy({
        primary: "anthropic/claude-sonnet-4",
        fallbacks: [
          "openai/gpt-4o-mini",
          "anthropic/claude-sonnet-4",
          " openai/gpt-4o-mini ",
          "xai/grok-4.1-fast-reasoning",
        ],
      }),
    ).toEqual({
      primary: "anthropic/claude-sonnet-4",
      fallbacks: ["openai/gpt-4o-mini", "xai/grok-4.1-fast-reasoning"],
      candidates: [
        "anthropic/claude-sonnet-4",
        "openai/gpt-4o-mini",
        "xai/grok-4.1-fast-reasoning",
      ],
    });
  });

  it("rejects empty primary and empty fallback entries", () => {
    expect(() => normalizeModelPolicy(" ")).toThrow(/primary model cannot be empty/);
    expect(() =>
      normalizeModelPolicy({ primary: "openai/gpt-4o-mini", fallbacks: [""] }),
    ).toThrow(/fallbacks cannot contain empty/);
  });

  it("enforces the bounded fallback list", () => {
    expect(MAX_MODEL_FALLBACKS).toBe(3);
    expect(() =>
      normalizeModelPolicy({
        primary: "openai/gpt-4o-mini",
        fallbacks: [
          "anthropic/claude-sonnet-4",
          "xai/grok-4.1-fast-reasoning",
          "google/gemini-2.5-pro",
          "groq/llama-3.3-70b-versatile",
        ],
      }),
    ).toThrow(/at most 3 fallback/);
  });

  it("honors custom fallback bounds", () => {
    expect(() =>
      normalizeModelPolicy(
        {
          primary: "openai/gpt-4o-mini",
          fallbacks: ["anthropic/claude-sonnet-4"],
        },
        { maxFallbacks: 0 },
      ),
    ).toThrow(/at most 0 fallback/);
  });

  it("identifies model config objects without treating strings as configs", () => {
    expect(isModelConfig({ primary: "openai/gpt-4o-mini" })).toBe(true);
    expect(isModelConfig("openai/gpt-4o-mini")).toBe(false);
    expect(isModelConfig(null)).toBe(false);
    expect(isModelConfig([])).toBe(false);
  });
});
