/**
 * Browser automation tools powered by agent-browser.
 *
 * Uses the agent-browser CLI (https://github.com/vercel-labs/agent-browser)
 * with --json output for structured results, routed through the
 * Shell abstraction so it works the same in three environments:
 *   - OSS standalone (NodeShell): agent-browser must be on PATH
 *     locally (`npm install -g agent-browser && agent-browser install`).
 *   - Polpo task runner: NodeShell inside the sandbox; agent-browser
 *     is baked into the snapshot.
 *   - Cloud chat-completion (SandboxProxyShell): the worker proxies
 *     every command into the project's sandbox, where agent-browser
 *     lives. Without this routing the worker would `spawn` locally
 *     and fail with `ENOENT`, since the worker container has no
 *     Chromium and no agent-browser binary.
 *
 * Session isolation: each agent gets its own browser session via
 * --session, preventing cross-agent interference.
 */

import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { PolpoTool as AgentTool, ToolResult as AgentToolResult } from "@polpo-ai/core";
import type { Shell } from "@polpo-ai/core";
import { NodeShell } from "./adapters/node-shell.js";

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_TIMEOUT = 30_000;

/** Quote a CLI argument so it survives `shell.execute` (which takes a
 *  full command line, not an argv). Conservative: single-quote and
 *  escape any embedded single quotes. */
function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Cleanup an agent-browser session: close the session.
 * Profile data is automatically persisted by agent-browser when --profile is used.
 * Called by the engine on agent exit.
 */
export async function cleanupAgentBrowserSession(session: string, shell?: Shell): Promise<void> {
  const _shell = shell ?? new NodeShell();
  try {
    await _shell.execute(`agent-browser --session ${quote(session)} close`, { timeout: 10_000 });
  } catch {
    // Already closed
  }
}

// ─── Helpers ───

/** Execute an agent-browser CLI command via the Shell abstraction
 *  and parse the --json response. */
async function execBrowserAsync(
  shell: Shell,
  args: string[],
  options: { session?: string; profileDir?: string; timeout?: number; cwd?: string } = {},
): Promise<{ success: boolean; data?: any; error?: string; raw: string }> {
  const parts = ["agent-browser"];
  if (options.session) parts.push("--session", quote(options.session));
  if (options.profileDir) parts.push("--profile", quote(options.profileDir));
  for (const a of args) parts.push(quote(a));
  parts.push("--json");
  const cmd = parts.join(" ");

  let result;
  try {
    result = await shell.execute(cmd, { cwd: options.cwd, timeout: options.timeout ?? DEFAULT_TIMEOUT });
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err), raw: err?.message ?? String(err) };
  }

  let raw = (result.stdout || result.stderr || "").trim();
  if (raw.length > MAX_OUTPUT_BYTES) {
    raw = raw.slice(-MAX_OUTPUT_BYTES) + "\n[truncated]";
  }

  if (result.exitCode !== 0) {
    // agent-browser still emits structured JSON on failure when --json
    // is set; try to parse it before falling back to raw stderr.
    try {
      const parsed = JSON.parse(raw);
      return { success: false, error: parsed.error ?? raw, data: parsed.data, raw };
    } catch {
      return { success: false, error: raw || `exit ${result.exitCode}`, raw };
    }
  }

  try {
    const parsed = JSON.parse(raw);
    return { success: parsed.success ?? true, data: parsed.data ?? parsed, raw };
  } catch {
    return { success: true, data: raw, raw };
  }
}

function browserResult(result: { success: boolean; data?: any; error?: string; raw: string }): AgentToolResult<any> {
  if (!result.success) {
    return {
      content: [{ type: "text", text: `Browser error: ${result.error ?? result.raw}` }],
      details: { error: result.error ?? result.raw },
    };
  }
  const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
  return {
    content: [{ type: "text", text: text.slice(0, MAX_OUTPUT_BYTES) }],
    details: result.data,
  };
}

// ─── Tool: browser_navigate ───

const BrowserNavigateSchema = Type.Object({
  url: Type.String({ description: "URL to navigate to (e.g. 'https://example.com')" }),
});

function createBrowserNavigateTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserNavigateSchema> {
  return {
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Open a URL in the browser. Launches the browser if not already running.",
    parameters: BrowserNavigateSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(shell, ["open", params.url], { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_snapshot ───

const BrowserSnapshotSchema = Type.Object({
  interactive_only: Type.Optional(Type.Boolean({ description: "Only show interactive elements (buttons, inputs, links)" })),
  compact: Type.Optional(Type.Boolean({ description: "Remove empty structural elements" })),
  max_depth: Type.Optional(Type.Number({ description: "Limit tree depth" })),
  selector: Type.Optional(Type.String({ description: "Scope snapshot to a CSS selector" })),
});

function createBrowserSnapshotTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserSnapshotSchema> {
  return {
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Get the accessibility tree of the current page with element refs (e.g. @e1, @e2). " +
      "Use refs to interact with elements. Best way to understand page structure for AI.",
    parameters: BrowserSnapshotSchema,
    async execute(_id, params, signal) {
      const args = ["snapshot"];
      if (params.interactive_only) args.push("-i");
      if (params.compact) args.push("-c");
      if (params.max_depth) args.push("-d", String(params.max_depth));
      if (params.selector) args.push("-s", params.selector);
      const result = await execBrowserAsync(shell, args, { session, profileDir, timeout: 15_000 });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_click ───

const BrowserClickSchema = Type.Object({
  selector: Type.String({ description: "Element ref from snapshot (e.g. '@e2') or CSS selector" }),
});

function createBrowserClickTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserClickSchema> {
  return {
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element. Use refs from snapshot (e.g. @e2) for reliable targeting.",
    parameters: BrowserClickSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(shell, ["click", params.selector], { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_fill ───

const BrowserFillSchema = Type.Object({
  selector: Type.String({ description: "Element ref from snapshot (e.g. '@e3') or CSS selector" }),
  text: Type.String({ description: "Text to fill into the input" }),
});

function createBrowserFillTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserFillSchema> {
  return {
    name: "browser_fill",
    label: "Browser Fill",
    description: "Clear an input field and type new text. Use refs from snapshot for targeting.",
    parameters: BrowserFillSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(shell, ["fill", params.selector, params.text], { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_type ───

const BrowserTypeSchema = Type.Object({
  selector: Type.String({ description: "Element ref or CSS selector" }),
  text: Type.String({ description: "Text to type (appends to existing content)" }),
});

function createBrowserTypeTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserTypeSchema> {
  return {
    name: "browser_type",
    label: "Browser Type",
    description: "Type text into an element without clearing it first. Use for appending text.",
    parameters: BrowserTypeSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(shell, ["type", params.selector, params.text], { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_press ───

const BrowserPressSchema = Type.Object({
  key: Type.String({ description: "Key to press (e.g. 'Enter', 'Tab', 'Control+a', 'Escape')" }),
});

function createBrowserPressTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserPressSchema> {
  return {
    name: "browser_press",
    label: "Browser Press Key",
    description: "Press a keyboard key. Supports modifiers like 'Control+a', 'Shift+Enter'.",
    parameters: BrowserPressSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(shell, ["press", params.key], { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_screenshot ───

const BrowserScreenshotSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "File path to save screenshot (default: auto-generated temp path)" })),
  full_page: Type.Optional(Type.Boolean({ description: "Capture full page, not just viewport" })),
});

function createBrowserScreenshotTool(shell: Shell, session: string, cwd: string, profileDir?: string): AgentTool<typeof BrowserScreenshotSchema> {
  return {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Take a screenshot of the current page. Returns the file path of the saved image.",
    parameters: BrowserScreenshotSchema,
    async execute(_id, params, signal) {
      const args = ["screenshot"];
      if (params.path) args.push(resolve(cwd, params.path));
      if (params.full_page) args.push("--full");
      const result = await execBrowserAsync(shell, args, { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_get ───

const BrowserGetSchema = Type.Object({
  what: Type.Union([
    Type.Literal("text"),
    Type.Literal("html"),
    Type.Literal("value"),
    Type.Literal("title"),
    Type.Literal("url"),
  ], { description: "What to retrieve: text, html, value, title, or url" }),
  selector: Type.Optional(Type.String({ description: "Element ref or CSS selector (required for text/html/value)" })),
});

function createBrowserGetTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserGetSchema> {
  return {
    name: "browser_get",
    label: "Browser Get Info",
    description: "Get information from the browser: element text/html/value, page title, or current URL.",
    parameters: BrowserGetSchema,
    async execute(_id, params, signal) {
      const args = ["get", params.what];
      if (params.selector) args.push(params.selector);
      const result = await execBrowserAsync(shell, args, { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_select ───

const BrowserSelectSchema = Type.Object({
  selector: Type.String({ description: "Element ref or CSS selector for the <select> element" }),
  value: Type.String({ description: "Option value to select" }),
});

function createBrowserSelectTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserSelectSchema> {
  return {
    name: "browser_select",
    label: "Browser Select",
    description: "Select an option from a dropdown <select> element.",
    parameters: BrowserSelectSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(shell, ["select", params.selector, params.value], { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_hover ───

const BrowserHoverSchema = Type.Object({
  selector: Type.String({ description: "Element ref or CSS selector to hover" }),
});

function createBrowserHoverTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserHoverSchema> {
  return {
    name: "browser_hover",
    label: "Browser Hover",
    description: "Hover over an element to trigger hover states, tooltips, or dropdown menus.",
    parameters: BrowserHoverSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(shell, ["hover", params.selector], { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_scroll ───

const BrowserScrollSchema = Type.Object({
  direction: Type.Union([
    Type.Literal("up"),
    Type.Literal("down"),
    Type.Literal("left"),
    Type.Literal("right"),
  ], { description: "Scroll direction" }),
  pixels: Type.Optional(Type.Number({ description: "Number of pixels to scroll (default: varies)" })),
});

function createBrowserScrollTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserScrollSchema> {
  return {
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the page in a direction. Useful for loading lazy content or navigating long pages.",
    parameters: BrowserScrollSchema,
    async execute(_id, params, signal) {
      const args = ["scroll", params.direction];
      if (params.pixels) args.push(String(params.pixels));
      const result = await execBrowserAsync(shell, args, { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_wait ───

const BrowserWaitSchema = Type.Object({
  selector: Type.Optional(Type.String({ description: "CSS selector or ref to wait for" })),
  text: Type.Optional(Type.String({ description: "Wait for text to appear on page" })),
  url: Type.Optional(Type.String({ description: "Wait for URL pattern (glob)" })),
  timeout_ms: Type.Optional(Type.Number({ description: "Wait for milliseconds" })),
  load_state: Type.Optional(Type.Union([
    Type.Literal("load"),
    Type.Literal("domcontentloaded"),
    Type.Literal("networkidle"),
  ], { description: "Wait for load state" })),
});

function createBrowserWaitTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserWaitSchema> {
  return {
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for an element, text, URL pattern, or load state. Use after navigation or actions that trigger async content.",
    parameters: BrowserWaitSchema,
    async execute(_id, params, signal) {
      const args = ["wait"];
      if (params.selector) args.push(params.selector);
      if (params.text) args.push("--text", params.text);
      if (params.url) args.push("--url", params.url);
      if (params.timeout_ms) args.push(String(params.timeout_ms));
      if (params.load_state) args.push("--load", params.load_state);
      const result = await execBrowserAsync(shell, args, { session, profileDir, timeout: 60_000 });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_eval ───

const BrowserEvalSchema = Type.Object({
  javascript: Type.String({ description: "JavaScript code to execute in the browser page context" }),
});

function createBrowserEvalTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserEvalSchema> {
  return {
    name: "browser_eval",
    label: "Browser Evaluate JS",
    description: "Execute JavaScript in the browser page context and return the result. " +
      "Use for reading DOM properties, manipulating the page, or extracting data not available via snapshot.",
    parameters: BrowserEvalSchema,
    async execute(_id, params, signal) {
      // Use base64 encoding for safe transport of complex JS
      const b64 = Buffer.from(params.javascript).toString("base64");
      // `-b` must come BEFORE the positional script — agent-browser's
      // CLI parser silently ignores the flag if it follows the arg,
      // and runs the base64 string verbatim as JS (ReferenceError on
      // every call). Discovered via the layer-2 paranoid smoke.
      const result = await execBrowserAsync(shell, ["eval", "-b", b64], { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_close ───

const BrowserCloseSchema = Type.Object({});

function createBrowserCloseTool(shell: Shell, session: string): AgentTool<typeof BrowserCloseSchema> {
  return {
    name: "browser_close",
    label: "Browser Close",
    description: "Close the browser session. Profile data (cookies, login) is saved automatically.",
    parameters: BrowserCloseSchema,
    async execute(_id, _params, signal) {
      const result = await execBrowserAsync(shell, ["close"], { session });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_back / browser_forward / browser_reload ───

const BrowserNavActionSchema = Type.Object({});

function createBrowserBackTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_back",
    label: "Browser Back",
    description: "Navigate back in browser history.",
    parameters: BrowserNavActionSchema,
    async execute(_id, _params, signal) {
      return browserResult(await execBrowserAsync(shell, ["back"], { session, profileDir }));
    },
  };
}

function createBrowserForwardTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_forward",
    label: "Browser Forward",
    description: "Navigate forward in browser history.",
    parameters: BrowserNavActionSchema,
    async execute(_id, _params, signal) {
      return browserResult(await execBrowserAsync(shell, ["forward"], { session, profileDir }));
    },
  };
}

function createBrowserReloadTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_reload",
    label: "Browser Reload",
    description: "Reload the current page.",
    parameters: BrowserNavActionSchema,
    async execute(_id, _params, signal) {
      return browserResult(await execBrowserAsync(shell, ["reload"], { session, profileDir }));
    },
  };
}

// ─── Tool: browser_tabs ───

const BrowserTabsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("new"),
    Type.Literal("switch"),
    Type.Literal("close"),
  ], { description: "Tab action: list, new, switch, or close" }),
  index: Type.Optional(Type.Number({ description: "Tab index for switch/close actions" })),
  url: Type.Optional(Type.String({ description: "URL to open in new tab" })),
});

function createBrowserTabsTool(shell: Shell, session: string, profileDir?: string): AgentTool<typeof BrowserTabsSchema> {
  return {
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "Manage browser tabs: list open tabs, open new tab, switch to tab, or close tab.",
    parameters: BrowserTabsSchema,
    async execute(_id, params, signal) {
      const args = ["tab"];
      switch (params.action) {
        case "list":
          break;
        case "new":
          args.push("new");
          if (params.url) args.push(params.url);
          break;
        case "switch":
          if (params.index !== undefined) args.push(String(params.index));
          break;
        case "close":
          args.push("close");
          if (params.index !== undefined) args.push(String(params.index));
          break;
      }
      const result = await execBrowserAsync(shell, args, { session, profileDir });
      return browserResult(result);
    },
  };
}

// ─── Factory ───

export type BrowserToolName =
  | "browser_navigate" | "browser_snapshot" | "browser_click" | "browser_fill"
  | "browser_type" | "browser_press" | "browser_screenshot" | "browser_get"
  | "browser_select" | "browser_hover" | "browser_scroll" | "browser_wait"
  | "browser_eval" | "browser_close" | "browser_back" | "browser_forward"
  | "browser_reload" | "browser_tabs";

export const ALL_BROWSER_TOOL_NAMES: BrowserToolName[] = [
  "browser_navigate", "browser_snapshot", "browser_click", "browser_fill",
  "browser_type", "browser_press", "browser_screenshot", "browser_get",
  "browser_select", "browser_hover", "browser_scroll", "browser_wait",
  "browser_eval", "browser_close", "browser_back", "browser_forward",
  "browser_reload", "browser_tabs",
];

/**
 * Create browser automation tools powered by agent-browser CLI.
 *
 * @param cwd - Working directory for resolving relative file paths (screenshots)
 * @param session - Browser session name for isolation (default: agent name or "default")
 * @param allowedTools - Optional filter: only include tools with these names
 * @param profileDir - Persistent browser profile directory. Passed as --profile to agent-browser.
 *                     Stores cookies, localStorage, auth state across sessions.
 *                     Typically `.polpo/browser-profiles/<agent>/`.
 */
export function createBrowserTools(
  cwd: string,
  session: string = "default",
  allowedTools?: string[],
  profileDir?: string,
  shell?: Shell,
): AgentTool<any>[] {
  const _shell = shell ?? new NodeShell();
  const factories: Record<BrowserToolName, () => AgentTool<any>> = {
    browser_navigate: () => createBrowserNavigateTool(_shell, session, profileDir),
    browser_snapshot: () => createBrowserSnapshotTool(_shell, session, profileDir),
    browser_click: () => createBrowserClickTool(_shell, session, profileDir),
    browser_fill: () => createBrowserFillTool(_shell, session, profileDir),
    browser_type: () => createBrowserTypeTool(_shell, session, profileDir),
    browser_press: () => createBrowserPressTool(_shell, session, profileDir),
    browser_screenshot: () => createBrowserScreenshotTool(_shell, session, cwd, profileDir),
    browser_get: () => createBrowserGetTool(_shell, session, profileDir),
    browser_select: () => createBrowserSelectTool(_shell, session, profileDir),
    browser_hover: () => createBrowserHoverTool(_shell, session, profileDir),
    browser_scroll: () => createBrowserScrollTool(_shell, session, profileDir),
    browser_wait: () => createBrowserWaitTool(_shell, session, profileDir),
    browser_eval: () => createBrowserEvalTool(_shell, session, profileDir),
    browser_close: () => createBrowserCloseTool(_shell, session),
    browser_back: () => createBrowserBackTool(_shell, session, profileDir),
    browser_forward: () => createBrowserForwardTool(_shell, session, profileDir),
    browser_reload: () => createBrowserReloadTool(_shell, session, profileDir),
    browser_tabs: () => createBrowserTabsTool(_shell, session, profileDir),
  };

  const names = allowedTools
    ? ALL_BROWSER_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_BROWSER_TOOL_NAMES;

  return names.map(n => factories[n]());
}
