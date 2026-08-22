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
  const directories = new Set<string>();
  for (const path of fileMap.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/") || "/");
    }
  }
  const entries = (path: string) => {
    const prefix = `${path.replace(/\/$/, "")}/`;
    const names = [...new Set(
      [...fileMap.keys(), ...directories]
        .filter((candidate) => candidate.startsWith(prefix))
        .map((candidate) => candidate.slice(prefix.length).split("/")[0])
        .filter(Boolean),
    )];
    return names.map((name) => {
      const candidate = `${path.replace(/\/$/, "")}/${name}`;
      return {
        name,
        isFile: fileMap.has(candidate),
        isDirectory: directories.has(candidate),
      };
    });
  };
  return {
    exists: async (path: string) => fileMap.has(path) || directories.has(path),
    stat: async (path: string) => ({
      size: fileMap.get(path)?.length ?? 0,
      isFile: fileMap.has(path),
      isDirectory: directories.has(path),
    }),
    readdir: async (path: string) => entries(path).map((entry) => entry.name),
    readdirWithTypes: async (path: string) => entries(path),
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

  it("reads SKILL.md and assembles nested textual references by default", async () => {
    const fs = createFs({
      [`${skillRoot}/SKILL.md`]: [
        "---",
        "name: sitoinchat-site-runtime",
        "description: Build and validate SitoInChat sites",
        "---",
        "Read references/design-system.md before editing.",
      ].join("\n"),
      [`${skillRoot}/references/design-system.md`]: "Use semantic color tokens.",
      [`${skillRoot}/references/platform/scaffold.md`]: "Use the platform scaffold.",
    });
    const result = await pick(createSkillTools(fs, [skill]), "skill_read")
      .execute("call-1", { name: skill.name });

    expect(firstText(result)).toContain("Resource: SKILL.md");
    expect(firstText(result)).toContain("Read references/design-system.md before editing.");
    expect(firstText(result)).toContain("Bundled references (already loaded)");
    expect(firstText(result)).toContain("Resource: references/design-system.md");
    expect(firstText(result)).toContain("Use semantic color tokens.");
    expect(firstText(result)).toContain("Resource: references/platform/scaffold.md");
    expect(firstText(result)).toContain("Use the platform scaffold.");
    expect(firstText(result)).not.toContain("description:");
    expect(result.details).toMatchObject({
      ok: true,
      skill: skill.name,
      entrypoint: "SKILL.md",
      references: [
        { path: "references/design-system.md", loaded: true },
        { path: "references/platform/scaffold.md", loaded: true },
      ],
      omitted: [],
    });
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
    expect(firstText(result)).not.toContain("Bundled references (already loaded)");
    expect(result.details).toMatchObject({ ok: true, skill: skill.name, path: "references/design-system.md" });
  });

  it("keeps the entrypoint usable when the bundle has no references directory", async () => {
    const fs = createFs({
      [`${skillRoot}/SKILL.md`]: "Only the main instructions.",
    });
    const result = await pick(createSkillTools(fs, [skill]), "skill_read")
      .execute("call-1", { name: skill.name });

    expect(firstText(result)).toContain("Only the main instructions.");
    expect(firstText(result)).not.toContain("Bundled references (already loaded)");
    expect(result.details).toMatchObject({ references: [], omitted: [] });
  });

  it("omits binary-looking references without failing the skill", async () => {
    const fs = createFs({
      [`${skillRoot}/SKILL.md`]: "Use the bundled reference.",
      [`${skillRoot}/references/logo.bin`]: "\u0000\u0001binary",
      [`${skillRoot}/references/guide.md`]: "Readable guidance.",
    });
    const result = await pick(createSkillTools(fs, [skill]), "skill_read")
      .execute("call-1", { name: skill.name });

    expect(firstText(result)).toContain("Readable guidance.");
    expect(firstText(result)).not.toContain("Resource: references/logo.bin");
    expect(result.details).toMatchObject({
      references: [{ path: "references/guide.md", loaded: true }],
      omitted: [{ path: "references/logo.bin", reason: "binary" }],
    });
  });

  it("applies a deterministic reference budget and reports omitted files", async () => {
    const fs = createFs({
      [`${skillRoot}/SKILL.md`]: "Use references/a.md and references/b.md.",
      [`${skillRoot}/references/a.md`]: "12345",
      [`${skillRoot}/references/b.md`]: "67890",
    });
    const result = await pick(createSkillTools(fs, [skill], { maxAutoReferenceBytes: 5 }), "skill_read")
      .execute("call-1", { name: skill.name });

    expect(firstText(result)).toContain("Resource: references/a.md");
    expect(firstText(result)).not.toContain("Resource: references/b.md");
    expect(firstText(result)).toContain("Additional bundled resources");
    expect(result.details).toMatchObject({
      references: [{ path: "references/a.md", loaded: true, bytes: 5 }],
      omitted: [{ path: "references/b.md", reason: "budget_exceeded" }],
    });
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
