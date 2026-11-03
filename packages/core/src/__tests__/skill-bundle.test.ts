import { describe, expect, it } from "vitest";
import {
  SKILL_BUNDLE_MAX_TOTAL_BYTES,
  digestSkillBundle,
  validateSkillBundleFiles,
  validateSkillName,
} from "../skill-bundle.js";

const skillFile = {
  path: "SKILL.md",
  content: Buffer.from("---\nname: test\ndescription: Test\n---\n").toString("base64"),
  encoding: "base64" as const,
};

describe("validateSkillBundleFiles", () => {
  it("accepts nested binary-safe files", () => {
    expect(validateSkillBundleFiles([
      skillFile,
      { path: "assets/data.bin", content: "AAEC/w==", encoding: "base64" },
    ])).toBeNull();
  });

  it.each(["../escape", "a/../escape", "/absolute", "a\\b", "a//b", "./SKILL.md"])(
    "rejects unsafe path %s",
    (filePath) => {
      expect(validateSkillBundleFiles([
        skillFile,
        { path: filePath, content: "", encoding: "base64" },
      ])).toMatch(/Invalid skill bundle path/);
    },
  );

  it("rejects duplicate paths and malformed base64", () => {
    expect(validateSkillBundleFiles([skillFile, skillFile])).toMatch(/Duplicate/);
    expect(validateSkillBundleFiles([
      skillFile,
      { path: "asset.bin", content: "not-base64", encoding: "base64" },
    ])).toMatch(/Invalid base64/);
  });

  it("rejects case-folding path collisions", () => {
    expect(validateSkillBundleFiles([
      skillFile,
      { path: "references/Guide.md", content: "", encoding: "base64" },
      { path: "references/guide.md", content: "", encoding: "base64" },
    ])).toMatch(/case-insensitive collision/i);
  });

  it("uses the portable Agent Skills limits", () => {
    expect(SKILL_BUNDLE_MAX_TOTAL_BYTES).toBe(30 * 1024 * 1024);
    expect(validateSkillName("frontend-design")).toBeNull();
    expect(validateSkillName("Frontend_Design")).toMatch(/lowercase letters/);
    expect(validateSkillName("double--hyphen")).toMatch(/consecutive hyphens/);
    expect(validateSkillName("x".repeat(65))).toMatch(/64/);
  });

  it("computes one canonical digest independent of file order", async () => {
    const asset = { path: "assets/data.bin", content: "AAEC/w==", encoding: "base64" as const };
    const first = await digestSkillBundle({ name: "test", files: [skillFile, asset] });
    const second = await digestSkillBundle({ name: "test", files: [asset, skillFile] });

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });
});
