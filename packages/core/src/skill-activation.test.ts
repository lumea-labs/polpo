import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVATED_SKILLS,
  normalizeActivatedSkillReferences,
  normalizeActivatedSkills,
  requireAssignedActivatedSkills,
} from "./skill-activation.js";

describe("skill activation", () => {
  it("normalizes a bounded additive selection", () => {
    expect(normalizeActivatedSkills([" frontend-design ", "testing"])).toEqual([
      "frontend-design",
      "testing",
    ]);
    expect(normalizeActivatedSkills(undefined)).toBeUndefined();
  });

  it.each([
    { skills: [] },
    { skills: [""] },
    { skills: ["frontend-design", " frontend-design "] },
    { skills: Array.from({ length: MAX_ACTIVATED_SKILLS + 1 }, (_, index) => `skill-${index}`) },
    { skills: [42] },
  ])("rejects an invalid selection: $skills", ({ skills }) => {
    expect(() => normalizeActivatedSkills(skills)).toThrow();
  });

  it("rejects activation of a skill not assigned to the agent", () => {
    expect(() => requireAssignedActivatedSkills(
      ["security-review"],
      ["frontend-design"],
    )).toThrow(/not assigned/i);
    expect(requireAssignedActivatedSkills(
      ["frontend-design"],
      ["frontend-design", "testing"],
    )).toEqual(["frontend-design"]);
  });

  it("normalizes immutable activation references used by checkpoints", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(normalizeActivatedSkillReferences([
      { name: "frontend-design", digest },
      { name: "legacy-skill" },
    ])).toEqual([
      { name: "frontend-design", digest },
      { name: "legacy-skill" },
    ]);
  });

  it.each([
    { references: [{ name: "frontend-design", digest: "sha256:bad" }] },
    { references: [{ name: "" }] },
    { references: [{ name: "frontend-design" }, { name: "frontend-design" }] },
    { references: ["frontend-design"] },
  ])("rejects malformed immutable activation references: $references", ({ references }) => {
    expect(() => normalizeActivatedSkillReferences(references)).toThrow();
  });
});
