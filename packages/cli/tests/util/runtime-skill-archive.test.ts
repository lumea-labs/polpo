import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unpackSkillArchive } from "@polpo-ai/core/skill-archive";
import { packLocalSkillBundle, writeLocalSkillArchive } from "../../src/util/runtime-skill-bundle.js";
import { withRuntimeSkillSource } from "../../src/util/runtime-skill-source.js";

const temporary: string[] = [];

function temp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "polpo-skill-test-"));
  temporary.push(directory);
  return directory;
}

function fixture(root: string): string {
  const skill = path.join(root, "portable-skill");
  fs.mkdirSync(path.join(skill, "assets"), { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: portable-skill\ndescription: Portable\n---\n\nUse it.");
  fs.writeFileSync(path.join(skill, "assets", "data.bin"), Buffer.from([0, 1, 2, 255]));
  return skill;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("runtime skill archives", () => {
  it("packs a deterministic portable archive", async () => {
    const skill = fixture(temp());
    const first = await packLocalSkillBundle(skill);
    const second = await packLocalSkillBundle(skill);

    expect(first).toEqual(second);
    await expect(unpackSkillArchive(first)).resolves.toMatchObject({
      bundle: { name: "portable-skill" },
    });
  });

  it("uses a local .skill archive as one add source and cleans its checkout", async () => {
    const root = temp();
    const skill = fixture(root);
    const archive = path.join(root, "portable-skill.skill");
    await writeLocalSkillArchive(skill, archive);
    const checkouts: string[] = [];

    const result = await withRuntimeSkillSource(archive, root, async (checkout) => {
      checkouts.push(checkout.root);
      expect(checkout.archive).toBe(true);
      expect(checkout.revision).toMatch(/^sha256:/);
      expect(fs.readFileSync(path.join(checkout.root, "assets", "data.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
      return checkout.source;
    }, { temporaryRoot: root });

    expect(result).toBe(archive);
    expect(checkouts).toHaveLength(1);
    expect(fs.existsSync(checkouts[0])).toBe(false);
  });
});
