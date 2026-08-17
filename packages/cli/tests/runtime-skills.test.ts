import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assignRuntimeSkills,
  discoverRuntimeSkills,
  installRuntimeSkills,
  listLocalRuntimeSkills,
  readRuntimeSkillsLock,
  removeRuntimeSkill,
  unassignRuntimeSkills,
} from "../src/util/runtime-skills.js";
import { withRuntimeSkillSource } from "../src/util/runtime-skill-source.js";

let root: string;
let projectDir: string;
let sourceDir: string;

function write(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function skillMarkdown(name: string, description = `${name} description`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nUse the bundled resources.\n`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "polpo-runtime-skills-test-"));
  projectDir = path.join(root, "project");
  sourceDir = path.join(root, "source");
  write(path.join(projectDir, ".polpo", "project.json"), "{}\n");
  write(path.join(projectDir, ".polpo", "agents", "builder", "agent.json"), "{}\n");
  write(path.join(projectDir, ".polpo", "agents", "builder", "instructions.md"), "Build things.\n");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("runtime skill management", () => {
  it("discovers complete bundles and installs every resource binary-safely", () => {
    const skillDir = path.join(sourceDir, "skills", "frontend-design");
    write(path.join(skillDir, "SKILL.md"), skillMarkdown("frontend-design"));
    write(path.join(skillDir, "references", "guide.md"), "# Guide\n");
    write(path.join(skillDir, "scripts", "audit.mjs"), "export default true;\n");
    write(path.join(skillDir, "assets", "palette.bin"), Buffer.from([0, 1, 2, 255]));

    const discovered = discoverRuntimeSkills(sourceDir);
    expect(discovered.map((skill) => skill.name)).toEqual(["frontend-design"]);
    const result = installRuntimeSkills({
      projectDir,
      skills: discovered,
      source: "owner/repository",
      revision: "abc123",
      agents: ["builder"],
      now: () => new Date("2026-08-17T10:00:00.000Z"),
    });

    expect(result.installed).toEqual(["frontend-design"]);
    expect(result.assigned).toEqual([{ agent: "builder", skill: "frontend-design" }]);
    expect(fs.readFileSync(
      path.join(projectDir, ".polpo", "skills", "frontend-design", "assets", "palette.bin"),
    )).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(JSON.parse(fs.readFileSync(
      path.join(projectDir, ".polpo", "agents", "builder", "agent.json"),
      "utf-8",
    )).skills).toEqual(["frontend-design"]);
    expect(readRuntimeSkillsLock(projectDir).skills["frontend-design"]).toMatchObject({
      source: "owner/repository",
      sourceSkill: "frontend-design",
      revision: "abc123",
      installedAt: "2026-08-17T10:00:00.000Z",
    });
  });

  it("does not replace a changed local bundle without --force", () => {
    const skillDir = path.join(sourceDir, "frontend-design");
    write(path.join(skillDir, "SKILL.md"), skillMarkdown("frontend-design", "Upstream"));
    const discovered = discoverRuntimeSkills(sourceDir);
    installRuntimeSkills({ projectDir, skills: discovered, source: sourceDir });
    write(
      path.join(projectDir, ".polpo", "skills", "frontend-design", "SKILL.md"),
      skillMarkdown("frontend-design", "Local edit"),
    );

    const result = installRuntimeSkills({ projectDir, skills: discovered, source: sourceDir });

    expect(result.skipped).toEqual(["frontend-design"]);
    expect(fs.readFileSync(
      path.join(projectDir, ".polpo", "skills", "frontend-design", "SKILL.md"),
      "utf-8",
    )).toContain("Local edit");
  });

  it("validates all requested agents before writing a bundle", () => {
    const skillDir = path.join(sourceDir, "frontend-design");
    write(path.join(skillDir, "SKILL.md"), skillMarkdown("frontend-design"));

    expect(() => installRuntimeSkills({
      projectDir,
      skills: discoverRuntimeSkills(sourceDir),
      source: sourceDir,
      agents: ["missing"],
    })).toThrow("Unknown agent: missing");
    expect(fs.existsSync(path.join(projectDir, ".polpo", "skills", "frontend-design"))).toBe(false);
  });

  it("assigns, unassigns, lists, and removes skills consistently", () => {
    const skillDir = path.join(sourceDir, "research");
    write(path.join(skillDir, "SKILL.md"), skillMarkdown("research"));
    installRuntimeSkills({ projectDir, skills: discoverRuntimeSkills(sourceDir), source: sourceDir });

    expect(assignRuntimeSkills(projectDir, ["research"], ["builder"])).toHaveLength(1);
    expect(listLocalRuntimeSkills(projectDir)[0]).toMatchObject({
      name: "research",
      assignedTo: ["builder"],
      locked: true,
    });
    expect(unassignRuntimeSkills(projectDir, ["research"], ["builder"])).toHaveLength(1);
    expect(removeRuntimeSkill(projectDir, "research")).toBe(true);
    expect(listLocalRuntimeSkills(projectDir)).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, ".polpo", "skills.lock.json"))).toBe(false);
  });

  it("rejects duplicate skill names before installation", () => {
    write(path.join(sourceDir, "one", "SKILL.md"), skillMarkdown("duplicate"));
    write(path.join(sourceDir, "two", "SKILL.md"), skillMarkdown("duplicate"));
    expect(() => discoverRuntimeSkills(sourceDir)).toThrow('Duplicate skill name "duplicate"');
  });
});

describe("runtime skill sources", () => {
  it("uses local sources directly without invoking git", async () => {
    fs.mkdirSync(sourceDir, { recursive: true });
    let invoked = false;
    const result = await withRuntimeSkillSource(
      sourceDir,
      projectDir,
      async (checkout) => checkout,
      { execFile: (() => { invoked = true; }) as never },
    );
    expect(result).toMatchObject({ root: sourceDir, source: sourceDir, remote: false });
    expect(invoked).toBe(false);
  });

  it("clones owner/repository without a shell and always cleans the checkout", async () => {
    const temporaryRoot = path.join(root, "tmp");
    fs.mkdirSync(temporaryRoot);
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const execFile = ((executable: string, args: readonly string[]) => {
      calls.push({ executable, args });
      if (args[0] === "clone") {
        const checkout = args.at(-1)!;
        write(path.join(checkout, "SKILL.md"), skillMarkdown("remote-skill"));
        return Buffer.alloc(0);
      }
      return "0123456789abcdef\n";
    }) as never;

    const checkoutRoot = await withRuntimeSkillSource(
      "owner/repository",
      projectDir,
      async (checkout) => {
        expect(fs.existsSync(path.join(checkout.root, "SKILL.md"))).toBe(true);
        expect(checkout.revision).toBe("0123456789abcdef");
        return checkout.root;
      },
      { execFile, temporaryRoot },
    );

    expect(calls[0]).toMatchObject({
      executable: "git",
      args: ["clone", "--depth", "1", "--quiet", "https://github.com/owner/repository.git", expect.any(String)],
    });
    expect(fs.existsSync(checkoutRoot)).toBe(false);
  });

  it("rejects an invalid remote source before invoking git", async () => {
    let invoked = false;
    await expect(withRuntimeSkillSource(
      "owner/repo; rm -rf /",
      projectDir,
      async () => undefined,
      { execFile: (() => { invoked = true; }) as never, temporaryRoot: root },
    )).rejects.toThrow("Skill source must be");
    expect(invoked).toBe(false);
  });
});
