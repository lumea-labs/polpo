import { describe, expect, it } from "vitest";
import {
  ModelProfileResolutionError,
  resolveModelProfileSelection,
} from "../model-profiles.js";
import {
  modelProfileRegistrySchema,
  modelSelectionSchema,
} from "../schemas.js";

describe("model profile resolution", () => {
  it("preserves legacy model ids without interpreting provider-like names as profiles", () => {
    expect(resolveModelProfileSelection("openai")).toEqual({
      selection: "openai",
      policy: {
        primary: "openai",
        fallbacks: [],
        candidates: ["openai"],
      },
      profiles: [],
    });
  });

  it("resolves an explicit profile reference to a concrete policy", () => {
    expect(resolveModelProfileSelection(
      { profile: "fast" },
      {
        profiles: {
          fast: {
            primary: "openai/gpt-4o-mini",
            fallbacks: ["google/gemini-2.5-flash"],
          },
        },
      },
    )).toEqual({
      selection: {
        primary: "openai/gpt-4o-mini",
        fallbacks: ["google/gemini-2.5-flash"],
      },
      policy: {
        primary: "openai/gpt-4o-mini",
        fallbacks: ["google/gemini-2.5-flash"],
        candidates: ["openai/gpt-4o-mini", "google/gemini-2.5-flash"],
      },
      profiles: ["fast"],
    });
  });

  it("flattens nested profiles and mixed direct/profile fallbacks in order", () => {
    const result = resolveModelProfileSelection(
      {
        primary: { profile: "balanced" },
        fallbacks: ["local/qwen", { profile: "emergency" }],
      },
      {
        profiles: {
          balanced: {
            primary: "anthropic/claude-sonnet-4",
            fallbacks: [{ profile: "fast" }],
          },
          fast: "openai/gpt-4o-mini",
          emergency: {
            primary: "google/gemini-2.5-flash",
            fallbacks: ["local/qwen"],
          },
        },
      },
    );

    expect(result.policy.candidates).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o-mini",
      "local/qwen",
      "google/gemini-2.5-flash",
    ]);
    expect(result.profiles).toEqual(["balanced", "fast", "emergency"]);
  });

  it("deduplicates expanded models while preserving first occurrence", () => {
    const result = resolveModelProfileSelection(
      {
        primary: { profile: "fast" },
        fallbacks: ["openai/gpt-4o-mini", "local/qwen"],
      },
      {
        profiles: {
          fast: {
            primary: "openai/gpt-4o-mini",
            fallbacks: ["local/qwen"],
          },
        },
      },
    );

    expect(result.selection).toEqual({
      primary: "openai/gpt-4o-mini",
      fallbacks: ["local/qwen"],
    });
  });

  it("allows a profile to share a provider name because references are explicit", () => {
    expect(resolveModelProfileSelection(
      { profile: "openai" },
      { profiles: { openai: "openai/gpt-4o-mini" } },
    ).policy.primary).toBe("openai/gpt-4o-mini");
  });

  it.each([
    [null],
    [[]],
    ["fast"],
    [42],
  ])("rejects a malformed profile registry: %j", (profiles) => {
    expect(() => resolveModelProfileSelection(
      { profile: "fast" },
      { profiles: profiles as never },
    )).toThrowError(expect.objectContaining({
      code: "INVALID_PROFILE_REGISTRY",
    }));
  });

  it.each([
    [{ profile: "" }],
    [{ profile: " " }],
    [{ profile: "reasoning/high" }],
    [{ profile: "UPPER" }],
    [{ profile: 42 }],
    [{ profile: "fast", primary: "openai/gpt-4o-mini" }],
    [{ primary: "openai/gpt-4o-mini", arbitrary: true }],
  ])("rejects malformed or ambiguous references: %j", (selection) => {
    expect(() => resolveModelProfileSelection(selection as never, {
      profiles: {},
    })).toThrow(ModelProfileResolutionError);
  });

  it("rejects missing profiles with a typed error", () => {
    expect(() => resolveModelProfileSelection(
      { profile: "missing" },
      { profiles: {} },
    )).toThrowError(expect.objectContaining({
      code: "UNKNOWN_PROFILE",
      profile: "missing",
    }));
  });

  it("rejects direct and indirect cycles with the complete cycle path", () => {
    expect(() => resolveModelProfileSelection(
      { profile: "a" },
      { profiles: { a: { profile: "a" } } },
    )).toThrowError(expect.objectContaining({
      code: "PROFILE_CYCLE",
      path: ["a", "a"],
    }));

    expect(() => resolveModelProfileSelection(
      { profile: "a" },
      {
        profiles: {
          a: { profile: "b" },
          b: { profile: "c" },
          c: { profile: "a" },
        },
      },
    )).toThrowError(expect.objectContaining({
      code: "PROFILE_CYCLE",
      path: ["a", "b", "c", "a"],
    }));
  });

  it("bounds recursive expansion independently from cycle detection", () => {
    expect(() => resolveModelProfileSelection(
      { profile: "a" },
      {
        profiles: {
          a: { profile: "b" },
          b: { profile: "c" },
          c: "openai/gpt-4o-mini",
        },
        maxDepth: 2,
      },
    )).toThrowError(expect.objectContaining({
      code: "PROFILE_DEPTH_EXCEEDED",
    }));
  });

  it("never silently truncates an expanded fallback policy", () => {
    expect(() => resolveModelProfileSelection(
      { profile: "wide" },
      {
        profiles: {
          wide: {
            primary: "model/1",
            fallbacks: ["model/2", "model/3", "model/4"],
          },
        },
        maxFallbacks: 2,
      },
    )).toThrowError(expect.objectContaining({
      code: "TOO_MANY_FALLBACKS",
    }));
  });

  it("profile and model allowlists only narrow what can be selected", () => {
    expect(() => resolveModelProfileSelection(
      { profile: "reasoning" },
      {
        profiles: { reasoning: "anthropic/claude-opus-4" },
        allowedProfiles: ["fast"],
      },
    )).toThrowError(expect.objectContaining({
      code: "DISALLOWED_PROFILE",
      profile: "reasoning",
    }));

    expect(() => resolveModelProfileSelection(
      { profile: "fast" },
      {
        profiles: {
          fast: {
            primary: "openai/gpt-4o-mini",
            fallbacks: ["google/gemini-2.5-flash"],
          },
        },
        allowedProfiles: ["fast", "unused"],
        allowedModels: ["openai/gpt-4o-mini"],
      },
    )).toThrowError(expect.objectContaining({
      code: "DISALLOWED_MODEL",
      model: "google/gemini-2.5-flash",
    }));
  });

  it("keeps nested profile dependencies behind the granted root profile", () => {
    expect(resolveModelProfileSelection(
      { profile: "balanced" },
      {
        profiles: {
          balanced: { profile: "fast" },
          fast: "openai/gpt-4o-mini",
        },
        allowedProfiles: ["balanced"],
      },
    )).toEqual({
      selection: "openai/gpt-4o-mini",
      policy: {
        primary: "openai/gpt-4o-mini",
        fallbacks: [],
        candidates: ["openai/gpt-4o-mini"],
      },
      profiles: ["balanced", "fast"],
    });

    expect(() => resolveModelProfileSelection(
      { profile: "fast" },
      {
        profiles: {
          balanced: { profile: "fast" },
          fast: "openai/gpt-4o-mini",
        },
        allowedProfiles: ["balanced"],
      },
    )).toThrowError(expect.objectContaining({
      code: "DISALLOWED_PROFILE",
      profile: "fast",
    }));
  });

  it("validates every explicitly selected root profile in a model policy", () => {
    expect(() => resolveModelProfileSelection(
      {
        primary: { profile: "balanced" },
        fallbacks: [{ profile: "emergency" }],
      },
      {
        profiles: {
          balanced: { profile: "fast" },
          fast: "openai/gpt-4o-mini",
          emergency: "google/gemini-2.5-flash",
        },
        allowedProfiles: ["balanced"],
      },
    )).toThrowError(expect.objectContaining({
      code: "DISALLOWED_PROFILE",
      profile: "emergency",
    }));
  });

  it("does not mutate inputs and freezes the complete resolution result", () => {
    const selection = {
      primary: { profile: "fast" as const },
      fallbacks: ["local/qwen"],
    };
    const profiles = {
      fast: "openai/gpt-4o-mini",
    };
    const selectionBefore = structuredClone(selection);
    const profilesBefore = structuredClone(profiles);

    const result = resolveModelProfileSelection(selection, { profiles });

    expect(selection).toEqual(selectionBefore);
    expect(profiles).toEqual(profilesBefore);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.policy)).toBe(true);
    expect(Object.isFrozen(result.policy.candidates)).toBe(true);
    expect(Object.isFrozen(result.profiles)).toBe(true);
  });

  it("schema validation fails closed for ambiguous structured selections", () => {
    expect(modelSelectionSchema.safeParse({
      profile: "fast",
      primary: "openai/gpt-4o-mini",
    }).success).toBe(false);
    expect(modelSelectionSchema.safeParse({
      primary: "openai/gpt-4o-mini",
      arbitrary: true,
    }).success).toBe(false);
    expect(modelProfileRegistrySchema.safeParse({
      fast: {
        profile: "balanced",
        fallbacks: ["openai/gpt-4o-mini"],
      },
    }).success).toBe(false);
  });
});
