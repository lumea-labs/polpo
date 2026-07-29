import { describe, expect, it } from "vitest";
import {
  modelSelectionLabel,
  modelSelectionPrimary,
  parseModelSelectionInput,
} from "./model-selection.js";

describe("dashboard model selection formatting", () => {
  it("keeps legacy model ids unchanged", () => {
    expect(modelSelectionPrimary("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
    expect(modelSelectionLabel("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
    expect(parseModelSelectionInput(" openai/gpt-4o-mini ")).toBe("openai/gpt-4o-mini");
  });

  it("round-trips explicit profile references", () => {
    const profile = { profile: "balanced" };
    expect(modelSelectionPrimary(profile)).toBe("profile:balanced");
    expect(modelSelectionLabel(profile)).toBe("balanced (profile)");
    expect(parseModelSelectionInput(" profile:balanced ")).toEqual(profile);
  });

  it("labels profiled policies without losing fallback information", () => {
    const policy = {
      primary: { profile: "balanced" },
      fallbacks: ["openai/gpt-4o-mini", { profile: "emergency" }],
    };
    expect(modelSelectionPrimary(policy)).toBe("profile:balanced");
    expect(modelSelectionLabel(policy)).toBe("balanced (profile) +2");
  });

  it("treats empty input as no selection", () => {
    expect(parseModelSelectionInput("   ")).toBeUndefined();
  });
});
