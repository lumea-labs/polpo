/**
 * Interpretation of one handler run: exit code / HTTP status plus stdout,
 * following the reference tables ("Exit code output", "HTTP response
 * handling", "JSON output"). Event-level composition lives in aggregate.ts.
 */
import { HOOK_EVENTS, type HookEventName } from "./events.js";

/** Raw result of a command hook. */
export interface CommandRunResult {
  kind: "command";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** The process could not be started (missing executable, spawn error). */
  startError?: string;
  /** The hook exited but a background child kept its output pipes open. */
  suspectCapture?: boolean;
}

/** Raw result of an HTTP hook. */
export interface HttpRunResult {
  kind: "http";
  status?: number;
  body?: string;
  /** Connection failure, DNS error, refused policy, oversized body, ... */
  error?: string;
  timedOut?: boolean;
}

/** Raw result of an MCP tool hook: the tool's text content is read like stdout. */
export interface McpToolRunResult {
  kind: "mcp_tool";
  text?: string;
  isError?: boolean;
  error?: string;
  timedOut?: boolean;
  /** The hook was skipped (no MCP context on this event, server unavailable). */
  skipped?: string;
}

/** Raw result of a prompt or agent hook. */
export interface ModelRunResult {
  kind: "prompt" | "agent";
  verdict?: { ok: boolean; reason?: string; impossible?: boolean };
  error?: string;
  timedOut?: boolean;
}

export type HookRunResult = CommandRunResult | HttpRunResult | McpToolRunResult | ModelRunResult;

/** Common JSON output fields plus the event-specific object. */
export interface HookJsonOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  terminalSequence?: string;
  decision?: string;
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;
  [key: string]: unknown;
}

export type HookRunStatus =
  /** Exit 0 (or 2xx), fields apply. */
  | "success"
  /** Exit 2: the event's blocking behavior applies; fields are read but cannot override it. */
  | "blocking"
  /** The action goes ahead; a hook error notice is recorded. */
  | "non_blocking_error"
  /** The hook was not run on this event. */
  | "skipped";

export interface HookRunOutcome {
  status: HookRunStatus;
  /** Counts as a failure for `onFailure: "block"`. */
  failed: boolean;
  timedOut: boolean;
  output?: HookJsonOutput;
  /** Plain stdout on exit 0 (context on the events that use it). */
  plainText?: string;
  /** Blocking reason (stderr) or error notice text. */
  message?: string;
  /** Prompt/agent verdict. */
  verdict?: { ok: boolean; reason?: string; impossible?: boolean };
}

const OUTPUT_FIELDS = new Set([
  "continue", "stopReason", "suppressOutput", "systemMessage", "terminalSequence",
  "decision", "reason", "hookSpecificOutput",
]);

type JsonParse =
  | { kind: "empty" }
  | { kind: "plain"; text: string }
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "invalid"; message: string };

/**
 * Stdout is JSON output only when it is one object with nothing but
 * whitespace around it. Otherwise:
 * - not starting with `{` or not ending with `}` → plain text (arrays, quoted strings too);
 * - several lines that each parse as JSON → plain text, unless one line is an
 *   output object that sets a field, which is a parse failure;
 * - anything else between `{` and `}` that does not parse → parse failure.
 */
export function classifyStdout(stdout: string): JsonParse {
  const trimmed = stdout.trim();
  if (!trimmed) return { kind: "empty" };
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { kind: "plain", text: stdout };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { kind: "json", value: value as Record<string, unknown> };
    }
    return { kind: "plain", text: stdout };
  } catch (error) {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const parsed = lines.map(tryParse);
      if (parsed.every((entry) => entry.ok)) {
        const setsField = parsed.some(({ value }) =>
          value !== null && typeof value === "object" && !Array.isArray(value)
          && Object.keys(value as object).some((key) => OUTPUT_FIELDS.has(key)));
        return setsField
          ? { kind: "invalid", message: "Hook output contains several JSON values; print one JSON object" }
          : { kind: "plain", text: stdout };
      }
    }
    return { kind: "invalid", message: `Hook output is not valid JSON: ${(error as Error).message}` };
  }
}

function tryParse(line: string): { ok: boolean; value?: unknown } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

/** Validate the common fields and `hookSpecificOutput.hookEventName`. Returns an error message or undefined. */
export function validateHookJsonOutput(event: HookEventName, value: Record<string, unknown>): string | undefined {
  const typeErrors: string[] = [];
  const expect = (field: string, type: "boolean" | "string") => {
    if (value[field] !== undefined && typeof value[field] !== type) typeErrors.push(`${field} must be a ${type}`);
  };
  expect("continue", "boolean");
  expect("suppressOutput", "boolean");
  expect("stopReason", "string");
  expect("systemMessage", "string");
  expect("terminalSequence", "string");
  expect("reason", "string");
  if (value.decision !== undefined) {
    const allowed = event === "PreToolUse" ? ["block", "approve"] : ["block"];
    if (typeof value.decision !== "string" || !allowed.includes(value.decision)) {
      typeErrors.push(`decision must be ${allowed.map((v) => `"${v}"`).join(" or ")}`);
    }
  }
  if (value.hookSpecificOutput !== undefined) {
    const specific = value.hookSpecificOutput;
    if (specific === null || typeof specific !== "object" || Array.isArray(specific)) {
      typeErrors.push("hookSpecificOutput must be an object");
    } else if ((specific as Record<string, unknown>).hookEventName !== event) {
      typeErrors.push(`hookSpecificOutput.hookEventName must be "${event}"`);
    } else {
      const specificError = validateSpecificOutput(event, specific as Record<string, unknown>);
      if (specificError) typeErrors.push(specificError);
    }
  }
  return typeErrors.length ? `Hook JSON output failed validation: ${typeErrors.join("; ")}` : undefined;
}

function validateSpecificOutput(event: HookEventName, specific: Record<string, unknown>): string | undefined {
  const str = (field: string) => specific[field] === undefined || typeof specific[field] === "string"
    ? undefined : `hookSpecificOutput.${field} must be a string`;
  const obj = (field: string) => specific[field] === undefined || isRecord(specific[field])
    ? undefined : `hookSpecificOutput.${field} must be an object`;
  const bool = (field: string) => specific[field] === undefined || typeof specific[field] === "boolean"
    ? undefined : `hookSpecificOutput.${field} must be a boolean`;
  const stringArray = (field: string) => specific[field] === undefined
    || (Array.isArray(specific[field]) && (specific[field] as unknown[]).every((v) => typeof v === "string"))
    ? undefined : `hookSpecificOutput.${field} must be an array of strings`;
  const oneOf = (field: string, values: string[]) => specific[field] === undefined || values.includes(specific[field] as string)
    ? undefined : `hookSpecificOutput.${field} must be one of ${values.join(", ")}`;
  const checks: (string | undefined)[] = [str("additionalContext")];
  switch (event) {
    case "PreToolUse":
      checks.push(oneOf("permissionDecision", ["allow", "deny", "ask", "defer"]), str("permissionDecisionReason"), obj("updatedInput"));
      break;
    case "PreModelSwitch":
      checks.push(oneOf("permissionDecision", ["allow", "deny", "ask"]), str("permissionDecisionReason"));
      break;
    case "PermissionRequest": {
      const decision = specific.decision;
      if (decision !== undefined) {
        if (!isRecord(decision)) checks.push("hookSpecificOutput.decision must be an object");
        else {
          if (decision.behavior !== "allow" && decision.behavior !== "deny") checks.push("decision.behavior must be allow or deny");
          if (decision.updatedInput !== undefined && !isRecord(decision.updatedInput)) checks.push("decision.updatedInput must be an object");
          if (decision.updatedPermissions !== undefined && !Array.isArray(decision.updatedPermissions)) checks.push("decision.updatedPermissions must be an array");
          if (decision.message !== undefined && typeof decision.message !== "string") checks.push("decision.message must be a string");
          if (decision.interrupt !== undefined && typeof decision.interrupt !== "boolean") checks.push("decision.interrupt must be a boolean");
        }
      }
      break;
    }
    case "PermissionDenied":
      checks.push(bool("retry"));
      break;
    case "PostToolUse":
      checks.push(str("classifierContext"));
      break;
    case "SessionStart":
      checks.push(str("initialUserMessage"), str("sessionTitle"), stringArray("watchPaths"), bool("reloadSkills"));
      break;
    case "UserPromptSubmit":
      checks.push(str("sessionTitle"), bool("suppressOriginalPrompt"));
      break;
    case "CwdChanged":
    case "FileChanged":
      checks.push(stringArray("watchPaths"));
      break;
    case "MessageDisplay":
      checks.push(str("displayContent"));
      break;
    case "WorktreeCreate":
      checks.push(str("worktreePath"));
      break;
    case "Elicitation":
    case "ElicitationResult":
      checks.push(oneOf("action", ["accept", "decline", "cancel"]), obj("content"));
      break;
  }
  return checks.find(Boolean);
}

/**
 * Interpret one handler run for an event. `onFailure` is applied by the
 * engine using `failed`; this function implements the reference tables only.
 */
export function interpretHookRun(event: HookEventName, result: HookRunResult): HookRunOutcome {
  switch (result.kind) {
    case "command":
      return interpretCommand(event, result);
    case "http":
      return interpretHttp(event, result);
    case "mcp_tool":
      return interpretMcp(event, result);
    case "prompt":
    case "agent":
      return interpretModel(result);
  }
}

function interpretCommand(event: HookEventName, result: CommandRunResult): HookRunOutcome {
  if (result.timedOut) {
    return { status: "non_blocking_error", failed: true, timedOut: true, message: "Hook timed out" };
  }
  if (result.startError !== undefined) {
    return { status: "non_blocking_error", failed: true, timedOut: false, message: firstLine(result.startError) };
  }
  if (result.suspectCapture) {
    return {
      status: "non_blocking_error",
      failed: true,
      timedOut: false,
      message: "Hook left a background process attached to its output; refusing to honor the suspect capture",
    };
  }
  const parsed = classifyStdout(result.stdout);
  const code = result.exitCode;
  const spec = HOOK_EVENTS[event];

  if (code === 2) {
    if (spec.missingFileExit2IsNonBlocking && parsed.kind === "empty" && /No such file or directory/.test(result.stderr)) {
      return { status: "non_blocking_error", failed: true, timedOut: false, message: firstLine(result.stderr) };
    }
    const output = parsed.kind === "json" && !validateHookJsonOutput(event, parsed.value)
      ? stripSpecificOutputUnlessExit0(event, parsed.value as HookJsonOutput, false)
      : undefined;
    return { status: "blocking", failed: false, timedOut: false, message: result.stderr.trim(), ...(output ? { output } : {}) };
  }

  if (parsed.kind === "invalid") {
    return { status: "non_blocking_error", failed: true, timedOut: false, message: parsed.message };
  }
  if (parsed.kind === "json") {
    const invalid = validateHookJsonOutput(event, parsed.value);
    if (invalid) return { status: "non_blocking_error", failed: true, timedOut: false, message: invalid };
    // Exit 0, or any other code with valid JSON: the fields alone decide.
    // A non-zero, non-2 exit still counts as a failure for onFailure: "block".
    return {
      status: "success",
      failed: code !== 0,
      timedOut: false,
      output: stripSpecificOutputUnlessExit0(event, parsed.value as HookJsonOutput, code === 0),
    };
  }
  if (code === 0) {
    return {
      status: "success",
      failed: false,
      timedOut: false,
      ...(parsed.kind === "plain" ? { plainText: parsed.text } : {}),
    };
  }
  return {
    status: "non_blocking_error",
    failed: true,
    timedOut: false,
    message: `Failed with non-blocking status code: ${firstLine(result.stderr) || `exit ${code ?? "signal"}`}`,
  };
}

function interpretHttp(event: HookEventName, result: HttpRunResult): HookRunOutcome {
  if (result.timedOut) return { status: "non_blocking_error", failed: true, timedOut: true, message: "Hook timed out" };
  if (result.error !== undefined) return { status: "non_blocking_error", failed: true, timedOut: false, message: result.error };
  const status = result.status ?? 0;
  if (status < 200 || status > 299) {
    return { status: "non_blocking_error", failed: true, timedOut: false, message: `HTTP hook returned status ${status}` };
  }
  const body = (result.body ?? "").trim();
  if (!body) return { status: "success", failed: false, timedOut: false };
  const parsed = classifyStdout(body);
  if (parsed.kind !== "json") {
    // 2xx with a non-object body is a non-blocking error; the text is never model context.
    return { status: "non_blocking_error", failed: true, timedOut: false, message: "HTTP hook returned a body that is not a JSON object" };
  }
  const invalid = validateHookJsonOutput(event, parsed.value);
  if (invalid) return { status: "non_blocking_error", failed: true, timedOut: false, message: invalid };
  return { status: "success", failed: false, timedOut: false, output: parsed.value as HookJsonOutput };
}

function interpretMcp(event: HookEventName, result: McpToolRunResult): HookRunOutcome {
  if (result.skipped !== undefined) return { status: "skipped", failed: false, timedOut: false, message: result.skipped };
  if (result.timedOut) return { status: "non_blocking_error", failed: true, timedOut: true, message: "Hook timed out" };
  if (result.error !== undefined) return { status: "non_blocking_error", failed: true, timedOut: false, message: result.error };
  if (result.isError) {
    return { status: "non_blocking_error", failed: true, timedOut: false, message: firstLine(result.text ?? "MCP tool returned an error") };
  }
  // The tool's text content follows the exit-0 stdout rule.
  return interpretCommand(event, { kind: "command", exitCode: 0, stdout: result.text ?? "", stderr: "" });
}

function interpretModel(result: ModelRunResult): HookRunOutcome {
  if (result.timedOut) return { status: "non_blocking_error", failed: true, timedOut: true, message: "Hook timed out" };
  if (result.error !== undefined || !result.verdict) {
    return { status: "non_blocking_error", failed: true, timedOut: false, message: result.error ?? "Hook model returned no verdict" };
  }
  if (result.verdict.ok === false && !result.verdict.reason?.trim()) {
    return { status: "non_blocking_error", failed: true, timedOut: false, message: "Hook model returned ok: false without a reason" };
  }
  return { status: "success", failed: false, timedOut: false, verdict: result.verdict };
}

function stripSpecificOutputUnlessExit0(event: HookEventName, output: HookJsonOutput, exit0: boolean): HookJsonOutput {
  if (!HOOK_EVENTS[event].specificOutputOnlyOnExit0 || exit0 || output.hookSpecificOutput === undefined) return output;
  const { hookSpecificOutput: _ignored, ...rest } = output;
  return rest;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** OSC 0/1/2/9/99/777 and BEL only; anything else rejects the whole field. */
export function isAllowedTerminalSequence(value: string): boolean {
  let rest = value;
  while (rest.length) {
    if (rest.startsWith("\u0007")) { rest = rest.slice(1); continue; }
    const match = /^\u001b\](0|1|2|9|99|777);[^\u0007\u001b]*(?:\u0007|\u001b\\)/.exec(rest);
    if (!match) return false;
    rest = rest.slice(match[0].length);
  }
  return value.length > 0;
}
