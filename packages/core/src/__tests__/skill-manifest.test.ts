import { describe, expect, it } from "vitest";
import {
  parseSkillManifest,
  SkillManifestValidationError,
} from "../skill-manifest.js";

describe("parseSkillManifest", () => {
  it("parses the standard Agent Skills frontmatter", () => {
    const result = parseSkillManifest([
      "---",
      "name: frontend-design",
      "description: >-",
      "  Build polished interfaces",
      "  with the project design system.",
      "license: Apache-2.0",
      "compatibility: Requires a sandbox shell",
      "allowed-tools: Read Bash",
      "metadata:",
      "  author: Polpo",
      "  version: '1'",
      "---",
      "# Instructions",
    ].join("\n"), { mode: "strict", directoryName: "frontend-design" });

    expect(result.manifest).toEqual({
      name: "frontend-design",
      description: "Build polished interfaces with the project design system.",
      license: "Apache-2.0",
      compatibility: "Requires a sandbox shell",
      allowedTools: ["Read", "Bash"],
      metadata: { author: "Polpo", version: "1" },
    });
    expect(result.body).toBe("# Instructions");
    expect(result.diagnostics).toEqual([]);
  });

  it("accepts the legacy allowed-tools array in compatibility mode", () => {
    const result = parseSkillManifest([
      "---",
      "name: legacy-skill",
      "description: Legacy",
      "allowed-tools:",
      "  - Read",
      "  - Bash",
      "---",
    ].join("\n"), { mode: "compatibility", directoryName: "legacy-skill" });

    expect(result.manifest.allowedTools).toEqual(["Read", "Bash"]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "legacy_allowed_tools_array" }));
  });

  it.each([
    ["Uppercase", "description: Test", "invalid_name"],
    ["wrong-name", "description: Test", "name_mismatch"],
    ["valid-name", "description: ''", "invalid_description"],
  ])("rejects invalid strict manifest %#", (name, description, code) => {
    expect(() => parseSkillManifest([
      "---",
      `name: ${name}`,
      description,
      "---",
    ].join("\n"), { mode: "strict", directoryName: "valid-name" }))
      .toThrow(expect.objectContaining<Partial<SkillManifestValidationError>>({ code }));
  });

  it("rejects unknown fields, YAML aliases and non-string metadata", () => {
    for (const frontmatter of [
      "name: valid-name\ndescription: Test\ncustom: true",
      "name: valid-name\ndescription: &copy Test\nlicense: *copy",
      "name: valid-name\ndescription: Test\nmetadata:\n  nested:\n    no: true",
    ]) {
      expect(() => parseSkillManifest(`---\n${frontmatter}\n---\n`, {
        mode: "strict",
        directoryName: "valid-name",
      })).toThrow(SkillManifestValidationError);
    }
  });
});
