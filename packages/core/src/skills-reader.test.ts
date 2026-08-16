import { describe, expect, it } from "vitest";
import { buildSkillPrompt, type LoadedSkill } from "./skills-reader.js";

const skills: LoadedSkill[] = [
  {
    name: "frontend-design",
    description: "Build polished interfaces.",
    content: "Use the established design system.",
    source: "project",
    path: "/skills/frontend-design",
  },
  {
    name: "accessibility-audit",
    description: "Audit accessibility.",
    content: "Check keyboard and screen-reader behavior.",
    source: "project",
    path: "/skills/accessibility-audit",
  },
];

describe("buildSkillPrompt", () => {
  it("prioritizes explicitly activated skills without removing assigned skills", () => {
    const prompt = buildSkillPrompt(skills, {
      activatedSkills: ["accessibility-audit"],
    });

    expect(prompt).toContain(
      "The following assigned skill is explicitly activated for this execution: `accessibility-audit`.",
    );
    expect(prompt.indexOf("### accessibility-audit")).toBeLessThan(
      prompt.indexOf("### frontend-design"),
    );
    expect(prompt).toContain("### frontend-design");
    expect(prompt.match(/Check keyboard and screen-reader behavior\./g)).toHaveLength(1);
  });

  it("ignores activation names that are not present in the loaded skill set", () => {
    const prompt = buildSkillPrompt(skills, {
      activatedSkills: ["not-assigned"],
    });

    expect(prompt).not.toContain("explicitly activated");
    expect(prompt).toContain("### frontend-design");
    expect(prompt).toContain("### accessibility-audit");
  });
});
