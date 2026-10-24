/**
 * The `if` field of a hook handler: one Claude Code permission rule such as
 * `Bash(git *)`, `Edit(*.ts)`, `WebFetch(domain:example.com)` or
 * `mcp__memory__.*`-style tool names. Evaluated only on tool events, against
 * the canonical (Claude-compatible) tool name and input.
 *
 * Like the reference, the filter is best-effort: when the runtime cannot tell
 * what a Bash command runs, the hook runs.
 */

export interface PermissionRule {
  toolName: string;
  content?: string;
}

const RULE = /^([A-Za-z0-9_:.*\-]+)(?:\(([\s\S]*)\))?$/;

export function parsePermissionRule(rule: string): PermissionRule {
  const trimmed = rule.trim();
  const match = RULE.exec(trimmed);
  if (!match) throw new Error(`"${rule}" is not ToolName or ToolName(pattern)`);
  const content = match[2];
  return { toolName: match[1]!, ...(content !== undefined && content !== "" && content !== "*" ? { content } : {}) };
}

/** Tools an `Edit(...)` rule covers, and tools a `Read(...)` rule covers. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

export interface PermissionRuleContext {
  /** Working directory used to resolve relative path patterns. */
  cwd: string;
  /** Project root, the base of `/path` patterns. */
  projectDir: string;
  homeDir?: string;
}

/**
 * Whether a tool call matches the rule. `input` must be the canonical tool
 * input (absolute `file_path` for file tools).
 */
export function matchesPermissionRule(
  rule: PermissionRule | string,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  context: PermissionRuleContext,
): boolean {
  const parsed = typeof rule === "string" ? parsePermissionRule(rule) : rule;
  if (!toolNameMatches(parsed.toolName, toolName)) return false;
  if (parsed.content === undefined) return true;

  if (toolName === "Bash" || toolName === "PowerShell") {
    return typeof input.command === "string" ? matchesBashRule(parsed.content, input.command) : true;
  }
  if (EDIT_TOOLS.has(parsed.toolName) || READ_TOOLS.has(parsed.toolName)) {
    const path = filePathOf(input);
    if (path === undefined) return parsed.toolName === "Grep" || parsed.toolName === "Glob"
      ? matchesPathRule(parsed.content, context.cwd, context)
      : false;
    return matchesPathRule(parsed.content, path, context);
  }
  if (toolName === "WebFetch" && parsed.content.startsWith("domain:")) {
    const domain = parsed.content.slice("domain:".length).toLowerCase();
    try {
      const host = new URL(String(input.url ?? "")).hostname.toLowerCase();
      return host === domain || (domain.startsWith("*.") && host.endsWith(domain.slice(1)));
    } catch {
      return false;
    }
  }
  if (toolName === "Agent" && typeof input.subagent_type === "string") {
    return globToRegExp(parsed.content).test(input.subagent_type);
  }
  if (toolName === "WebSearch" && typeof input.query === "string") {
    return globToRegExp(parsed.content).test(input.query);
  }
  // Unknown content shape for this tool: run the hook rather than silently skip it.
  return true;
}

function toolNameMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true;
  if (EDIT_TOOLS.has(ruleTool) && ruleTool === "Edit") return EDIT_TOOLS.has(toolName);
  if (ruleTool === "Read") return READ_TOOLS.has(toolName);
  // `mcp__server` covers every tool of that server; `*` wildcards cover patterns.
  if (ruleTool.startsWith("mcp__") && !ruleTool.slice(5).includes("__")) {
    return toolName.startsWith(`${ruleTool}__`);
  }
  if (ruleTool.includes("*")) return globToRegExp(ruleTool).test(toolName);
  return false;
}

function filePathOf(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof input[key] === "string" && input[key]) return input[key] as string;
  }
  return undefined;
}

// ─── Bash ───────────────────────────────────────────────────────────────────

/**
 * Reference table:
 *   Bash(git *)      FOO=bar git push        → yes (leading assignments stripped)
 *   Bash(git *)      npm test && git push    → yes (each subcommand checked)
 *   Bash(rm *)       echo $(rm -rf /)        → yes ($() and backticks checked)
 *   Bash(rm *)       echo $(date)            → no
 *   Bash(git push *) echo $(date)            → yes (pattern names more than the
 *                    command, and the input has $(), backticks or $VAR)
 */
export function matchesBashRule(pattern: string, command: string): boolean {
  const parsed = splitBashCommand(command);
  if (!parsed) return true;
  const specifiesMoreThanName = /\s/.test(stripTrailingWildcard(pattern).trim());
  if (specifiesMoreThanName && parsed.dynamic) return true;
  return parsed.commands.some((subcommand) => matchesCommandPattern(pattern, subcommand));
}

function stripTrailingWildcard(pattern: string): string {
  if (pattern.endsWith(":*")) return pattern.slice(0, -2);
  if (pattern.endsWith(" *")) return pattern.slice(0, -2);
  if (pattern.endsWith("*")) return pattern.slice(0, -1);
  return pattern;
}

function matchesCommandPattern(pattern: string, command: string): boolean {
  // Legacy prefix syntax: `npm run test:*`.
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `) || command.startsWith(prefix);
  }
  // `git *` also matches a bare `git`; the space keeps `lsof` out of `ls *`.
  if (pattern.endsWith(" *") && command === pattern.slice(0, -2)) return true;
  return globToRegExp(pattern).test(command);
}

interface ParsedBash {
  commands: string[];
  /** The input contains `$()`, backticks or `$VAR` expansions. */
  dynamic: boolean;
}

/**
 * Split a shell command into simple commands, recursing into `$()` and
 * backticks. Returns undefined when quoting is unbalanced or the structure is
 * beyond this conservative parser (the caller then runs the hook).
 */
export function splitBashCommand(command: string, depth = 0): ParsedBash | undefined {
  if (depth > 8 || command.length > 100_000) return undefined;
  const commands: string[] = [];
  let dynamic = false;
  let current = "";
  let quote: "'" | '"' | undefined;
  const flush = () => {
    const simple = stripLeadingAssignments(current.trim());
    if (simple) commands.push(simple);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === "$" && command[i + 1] === "(") {
      const end = matchingParen(command, i + 1);
      if (end < 0) return undefined;
      const inner = splitBashCommand(command.slice(i + 2, end), depth + 1);
      if (!inner) return undefined;
      commands.push(...inner.commands);
      dynamic = true;
      current += command.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === "`") {
      const end = command.indexOf("`", i + 1);
      if (end < 0) return undefined;
      const inner = splitBashCommand(command.slice(i + 1, end), depth + 1);
      if (!inner) return undefined;
      commands.push(...inner.commands);
      dynamic = true;
      current += command.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === "$" && /[A-Za-z_{]/.test(command[i + 1] ?? "")) dynamic = true;
    if (quote === '"') {
      if (char === '"') quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      flush();
      if ((char === "|" || char === "&") && command[i + 1] === char) i++;
      continue;
    }
    if (char === "(" || char === ")" || char === "{" || char === "}") {
      flush();
      continue;
    }
    current += char;
  }
  if (quote) return undefined;
  flush();
  return { commands, dynamic };
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let i = open; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\" && quote === '"') { i++; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\\") { i++; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) return i;
  }
  return -1;
}

function stripLeadingAssignments(command: string): string {
  let rest = command;
  for (;;) {
    const match = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"]*)\s+/.exec(rest);
    if (!match) return rest;
    rest = rest.slice(match[0].length);
  }
}

// ─── Paths (gitignore-style) ────────────────────────────────────────────────

/**
 * Path patterns follow the permission-rule convention:
 * `//abs` filesystem root, `~/p` home, `/p` project root, `p` / `./p` cwd.
 * A pattern without a slash matches a file name at any depth (`*.ts`); a
 * single-segment directory like `src/**` matches only under the cwd.
 */
export function matchesPathRule(pattern: string, absolutePath: string, context: PermissionRuleContext): boolean {
  const path = normalizeSlashes(absolutePath);
  let base: string;
  let rest: string;
  if (pattern.startsWith("//")) {
    base = "/";
    rest = pattern.slice(2);
  } else if (pattern.startsWith("~/")) {
    if (!context.homeDir) return false;
    base = context.homeDir;
    rest = pattern.slice(2);
  } else if (pattern.startsWith("/")) {
    base = context.projectDir;
    rest = pattern.slice(1);
  } else {
    base = context.cwd;
    rest = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  }
  if (!rest.includes("/")) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (globToRegExp(rest, true).test(name)) return true;
  }
  const root = normalizeSlashes(base).replace(/\/+$/, "");
  const relative = root === "" ? path.replace(/^\/+/, "") : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
  if (relative === undefined) return false;
  return globToRegExp(rest, true).test(relative);
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Glob to anchored RegExp. With `pathMode`, `*` stays inside one path segment
 * and `**` spans segments; otherwise `*` matches anything.
 */
export function globToRegExp(glob: string, pathMode = false): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (pathMode && glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += pathMode ? "[^/]*" : ".*";
      }
      continue;
    }
    if (char === "?") {
      out += pathMode ? "[^/]" : ".";
      continue;
    }
    out += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${out}$`, "s");
}
