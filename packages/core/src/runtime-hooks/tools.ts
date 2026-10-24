/**
 * Canonical tool projection for hooks.
 *
 * A hook copied from Claude Code matches `Bash` or `Edit|Write` and reads
 * `.tool_input.file_path` / `.tool_input.command`. Polpo's portable tools use
 * other names and argument spellings, so hooks observe the Claude-compatible
 * projection and `updatedInput` is mapped back before execution. Tools without
 * a Claude counterpart keep their own name and arguments unchanged.
 */

export interface CanonicalToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface ToolProjection {
  claudeName: string;
  toInput(input: Readonly<Record<string, unknown>>, cwd: string): Record<string, unknown>;
  fromInput(input: Readonly<Record<string, unknown>>): Record<string, unknown>;
  /** Shape a successful rendered result like the Claude tool's structured output. */
  toResponse?(input: Readonly<Record<string, unknown>>, rendered: string, cwd: string): unknown;
  /** Read a rendered string back from an `updatedToolOutput` value of the Claude shape. */
  fromResponse?(value: unknown): string | undefined;
}

const PROJECTIONS: Readonly<Record<string, ToolProjection>> = {
  bash: {
    claudeName: "Bash",
    toInput: (input) => pick({ command: input.command, timeout: input.timeout }),
    fromInput: (input) => pick({ command: input.command, timeout: input.timeout }),
    toResponse: (_input, rendered) => ({ stdout: rendered, stderr: "", interrupted: false, isImage: false }),
    fromResponse: (value) => isRecord(value) && typeof value.stdout === "string"
      ? [value.stdout, typeof value.stderr === "string" ? value.stderr : ""].filter(Boolean).join("\n")
      : undefined,
  },
  read: {
    claudeName: "Read",
    toInput: (input, cwd) => pick({ file_path: absolute(input.path, cwd), offset: input.offset, limit: input.limit }),
    fromInput: (input) => pick({ path: input.file_path, offset: input.offset, limit: input.limit }),
  },
  write: {
    claudeName: "Write",
    toInput: (input, cwd) => pick({ file_path: absolute(input.path, cwd), content: input.content }),
    fromInput: (input) => pick({ path: input.file_path, content: input.content }),
    toResponse: (input, _rendered, cwd) => ({ filePath: absolute(input.path, cwd), type: "create" }),
  },
  edit: {
    claudeName: "Edit",
    toInput: (input, cwd) => pick({
      file_path: absolute(input.path, cwd),
      old_string: input.old_text,
      new_string: input.new_text,
      replace_all: false,
    }),
    fromInput: (input) => pick({ path: input.file_path, old_text: input.old_string, new_text: input.new_string }),
    toResponse: (input, _rendered, cwd) => ({
      filePath: absolute(input.path, cwd),
      oldString: input.old_text,
      newString: input.new_text,
    }),
  },
  glob: {
    claudeName: "Glob",
    toInput: (input, cwd) => pick({ pattern: input.pattern, path: input.path === undefined ? undefined : absolute(input.path, cwd) }),
    fromInput: (input) => pick({ pattern: input.pattern, path: input.path }),
  },
  grep: {
    claudeName: "Grep",
    toInput: (input, cwd) => pick({
      pattern: input.pattern,
      path: input.path === undefined ? undefined : absolute(input.path, cwd),
      glob: input.include,
    }),
    fromInput: (input) => pick({ pattern: input.pattern, path: input.path, include: input.glob }),
  },
  search_web: {
    claudeName: "WebSearch",
    toInput: (input) => ({ ...input }),
    fromInput: (input) => ({ ...input }),
  },
};

const BY_CLAUDE_NAME = new Map(Object.entries(PROJECTIONS).map(([polpo, projection]) => [projection.claudeName, polpo]));

/** Canonical name and input a hook observes for a Polpo tool call. */
export function canonicalToolCall(name: string, input: Readonly<Record<string, unknown>>, cwd: string): CanonicalToolCall {
  const projection = PROJECTIONS[name];
  if (!projection) return { toolName: name, toolInput: { ...input } };
  return { toolName: projection.claudeName, toolInput: projection.toInput(input, cwd) };
}

/** Map a hook's `updatedInput` (canonical shape, full replacement) back to Polpo arguments. */
export function polpoToolInput(name: string, updatedInput: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const projection = PROJECTIONS[name];
  return projection ? projection.fromInput(updatedInput) : { ...updatedInput };
}

/** The Polpo tool a canonical name refers to, when it is a projected built-in. */
export function polpoToolName(canonicalName: string): string | undefined {
  return BY_CLAUDE_NAME.get(canonicalName);
}

/** PostToolUse `tool_response`: the Claude shape for projected tools, the rendered text otherwise. */
export function canonicalToolResponse(name: string, input: Readonly<Record<string, unknown>>, rendered: string, cwd: string): unknown {
  return PROJECTIONS[name]?.toResponse?.(input, rendered, cwd) ?? rendered;
}

/**
 * Apply `updatedToolOutput`. For projected built-ins a value that does not
 * match the tool's output shape is ignored (the original is used), as in the
 * reference; other tools accept a string or a JSON value as the new result.
 */
export function updatedToolResult(name: string, value: unknown): string | undefined {
  const projection = PROJECTIONS[name];
  if (projection) {
    if (projection.fromResponse) return projection.fromResponse(value);
    return typeof value === "string" ? value : undefined;
  }
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  return JSON.stringify(value);
}

function absolute(path: unknown, cwd: string): string | undefined {
  if (typeof path !== "string") return undefined;
  if (path.startsWith("/")) return normalize(path);
  return normalize(`${cwd.replace(/\/+$/, "")}/${path}`);
}

/** POSIX path normalization without node:path (core stays runtime-neutral). */
function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

function pick(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
