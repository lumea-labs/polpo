import { describe, expect, it } from "vitest";
import { validateSkillBundleFiles } from "../skill-bundle.js";

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
});
