import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  builtInToolRequiresSandbox,
  withBuiltInToolRuntimeRequirements,
} from "../runtime-requirements.js";

describe("tool runtime requirements", () => {
  it.each([
    "read",
    "bash",
    "http_download",
    "browser_click",
    "image_generate",
    "audio_transcribe",
    "excel_read",
    "pdf_create",
    "docx_read",
    "email_download_attachment",
  ])("marks %s as sandbox-required", (name) => {
    expect(builtInToolRequiresSandbox(name)).toBe(true);
  });

  it.each([
    "http_fetch",
    "search_web",
    "memory_get",
    "brain_search",
    "vault_get",
    "email_list",
    "email_send",
    "mcp__docs__search",
  ])("does not overstate the requirement for %s", (name) => {
    expect(builtInToolRequiresSandbox(name)).toBe(false);
  });

  it("adds explicit metadata without mutating the source tool", () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "Run a command",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    };

    const annotated = withBuiltInToolRuntimeRequirements(tool);

    expect(annotated.requiresSandbox).toBe(true);
    expect(tool).not.toHaveProperty("requiresSandbox");
  });
});
