import type { PolpoTool } from "@polpo-ai/core";

const SANDBOX_REQUIRED_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "glob",
  "grep",
  "ls",
  "http_download",
  "email_download_attachment",
]);

const SANDBOX_REQUIRED_PREFIXES = [
  "browser_",
  "image_",
  "video_",
  "audio_",
  "excel_",
  "pdf_",
  "docx_",
];

/**
 * Return true only when every valid invocation needs the runtime sandbox.
 * Conditional users (for example email attachments) remain false so the UI
 * does not claim that a sandbox is always acquired.
 */
export function builtInToolRequiresSandbox(name: string): boolean {
  return SANDBOX_REQUIRED_NAMES.has(name)
    || SANDBOX_REQUIRED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function withBuiltInToolRuntimeRequirements<T extends PolpoTool>(
  tool: T,
): T & { requiresSandbox: boolean } {
  return {
    ...tool,
    requiresSandbox: builtInToolRequiresSandbox(tool.name),
  };
}

export function withBuiltInToolsRuntimeRequirements<T extends PolpoTool>(
  tools: T[],
): Array<T & { requiresSandbox: boolean }> {
  return tools.map(withBuiltInToolRuntimeRequirements);
}
