/**
 * Standard coding tools for the native pi adapter.
 *
 * All file-based tools enforce path sandboxing when allowedPaths is provided.
 * The bash tool runs with cwd set to the agent's primary working directory.
 */

import { join, dirname, resolve } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
// NodeFileSystem and NodeShell are loaded lazily to avoid pulling in
// node:fs and execa when the consumer provides their own implementations.
import { Type } from "@sinclair/typebox";
import type { PolpoTool, SearchProvider } from "@polpo-ai/core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";
import { createOutcomeTools as createOutcomeToolsCore } from "./outcome-tools.js";
import { createHttpTools as createHttpToolsCore, ALL_HTTP_TOOL_NAMES as CORE_HTTP_TOOL_NAMES } from "./http-tools.js";
import { createVaultToolsCore } from "./vault-tools.js";
import { ALL_MEMORY_TOOL_NAMES, createMemoryTools } from "./memory-tools.js";
import { ALL_BRAIN_TOOL_NAMES, createBrainTools } from "./brain-tools.js";
import type {
  BrainReadService,
  BrainServiceContext,
} from "@polpo-ai/core/brain";
import type { MemoryStore } from "@polpo-ai/core";
import type { ResolvedVault } from "./types.js";

const MAX_READ_LINES = 500;
const MAX_OUTPUT_BYTES = 30_000;

// === Read Tool ===

const ReadSchema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to the file to read" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Max number of lines to read" })),
});

function createReadTool(cwd: string, sandbox: string[], fs: FileSystem): PolpoTool<typeof ReadSchema> {
  return {
    name: "read",
    label: "Read File",
    description: "Read the contents of a file. Returns line-numbered text. For large files, use offset and limit to read specific sections.",
    parameters: ReadSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "read");
      const raw = await fs.readFile(filePath);
      const allLines = raw.split("\n");
      const offset = (params.offset ?? 1) - 1;
      const limit = params.limit ?? MAX_READ_LINES;
      const lines = allLines.slice(offset, offset + limit);
      const numbered = lines.map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
      const truncated = allLines.length > offset + limit;
      const suffix = truncated ? `\n... (${allLines.length - offset - limit} more lines)` : "";
      return {
        content: [{ type: "text", text: numbered + suffix }],
        details: { path: filePath, lines: lines.length, total: allLines.length },
      };
    },
  };
}

// === Write Tool ===

const WriteSchema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to write to" }),
  content: Type.String({ description: "File content to write" }),
});

function createWriteTool(cwd: string, sandbox: string[], fs: FileSystem): PolpoTool<typeof WriteSchema> {
  return {
    name: "write",
    label: "Write File",
    description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
    parameters: WriteSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "write");
      await fs.mkdir(dirname(filePath));
      await fs.writeFile(filePath, params.content);
      return {
        content: [{ type: "text", text: `File written: ${filePath} (${params.content.length} bytes)` }],
        details: { path: filePath, bytes: params.content.length },
      };
    },
  };
}

// === Edit Tool ===

const EditSchema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to the file to edit" }),
  old_text: Type.String({ description: "Exact text to find and replace (must be unique in the file)" }),
  new_text: Type.String({ description: "Replacement text" }),
});

function createEditTool(cwd: string, sandbox: string[], fs: FileSystem): PolpoTool<typeof EditSchema> {
  return {
    name: "edit",
    label: "Edit File",
    description: "Replace a unique string in a file. The old_text must appear exactly once.",
    parameters: EditSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "edit");
      const content = await fs.readFile(filePath);
      const occurrences = content.split(params.old_text).length - 1;
      if (occurrences === 0) {
        return {
          content: [{ type: "text", text: `Error: old_text not found in ${filePath}` }],
          details: { path: filePath, error: "not_found" },
        };
      }
      if (occurrences > 1) {
        return {
          content: [{ type: "text", text: `Error: old_text found ${occurrences} times in ${filePath}. Must be unique.` }],
          details: { path: filePath, error: "not_unique", count: occurrences },
        };
      }
      const updated = content.replace(params.old_text, params.new_text);
      await fs.writeFile(filePath, updated);
      return {
        content: [{ type: "text", text: `Edited ${filePath}: replaced ${params.old_text.length} chars with ${params.new_text.length} chars` }],
        details: { path: filePath },
      };
    },
  };
}

// === Bash Tool ===

const BashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 120000)" })),
});

function createBashTool(cwd: string, shell: Shell): PolpoTool<typeof BashSchema> {
  return {
    name: "bash",
    label: "Execute Shell",
    description: "Execute a shell command and return its output. Use for running tests, installing packages, git operations, etc.",
    parameters: BashSchema,
    async execute(_toolCallId, params) {
      const timeout = params.timeout ?? 120_000;
      try {
        const result = await shell.execute(params.command, { cwd, timeout });
        let output = result.stdout + (result.stderr ? "\n" + result.stderr : "");
        if (output.length > MAX_OUTPUT_BYTES) {
          output = output.slice(-MAX_OUTPUT_BYTES) + "\n[truncated to last 30KB]";
        }
        return {
          content: [{ type: "text", text: `Exit code: ${result.exitCode}\n${output}` }],
          details: { command: params.command, exitCode: result.exitCode },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          details: { command: params.command, error: err.message },
        };
      }
    },
  };
}

// === Glob Tool ===

const GlobSchema = Type.Object({
  pattern: Type.String({ description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.js')" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: cwd)" })),
});

function createGlobTool(cwd: string, sandbox: string[], _shell: Shell): PolpoTool<typeof GlobSchema> {
  return {
    name: "glob",
    label: "Find Files",
    description: "Find files matching a glob pattern. Supports `**` (recursive), `*`, `?`, `[abc]`, `{a,b}`. Examples: `**/*.ts`, `src/**/*.{ts,tsx}`, `**/test.spec.js`.",
    parameters: GlobSchema,
    async execute(_toolCallId, params) {
      const searchDir = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(searchDir, sandbox, "glob");
      try {
        // Real glob lib (tinyglobby) — supports `**`, `?`, `[abc]`, `{a,b}`.
        // The previous shell-out to `find -name` only matched basenames,
        // so the patterns advertised in the description literally didn't
        // work. Lazy import keeps it optional for consumers who don't
        // need glob support at all.
        const { glob } = await import("tinyglobby");
        const matches = await glob(params.pattern, {
          cwd: searchDir,
          absolute: false,
          onlyFiles: true,
          dot: false,
        });
        matches.sort();
        const limited = matches.slice(0, 200);
        return {
          content: [{ type: "text", text: limited.length > 0 ? limited.join("\n") : "No files found" }],
          details: { pattern: params.pattern, count: limited.length, truncated: matches.length > 200 },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Glob error: ${err.message ?? err}` }],
          details: { pattern: params.pattern, count: 0, error: err.message },
        };
      }
    },
  };
}

// === Grep Tool ===

const GrepSchema = Type.Object({
  pattern: Type.String({ description: "Regex pattern to search for" }),
  path: Type.Optional(Type.String({ description: "File or directory to search in (default: cwd)" })),
  include: Type.Optional(Type.String({ description: "File glob filter (e.g. '*.ts')" })),
});

function createGrepTool(cwd: string, sandbox: string[], shell: Shell): PolpoTool<typeof GrepSchema> {
  return {
    name: "grep",
    label: "Search Code",
    description:
      "Search for a regex pattern in files. PCRE flavor (supports `\\d`, `\\w`, `\\s`, " +
      "lookahead `(?=...)`, lookbehind `(?<=...)`, non-greedy `.*?`). " +
      "Returns matching lines with file paths and line numbers.",
    parameters: GrepSchema,
    async execute(_toolCallId, params) {
      const searchPath = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(searchPath, sandbox, "grep");
      const includeFlag = params.include ? `--include=${JSON.stringify(params.include)}` : "";
      try {
        // -P selects PCRE (Perl regex). Matches what an LLM trained on
        // JS/Python regex expects: `\d`, `\w`, `\s`, lookahead/behind,
        // non-greedy quantifiers. -E (POSIX ERE) was the previous
        // setting and silently rejected all of those.
        // -a forces text mode so binary files with the right bytes
        // don't dominate the output.
        const r = await shell.execute(
          `grep -arn ${includeFlag} -P ${JSON.stringify(params.pattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -100`,
          { cwd, timeout: 15_000 },
        );
        const result = r.stdout.trim();
        if (!result) {
          return {
            content: [{ type: "text", text: "No matches found" }],
            details: { pattern: params.pattern, count: 0 },
          };
        }
        const lines = result.split("\n");
        return {
          content: [{ type: "text", text: result }],
          details: { pattern: params.pattern, count: lines.length },
        };
      } catch {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: { pattern: params.pattern, count: 0 },
        };
      }
    },
  };
}

// === Ls Tool ===

const LsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: cwd)" })),
});

function createLsTool(cwd: string, sandbox: string[], fs: FileSystem): PolpoTool<typeof LsSchema> {
  return {
    name: "ls",
    label: "List Directory",
    description: "List files and directories in a given path.",
    parameters: LsSchema,
    async execute(_toolCallId, params) {
      const dir = params.path ? resolve(cwd, params.path) : cwd;
      assertPathAllowed(dir, sandbox, "ls");
      const names = await fs.readdir(dir);
      const entries: string[] = [];
      for (const name of names) {
        try {
          const s = await fs.stat(join(dir, name));
          entries.push(s.isDirectory ? `${name}/` : name);
        } catch { entries.push(name); }
      }
      return {
        content: [{ type: "text", text: entries.join("\n") }],
        details: { path: dir, count: entries.length },
      };
    },
  };
}

// === Tool name matching (wildcard support) ===

/**
 * Check if a tool name matches an allowed pattern.
 * Supports exact match and trailing wildcard: "browser_*" matches "browser_navigate".
 */
export function matchToolPattern(pattern: string, toolName: string): boolean {
  const p = pattern.toLowerCase();
  const n = toolName.toLowerCase();
  if (p === n) return true;
  if (p.endsWith("*")) {
    return n.startsWith(p.slice(0, -1));
  }
  return false;
}

/**
 * Expand wildcard patterns in an allowedTools list against all known tool names.
 * E.g. ["browser_*", "http_fetch"] → ["browser_navigate", "browser_click", ..., "http_fetch"].
 * Non-wildcard entries pass through as-is (even if not in allNames — factory will just skip them).
 */
export function expandToolWildcards(allowedTools: string[], allNames: readonly string[]): string[] {
  const result = new Set<string>();
  for (const pattern of allowedTools) {
    if (pattern.includes("*")) {
      for (const name of allNames) {
        if (matchToolPattern(pattern, name)) result.add(name);
      }
    } else {
      result.add(pattern.toLowerCase());
    }
  }
  return [...result];
}

// === Factory ===

/** Tool name to filter by in allowedTools config */
type SystemToolName = "read" | "write" | "edit" | "bash" | "glob" | "grep" | "ls";

const CORE_TOOL_NAMES: SystemToolName[] = ["read", "write", "edit", "bash", "glob", "grep", "ls"];

/**
 * Create the standard set of coding tools scoped to a working directory.
 * If allowedTools is provided, only those tools are included.
 * If allowedPaths is provided, file-based tools enforce path sandboxing.
 *
 * Core tools (always included regardless of allowedTools):
 * - read, write, edit, bash, glob, grep, ls
 * - register_outcome
 * - http_fetch, http_download
 * - vault_get, vault_list (when vault is provided)
 */
export function createSystemTools(cwd: string, allowedTools?: string[], allowedPaths?: string[], outputDir?: string, vault?: ResolvedVault, fs?: FileSystem, shell?: Shell): PolpoTool<any>[] {
  if (!fs || !shell) {
    throw new Error("createSystemTools requires fs and shell arguments. Use NodeFileSystem/NodeShell for Node.js or SandboxProxyFS/SandboxProxyShell for remote execution.");
  }
  const _fs = fs;
  const _shell = shell;
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<SystemToolName, () => PolpoTool<any>> = {
    read: () => createReadTool(cwd, sandbox, _fs),
    write: () => createWriteTool(cwd, sandbox, _fs),
    edit: () => createEditTool(cwd, sandbox, _fs),
    bash: () => createBashTool(cwd, _shell),
    glob: () => createGlobTool(cwd, sandbox, _shell),
    grep: () => createGrepTool(cwd, sandbox, _shell),
    ls: () => createLsTool(cwd, sandbox, _fs),
  };

  const names = allowedTools
    ? CORE_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : CORE_TOOL_NAMES;

  const tools = names.map(n => factories[n]());

  // register_outcome is task-only by design: it's injected when an
  // outputDir is provided (i.e. the caller is running a task/run that
  // wants to collect declared deliverables). In chat-completion flows
  // outputDir is unset, so the tool is not exposed — outcomes there
  // are derived from the message log instead. Removed from the public
  // TOOL_CATALOG so it can't be configured via `allowedTools`.
  if (outputDir) {
    tools.push(...createOutcomeToolsCore(cwd, allowedPaths, allowedTools, outputDir));
  }

  // http_fetch + http_download are always included — core tools with SSRF protection
  tools.push(...createHttpToolsCore(cwd, allowedPaths, allowedTools));

  // vault_get + vault_list are always included — core tools for credential access
  if (vault) {
    tools.push(...createVaultToolsCore(vault));
  }

  return tools;
}

// === Extended Tools Factory ===

import { createBrowserTools, ALL_BROWSER_TOOL_NAMES } from "./browser-tools.js";
import { ALL_HTTP_TOOL_NAMES } from "./http-tools.js";
import { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "./email-tools.js";
import { createVaultTools, ALL_VAULT_TOOL_NAMES } from "./vault-tools.js";
import { createImageTools, ALL_IMAGE_TOOL_NAMES } from "./image-tools.js";
import { createAudioTools, ALL_AUDIO_TOOL_NAMES } from "./audio-tools.js";
import { createExcelTools, ALL_EXCEL_TOOL_NAMES } from "./excel-tools.js";
import { createPdfTools, ALL_PDF_TOOL_NAMES } from "./pdf-tools.js";
import { createDocxTools, ALL_DOCX_TOOL_NAMES } from "./docx-tools.js";
import { createSearchTools, ALL_SEARCH_TOOL_NAMES } from "./search-tools.js";
// Phone tools removed in favour of a future MCP-based integration —
// VAPI key + voice-call surface didn't fit "first-class built-in".

export type { BrowserToolName } from "./browser-tools.js";
export type { HttpToolName } from "./http-tools.js";
export type { EmailToolName } from "./email-tools.js";
export type { OutcomeToolName } from "./outcome-tools.js";
export type { VaultToolName } from "./vault-tools.js";
export type { ImageToolName } from "./image-tools.js";
export type { AudioToolName } from "./audio-tools.js";
export type { ExcelToolName } from "./excel-tools.js";
export type { PdfToolName } from "./pdf-tools.js";
export type { DocxToolName } from "./docx-tools.js";
export type { SearchToolName } from "./search-tools.js";

/** All known tool names across all categories */
export type ExtendedToolName = SystemToolName
  | import("./browser-tools.js").BrowserToolName
  | import("./http-tools.js").HttpToolName
  | import("./email-tools.js").EmailToolName
  | import("./outcome-tools.js").OutcomeToolName
  | import("./vault-tools.js").VaultToolName
  | import("./image-tools.js").ImageToolName
  | import("./audio-tools.js").AudioToolName
  | import("./excel-tools.js").ExcelToolName
  | import("./pdf-tools.js").PdfToolName
  | import("./docx-tools.js").DocxToolName
  | import("./search-tools.js").SearchToolName
  | import("./brain-tools.js").BrainToolName;

/**
 * Public catalog of every configurable built-in tool name (core coding
 * + http + vault + browser + email + image + audio + excel + pdf +
 * docx + search). Use this for config validation, documentation,
 * and the `/v1/tools` endpoint.
 *
 * Notable exclusion: `register_outcome` is not listed. It's a
 * task-only infrastructural tool, injected automatically when the
 * caller passes an `outputDir`, and is not configurable via
 * `allowedTools`.
 */
export const TOOL_CATALOG: string[] = [
  ...CORE_TOOL_NAMES,
  ...ALL_BROWSER_TOOL_NAMES,
  ...ALL_HTTP_TOOL_NAMES,
  ...ALL_EMAIL_TOOL_NAMES,
  ...ALL_VAULT_TOOL_NAMES,
  ...ALL_IMAGE_TOOL_NAMES,
  ...ALL_AUDIO_TOOL_NAMES,
  ...ALL_EXCEL_TOOL_NAMES,
  ...ALL_PDF_TOOL_NAMES,
  ...ALL_DOCX_TOOL_NAMES,
  ...ALL_SEARCH_TOOL_NAMES,
  ...ALL_MEMORY_TOOL_NAMES,
  ...ALL_BRAIN_TOOL_NAMES,
];

export interface CreateAllToolsOptions {
  /** Working directory for the agent */
  cwd: string;
  /** Tool name filter — only include tools with these names.
   *  Extended tools are auto-loaded when their names appear here (e.g. "browser_*", "email_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*").
   *  If omitted, only core coding tools are included. */
  allowedTools?: string[];
  /** Filesystem sandbox paths */
  allowedPaths?: string[];
  /** Browser session name for isolation (default: "default"). */
  browserSession?: string;
  /** Browser profile directory for agent-browser persistent state (cookies, localStorage).
   *  Typically `.polpo/browser-profiles/<agent>/`. Passed as --profile to agent-browser. */
  browserProfileDir?: string;
  /** Resolved vault credentials for the agent */
  vault?: ResolvedVault;
  /** Allowed recipient email domains for email_send. */
  emailAllowedDomains?: string[];
  /** Per-task output directory for deliverables. Passed to outcome tools. */
  outputDir?: string;
  /** FileSystem implementation (default: NodeFileSystem). */
  fs?: FileSystem;
  /** Shell implementation (default: NodeShell). */
  shell?: Shell;
  // ── Agent-config-driven media models (resolved by the engine) ──
  // Format: "provider/model". When omitted the tool layer applies its
  // own default (`DEFAULT_*_MODEL` from @polpo-ai/core).
  /** image_generate model. e.g. "fal/fal-ai/flux/dev" */
  imageModel?: string;
  /** video_generate model. e.g. "fal/luma-ray-2-flash" */
  videoModel?: string;
  /** image_analyze model. e.g. "openai/gpt-4o-mini" */
  visionModel?: string;
  /** audio_transcribe model. e.g. "openai/whisper-1" */
  transcribeModel?: string;
  /** audio_speak model. e.g. "openai/tts-1" or "edge/edge-tts" */
  ttsModel?: string;
  /** Pre-instantiated SearchProvider. When omitted, falls back to
   *  ExaSearchProvider built from the vault's "exa" key. The cloud
   *  shell can swap in a Gateway-routed provider here without
   *  touching the tool layer. */
  searchProvider?: SearchProvider;
  /** MemoryStore for memory_* tools. When omitted, memory tools are not loaded
   *  even if requested via allowedTools. */
  memoryStore?: MemoryStore;
  /** Agent name — required for memory_* tools to scope memory access. */
  agentName?: string;
  /** Scoped Brain reader. Brain tools remain unavailable when omitted. */
  brainService?: BrainReadService;
  /** Host-resolved Brain scopes and actor. Never supplied by the model. */
  brainContext?: BrainServiceContext;
}

/**
 * Create all available tools for an agent, including extended tool categories.
 *
 * Core tools (always included): read, write, edit, bash, glob, grep, ls,
 * register_outcome, http_fetch, http_download, vault_get, vault_list.
 *
 * Extended categories must be explicitly enabled via allowedTools patterns.
 *
 * When allowedTools is provided, it acts as a filter across ALL categories — any tool whose name
 * appears in allowedTools will be included (and its category auto-enabled).
 */
export async function createAllTools(options: CreateAllToolsOptions): Promise<PolpoTool<any>[]> {
  const { cwd, allowedPaths, browserSession } = options;
  const tools: PolpoTool<any>[] = [];

  // Expand wildcards in allowedTools once — e.g. "browser_*" → all 18 browser tool names.
  // This way individual factory functions don't need wildcard awareness.
  const rawAllowed = options.allowedTools;
  const allowedTools = rawAllowed
    ? expandToolWildcards(rawAllowed, TOOL_CATALOG)
    : undefined;

  // Helper: check if any tool from a category is in the (expanded) allowedTools list
  const categoryRequested = (names: readonly string[]) =>
    allowedTools?.some(a => names.some(n => n === a.toLowerCase()));

  // Core coding tools (always included unless filtered out) — includes vault_get/vault_list
  tools.push(...createSystemTools(cwd, allowedTools, allowedPaths, options.outputDir, options.vault, options.fs, options.shell));

  // Browser tools — activated when any browser_* tool is in allowedTools
  if (categoryRequested(ALL_BROWSER_TOOL_NAMES)) {
    tools.push(...createBrowserTools(cwd, browserSession, allowedTools, options.browserProfileDir, options.shell));
  }

  // Email tools — activated when any email_* tool is in allowedTools
  if (categoryRequested(ALL_EMAIL_TOOL_NAMES)) {
    tools.push(...createEmailTools(cwd, allowedPaths, allowedTools, options.vault, options.emailAllowedDomains, options.outputDir, options.fs));
  }

  // Image & video tools — activated when any image_* or video_* tool is in allowedTools
  if (categoryRequested(ALL_IMAGE_TOOL_NAMES)) {
    tools.push(...createImageTools({
      cwd,
      allowedPaths,
      allowedTools,
      vault: options.vault,
      fs: options.fs,
      imageModel: options.imageModel,
      videoModel: options.videoModel,
      visionModel: options.visionModel,
    }));
  }

  // Audio tools — activated when any audio_* tool is in allowedTools
  if (categoryRequested(ALL_AUDIO_TOOL_NAMES)) {
    tools.push(...createAudioTools({
      cwd,
      allowedPaths,
      allowedTools,
      vault: options.vault,
      fs: options.fs,
      shell: options.shell,
      transcribeModel: options.transcribeModel,
      ttsModel: options.ttsModel,
    }));
  }

  // Excel tools — activated when any excel_* tool is in allowedTools
  if (categoryRequested(ALL_EXCEL_TOOL_NAMES)) {
    tools.push(...createExcelTools(cwd, allowedPaths, allowedTools, options.fs));
  }

  // PDF tools — activated when any pdf_* tool is in allowedTools
  if (categoryRequested(ALL_PDF_TOOL_NAMES)) {
    tools.push(...createPdfTools(cwd, allowedPaths, allowedTools, options.fs, options.shell));
  }

  // Docx tools — activated when any docx_* tool is in allowedTools
  if (categoryRequested(ALL_DOCX_TOOL_NAMES)) {
    tools.push(...createDocxTools(cwd, allowedPaths, allowedTools, options.fs));
  }

  // Search tools — activated when any search_* tool is in allowedTools.
  // Provider injection: pre-instantiated `searchProvider` wins;
  // otherwise we default to ExaSearchProvider built from the vault.
  if (categoryRequested(ALL_SEARCH_TOOL_NAMES)) {
    let provider = options.searchProvider;
    if (!provider) {
      const exaKey = options.vault?.getKey("exa", "key") ?? process.env.EXA_API_KEY;
      if (exaKey) {
        const { ExaSearchProvider } = await import("./lib/exa-search-provider.js");
        provider = new ExaSearchProvider({ apiKey: exaKey });
      }
    }
    if (provider) {
      tools.push(...createSearchTools(provider, allowedTools));
    }
  }

  // Memory tools — activated when any memory_* tool is in allowedTools.
  // Requires a MemoryStore and agentName to scope memory access.
  if (categoryRequested(ALL_MEMORY_TOOL_NAMES) && options.memoryStore && options.agentName) {
    const allMemoryTools = createMemoryTools(options.memoryStore, options.agentName);
    const filtered = allowedTools
      ? allMemoryTools.filter(t => allowedTools.includes(t.name))
      : allMemoryTools;
    tools.push(...filtered);
  }

  if (
    categoryRequested(ALL_BRAIN_TOOL_NAMES)
    && options.brainService
    && options.brainContext
  ) {
    tools.push(...createBrainTools(
      options.brainService,
      options.brainContext,
      allowedTools,
    ));
  }

  // HTTP, register_outcome, and vault are already included via createSystemTools() above — no need to add again

  return tools;
}
