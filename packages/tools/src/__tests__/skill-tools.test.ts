import { describe, expect, it, vi } from "vitest";
import type { FileSystem, LoadedSkill, PolpoTool } from "@polpo-ai/core";
import { createSkillTools } from "../skill-tools.js";

const skillRoot = "/project/.polpo/skills/sitoinchat-site-runtime";
const skill: LoadedSkill = {
  name: "sitoinchat-site-runtime",
  description: "Build and validate SitoInChat sites",
  source: "project",
  path: skillRoot,
  content: "Cached instructions",
  tags: ["sites"],
  category: "coding",
};

function createFs(files: Record<string, string>): FileSystem {
  const fileMap = new Map(Object.entries(files));
  return {
    exists: async (path: string) => fileMap.has(path),
    stat: async (path: string) => ({
      size: fileMap.get(path)?.length ?? 0,
      isFile: fileMap.has(path),
      isDirectory: false,
    }),
    readFile: async (path: string) => {
      const value = fileMap.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
  } as unknown as FileSystem;
}

function pick(tools: PolpoTool<any>[], name: string): PolpoTool<any> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} was not created`);
  return tool;
}

function firstText(result: any): string {
  return result.content[0].text;
}

describe("runtime skill tools", () => {
  it("keeps skill_list compact and free of bundle paths or content", async () => {
    const tools = createSkillTools(createFs({}), [skill]);
    const result = await pick(tools, "skill_list").execute("call-1", {});
    const payload = firstText(result);

    expect(payload).toContain("sitoinchat-site-runtime");
    expect(payload).toContain("Build and validate SitoInChat sites");
    expect(payload).not.toContain(skillRoot);
    expect(payload).not.toContain("Cached instructions");
  });

  it("reads SKILL.md by default and strips its frontmatter", async () => {
    const fs = createFs({
      [`${skillRoot}/SKILL.md`]: [
        "---",
        "name: sitoinchat-site-runtime",
        "description: Build and validate SitoInChat sites",
        "---",
        "Read references/design-system.md before editing.",
      ].join("\n"),
    });
    const result = await pick(createSkillTools(fs, [skill]), "skill_read")
      .execute("call-1", { name: skill.name });

    expect(firstText(result)).toContain("Resource: SKILL.md");
    expect(firstText(result)).toContain("Read references/design-system.md before editing.");
    expect(firstText(result)).not.toContain("description:");
    expect(result.details).toMatchObject({ ok: true, skill: skill.name, path: "SKILL.md" });
  });

  it("reads a nested reference relative to the selected bundle", async () => {
    const fs = createFs({
      [`${skillRoot}/references/design-system.md`]: "Use semantic color tokens.",
    });
    const result = await pick(createSkillTools(fs, [skill]), "skill_read")
      .execute("call-1", {
        name: skill.name,
        path: "references/design-system.md",
      });

    expect(firstText(result)).toContain("Resource: references/design-system.md");
    expect(firstText(result)).toContain("Use semantic color tokens.");
    expect(firstText(result)).not.toContain(skillRoot);
  });

  it("fails closed when the skill is not assigned", async () => {
    const readFile = vi.fn(async () => "secret");
    const fs = {
      exists: vi.fn(async () => true),
      stat: vi.fn(async () => ({ size: 6, isFile: true, isDirectory: false })),
      readFile,
    } as unknown as FileSystem;
    const result = await pick(createSkillTools(fs, [skill]), "skill_read")
      .execute("call-1", { name: "other-skill", path: "references/private.md" });

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "skill_not_assigned" },
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    "../secrets.md",
    "/etc/passwd",
    "references/../../secrets.md",
    "references\\private.md",
  ])("returns a deterministic error for unsafe paths: %s", async (path) => {
    const result = await pick(createSkillTools(createFs({}), [skill]), "skill_read")
      .execute("call-1", { name: skill.name, path });

    expect(result.details).toMatchObject({
      ok: false,
      skill: skill.name,
      error: { code: "invalid_path" },
    });
    expect(firstText(result)).not.toContain(skillRoot);
  });

  it("does not expose physical paths when a bundled resource is missing", async () => {
    const result = await pick(createSkillTools(createFs({}), [skill]), "skill_read")
      .execute("call-1", { name: skill.name, path: "references/missing.md" });

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(firstText(result)).not.toContain(skillRoot);
  });
});
