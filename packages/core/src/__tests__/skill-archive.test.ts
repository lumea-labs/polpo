import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  packSkillArchive,
  SkillArchiveError,
  unpackSkillArchive,
} from "../skill-archive.js";

const skill = [
  "---",
  "name: site-audit",
  "description: Audit a generated site",
  "---",
  "Run the bundled audit script.",
].join("\n");

describe("Agent Skills archives", () => {
  it.each(["root", "directory"] as const)("imports the supported %s layout", async (layout) => {
    const prefix = layout === "directory" ? "site-audit/" : "";
    const bytes = zipSync({
      [`${prefix}SKILL.md`]: strToU8(skill),
      [`${prefix}scripts/audit.mjs`]: strToU8("console.log('ok')"),
      [`${prefix}assets/template.bin`]: new Uint8Array([0, 1, 2, 255]),
    });

    const imported = await unpackSkillArchive(bytes);

    expect(imported.bundle.name).toBe("site-audit");
    expect(imported.bundle.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/template.bin",
      "scripts/audit.mjs",
    ]);
    expect(imported.digest).toMatch(/^sha256:/);
    expect(imported.uncompressedBytes).toBeGreaterThan(skill.length);
  });

  it("exports a deterministic archive with one top-level directory", async () => {
    const imported = await unpackSkillArchive(zipSync({
      "SKILL.md": strToU8(skill),
      "assets/template.bin": new Uint8Array([0, 1, 2, 255]),
    }));

    const first = await packSkillArchive(imported.bundle);
    const second = await packSkillArchive({
      ...imported.bundle,
      files: [...imported.bundle.files].reverse(),
    });

    expect(first).toEqual(second);
    await expect(unpackSkillArchive(first)).resolves.toMatchObject({ digest: imported.digest });
  });

  it.each([
    ["two roots", { "one/SKILL.md": strToU8(skill), "two/SKILL.md": strToU8(skill) }],
    ["root junk", { "site-audit/SKILL.md": strToU8(skill), "README.md": strToU8("junk") }],
    ["traversal", { "site-audit/SKILL.md": strToU8(skill), "site-audit/../escape": strToU8("bad") }],
    ["case collision", { "SKILL.md": strToU8(skill), "A.txt": strToU8("a"), "a.txt": strToU8("b") }],
  ])("rejects %s archives", async (_label, entries) => {
    await expect(unpackSkillArchive(zipSync(entries))).rejects.toBeInstanceOf(SkillArchiveError);
  });

  it("rejects encrypted and symlink entries during central-directory preflight", async () => {
    const archive = zipSync({ "SKILL.md": strToU8(skill) });
    const encrypted = archive.slice();
    const central = findSignature(encrypted, 0x02014b50);
    encrypted[central + 8] |= 1;
    const symlink = archive.slice();
    const symlinkCentral = findSignature(symlink, 0x02014b50);
    symlink[symlinkCentral + 5] = 3;
    const mode = 0o120777 << 16;
    new DataView(symlink.buffer, symlink.byteOffset).setUint32(symlinkCentral + 38, mode >>> 0, true);

    await expect(unpackSkillArchive(encrypted)).rejects.toMatchObject({ code: "encrypted_entry" });
    await expect(unpackSkillArchive(symlink)).rejects.toMatchObject({ code: "unsupported_entry" });
  });
});

function findSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error("ZIP signature not found");
}
