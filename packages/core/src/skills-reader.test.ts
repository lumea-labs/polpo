import { describe, expect, it } from "vitest";
import {
  buildSkillPrompt,
  normalizeSkillResourcePath,
  readSkillResource,
  SkillResourceError,
  type LoadedSkill,
} from "./skills-reader.js";
import type { FileSystem } from "./filesystem.js";

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

describe("skill bundle resource reading", () => {
  const skill: LoadedSkill = {
    name: "frontend-design",
    description: "Build polished interfaces",
    source: "project",
    path: "/project/.polpo/skills/frontend-design",
    content: "Cached body",
  };

  function createFs(files: Record<string, string>, directories: string[] = []): FileSystem {
    const fileMap = new Map(Object.entries(files));
    const directorySet = new Set(directories);
    return {
      exists: async (path: string) => fileMap.has(path) || directorySet.has(path),
      stat: async (path: string) => ({
        size: fileMap.get(path)?.length ?? 0,
        isFile: fileMap.has(path),
        isDirectory: directorySet.has(path),
      }),
      readFile: async (path: string) => {
        const value = fileMap.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return value;
      },
    } as unknown as FileSystem;
  }

  it("reads the SKILL.md body when path is omitted", async () => {
    const fs = createFs({
      "/project/.polpo/skills/frontend-design/SKILL.md": [
        "---",
        "name: frontend-design",
        "description: Build polished interfaces",
        "---",
        "# Runtime instructions",
      ].join("\n"),
    });

    await expect(readSkillResource(fs, skill)).resolves.toEqual({
      path: "SKILL.md",
      content: "# Runtime instructions",
    });
  });

  it("reads nested references relative to the same skill bundle", async () => {
    const fs = createFs({
      "/project/.polpo/skills/frontend-design/references/design-system.md": "Use the project tokens.",
    });

    await expect(
      readSkillResource(fs, skill, "references/design-system.md"),
    ).resolves.toEqual({
      path: "references/design-system.md",
      content: "Use the project tokens.",
    });
  });

  it.each([
    "",
    "/etc/passwd",
    "../secrets.md",
    "references/../../secrets.md",
    "references//design-system.md",
    "references/./design-system.md",
    "references\\design-system.md",
    "references/design-system.md\0ignored",
  ])("rejects an unsafe resource path: %j", (path) => {
    expect(() => normalizeSkillResourcePath(path)).toThrow(SkillResourceError);
  });

  it("fails deterministically when a resource is absent", async () => {
    const fs = createFs({});

    await expect(readSkillResource(fs, skill, "references/missing.md")).rejects.toMatchObject({
      name: "SkillResourceError",
      code: "not_found",
      message: 'Skill resource "references/missing.md" was not found',
    });
  });

  it("refuses directories as model-readable resources", async () => {
    const path = "/project/.polpo/skills/frontend-design/references";
    const fs = createFs({}, [path]);

    await expect(readSkillResource(fs, skill, "references")).rejects.toMatchObject({
      code: "not_a_file",
    });
  });

  it("does not leak the physical skill root when the filesystem read fails", async () => {
    const target = "/project/.polpo/skills/frontend-design/references/private.md";
    const fs = {
      exists: async () => true,
      stat: async () => ({ size: 10, isFile: true, isDirectory: false }),
      readFile: async () => { throw new Error(`EACCES: ${target}`); },
    } as unknown as FileSystem;

    await expect(readSkillResource(fs, skill, "references/private.md")).rejects.toMatchObject({
      code: "read_failed",
      message: 'Skill resource "references/private.md" could not be read',
    });
  });
});
