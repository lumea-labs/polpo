/**
 * Claude Code–compatible hook engine: resolves matching handlers for an event,
 * runs them (in parallel, model hooks capped), interprets every run with the
 * reference tables and composes one event result.
 */
import {
  HOOK_EVENTS,
  MODEL_HOOK_CONCURRENCY,
  SESSION_END_MAX_BUDGET_SECONDS,
  hookTimeoutMs,
  type HookEventName,
} from "./events.js";
import { HOOK_SOURCES, type HookHandler, type HookSource, type HooksConfig } from "./config.js";
import { compileHookMatcher, fileChangedWatchNames, type CompiledHookMatcher } from "./matcher.js";
import { matchesPermissionRule, parsePermissionRule, type PermissionRule, type PermissionRuleContext } from "./permission-rule.js";
import {
  interpretHookRun,
  type CommandRunResult,
  type HookRunOutcome,
  type HookRunResult,
  type HttpRunResult,
  type McpToolRunResult,
  type ModelRunResult,
} from "./output.js";
import { composeHookEvent, emptyHookEventResult, type ComposeEntry, type HookEventResult } from "./aggregate.js";

/** One configured hook source, e.g. a deployed pack or an activated skill. */
export interface HookConfigSource {
  source: HookSource;
  /** Pack, skill or agent name; shown in traces and `ask` labels. */
  name: string;
  hooks: HooksConfig;
  /** Managed policy sources survive `disableAllHooks` from lower scopes. */
  managed?: boolean;
}

/** The JSON a handler receives: common fields plus event-specific fields. */
export type HookInput = Record<string, unknown> & {
  session_id: string;
  cwd: string;
};

export interface HookDispatchOptions {
  signal?: AbortSignal;
  /**
   * Stable identity of this occurrence. Replay of the same occurrence reuses
   * terminal receipts; a genuinely new occurrence (e.g. a new Stop attempt)
   * must use a new id. Defaults to a hash of the event input.
   */
  occurrenceId?: string;
  /** Value the matcher is evaluated against, when not the event's plain field. */
  matcherSubject?: string;
  /** Required for `if` rules on tool events. */
  permissionContext?: PermissionRuleContext;
  /** Extra environment for command hooks (CLAUDE_ENV_FILE, ...). */
  env?: Record<string, string>;
  /** TaskCompleted fired because a teammate stopped. */
  taskCompletedByTeammate?: boolean;
  /** Depth of hook-originated activity; hooks are not dispatched beyond the fence. */
  hookDepth?: number;
}

export interface CommandHookRequest {
  event: HookEventName;
  handler: Extract<HookHandler, { type: "command" }>;
  /** Exec form when defined: spawn `command` with these arguments, no shell. */
  argv?: string[];
  command: string;
  shell: "bash" | "powershell";
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface HttpHookRequest {
  event: HookEventName;
  handler: Extract<HookHandler, { type: "http" }>;
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface McpToolHookRequest {
  event: HookEventName;
  handler: Extract<HookHandler, { type: "mcp_tool" }>;
  input: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ModelHookRequest {
  event: HookEventName;
  handler: Extract<HookHandler, { type: "prompt" | "agent" }>;
  /** Prompt with `$ARGUMENTS` substituted (or the input appended). */
  prompt: string;
  input: HookInput;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Durable record of one handler execution. */
export interface HookExecutionRecord {
  key: string;
  occurrenceId: string;
  event: HookEventName;
  source: HookSource;
  sourceName: string;
  handlerType: HookHandler["type"];
  label: string;
  status: HookRunOutcome["status"];
  failed: boolean;
  timedOut: boolean;
  async: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: HookRunOutcome;
}

/** Host capabilities. A missing handler family yields a non-blocking error, never silent success. */
export interface HookHost {
  runCommand?(request: CommandHookRequest): Promise<CommandRunResult>;
  runHttp?(request: HttpHookRequest): Promise<HttpRunResult>;
  runMcpTool?(request: McpToolHookRequest): Promise<McpToolRunResult>;
  runPrompt?(request: ModelHookRequest): Promise<ModelRunResult>;
  runAgent?(request: ModelHookRequest): Promise<ModelRunResult>;
  /** Environment values HTTP hooks may interpolate (only names in `allowedEnvVars`). */
  httpEnv?(): Record<string, string | undefined>;
  /** Persist over-cap hook text; returns the path shown to the model. */
  spill?(text: string): string | undefined;
  /** Durable replay: a terminal execution for this key, if any. */
  findCompleted?(key: string): Promise<HookExecutionRecord | undefined>;
  /** Persist a terminal execution before its decision takes effect. */
  record?(record: HookExecutionRecord): Promise<void>;
  /** Deliver an async hook's completed outcome to the next turn (async / asyncRewake). */
  deliverAsync?(record: HookExecutionRecord, event: HookEventResult, rewake: boolean): void | Promise<void>;
}

export interface HookEngineOptions {
  sources: readonly HookConfigSource[];
  host: HookHost;
  /** Project root: `CLAUDE_PROJECT_DIR` and the base of `/path` rules. */
  projectDir: string;
  /** `disableAllHooks` resolved from non-managed settings. */
  disableAllHooks?: boolean;
  /** `disableAllHooks` from managed policy: disables managed hooks too. */
  disableManagedHooks?: boolean;
  /** Environment exported to every command hook (Polpo identity, CLAUDE_CODE_REMOTE, ...). */
  baseEnv?: Record<string, string>;
  now?: () => Date;
  /** Maximum hook-originated depth that may still dispatch hooks. */
  maxHookDepth?: number;
}

interface Registration {
  key: string;
  event: HookEventName;
  source: HookSource;
  sourceName: string;
  managed: boolean;
  matcher: CompiledHookMatcher;
  rawMatcher?: string;
  ifRule?: PermissionRule;
  handler: HookHandler;
  label: string;
  order: number;
}

const DEDUPED_SOURCES = new Set<HookSource>(["policy", "project", "local", "agent"]);

export class HookEngine {
  private readonly registrations: Registration[] = [];
  private readonly consumedOnce = new Set<string>();
  private readonly host: HookHost;
  private readonly projectDir: string;
  private readonly now: () => Date;
  private readonly baseEnv: Record<string, string>;
  private readonly maxHookDepth: number;

  constructor(options: HookEngineOptions) {
    this.host = options.host;
    this.projectDir = options.projectDir;
    this.now = options.now ?? (() => new Date());
    this.baseEnv = options.baseEnv ?? {};
    this.maxHookDepth = options.maxHookDepth ?? 1;
    const sources = [...options.sources].sort((a, b) => HOOK_SOURCES.indexOf(a.source) - HOOK_SOURCES.indexOf(b.source));
    const seen = new Set<string>();
    let order = 0;
    for (const source of sources) {
      const managed = source.managed === true || source.source === "policy";
      if (managed ? options.disableManagedHooks : options.disableAllHooks) continue;
      for (const [eventName, groups] of Object.entries(source.hooks)) {
        const event = eventName as HookEventName;
        // A subagent's Stop hook is the SubagentStop event.
        const effectiveEvent: HookEventName = source.source === "subagent" && event === "Stop" ? "SubagentStop" : event;
        for (const group of groups ?? []) {
          const matcher = compileHookMatcher(effectiveEvent, group.matcher);
          for (const handler of group.hooks) {
            const identity = handlerIdentity(effectiveEvent, group.matcher, handler);
            // The same handler in several settings files runs once; skill/subagent copies stay separate.
            if (DEDUPED_SOURCES.has(source.source)) {
              if (seen.has(identity)) continue;
              seen.add(identity);
            }
            this.registrations.push({
              key: `${source.source}:${source.name}:${identity}`,
              event: effectiveEvent,
              source: source.source,
              sourceName: source.name,
              managed,
              matcher,
              ...(group.matcher !== undefined ? { rawMatcher: group.matcher } : {}),
              ...(handler.if ? { ifRule: parsePermissionRule(handler.if) } : {}),
              handler,
              label: handlerLabel(handler),
              order: order++,
            });
          }
        }
      }
    }
  }

  /** Whether any handler is registered for the event (cheap pre-check for hot paths). */
  has(event: HookEventName): boolean {
    return this.registrations.some((registration) => registration.event === event);
  }

  /** Literal filenames FileChanged matchers ask to watch. */
  fileChangedWatchList(): string[] {
    const names = new Set<string>();
    for (const registration of this.registrations) {
      if (registration.event !== "FileChanged") continue;
      for (const name of fileChangedWatchNames(registration.rawMatcher)) names.add(name);
    }
    return [...names];
  }

  async dispatch(event: HookEventName, eventInput: HookInput, options: HookDispatchOptions = {}): Promise<HookEventResult> {
    options.signal?.throwIfAborted();
    if ((options.hookDepth ?? 0) > this.maxHookDepth) return emptyHookEventResult(event);
    const spec = HOOK_EVENTS[event];
    const input: HookInput = { ...eventInput, hook_event_name: event };
    const subject = options.matcherSubject ?? (spec.matcherField ? stringValue(input[spec.matcherField]) : undefined);
    const toolName = spec.toolEvent ? stringValue(input.tool_name) : undefined;
    const toolInput = spec.toolEvent && isRecord(input.tool_input) ? input.tool_input : undefined;

    const selected = this.registrations.filter((registration) => {
      if (registration.event !== event) return false;
      if (registration.handler.once && registration.source === "skill" && this.consumedOnce.has(registration.key)) return false;
      if (!registration.matcher(event === "FileChanged" ? basename(stringValue(input.file_path)) : subject)) return false;
      if (registration.ifRule) {
        // `if` is evaluated only on tool events; elsewhere a hook with `if` never runs.
        if (!spec.toolEvent || !toolName || !options.permissionContext) return false;
        return matchesPermissionRule(registration.ifRule, toolName, toolInput ?? {}, options.permissionContext);
      }
      return true;
    });
    if (!selected.length) return emptyHookEventResult(event);

    const occurrenceId = options.occurrenceId ?? stableHash(JSON.stringify([event, input]));
    const stdin = JSON.stringify(input);
    const budgetMs = event === "SessionEnd" ? sessionEndBudgetMs(selected) : undefined;
    const runModel = limiter(MODEL_HOOK_CONCURRENCY);

    const entries = await Promise.all(selected.map(async (registration): Promise<ComposeEntry | undefined> => {
      const isModel = registration.handler.type === "prompt" || registration.handler.type === "agent";
      const run = () => this.runOne(event, registration, input, stdin, occurrenceId, budgetMs, options);
      const record = isModel ? await runModel(run) : await run();
      if (!record) return undefined;
      if (record.async) return undefined;
      if (registration.handler.once && registration.source === "skill" && record.outcome.status === "success" && !record.outcome.failed) {
        this.consumedOnce.add(registration.key);
      }
      return this.entryFor(event, registration, record.outcome, toolName ?? subject);
    }));

    return composeHookEvent(event, entries.filter((entry): entry is ComposeEntry => entry !== undefined), {
      ...(this.host.spill ? { spill: (text: string) => this.host.spill!(text) } : {}),
      ...(options.taskCompletedByTeammate !== undefined ? { taskCompletedByTeammate: options.taskCompletedByTeammate } : {}),
    });
  }

  private entryFor(event: HookEventName, registration: Registration, outcome: HookRunOutcome, subject: string | undefined): ComposeEntry {
    const spec = HOOK_EVENTS[event];
    const handler = registration.handler;
    const supportsOnFailure = handler.type === "command" || handler.type === "http";
    const onFailure = supportsOnFailure ? (handler as { onFailure?: string }).onFailure : undefined;
    const background = handler.type === "command" && (handler.async === true || handler.asyncRewake === true);
    const failureBlocks = outcome.failed
      && ((onFailure === "block" && !spec.onFailureIgnored && !background)
        || (spec.timeoutBlocks === true && outcome.timedOut));
    return {
      hookLabel: registration.label,
      handler,
      outcome,
      failureBlocks,
      ...(subject ? { subject } : {}),
    };
  }

  private async runOne(
    event: HookEventName,
    registration: Registration,
    input: HookInput,
    stdin: string,
    occurrenceId: string,
    budgetMs: number | undefined,
    options: HookDispatchOptions,
  ): Promise<HookExecutionRecord | undefined> {
    const key = stableHash(`${occurrenceId}\u0000${registration.key}`);
    const replay = await this.host.findCompleted?.(key);
    if (replay) return replay;

    const handler = registration.handler;
    const spec = HOOK_EVENTS[event];
    if (spec.skippedHandlers?.includes(handler.type)) {
      return this.finish(key, occurrenceId, event, registration, this.now(), {
        status: "skipped", failed: false, timedOut: false,
        message: `${handler.type} hooks are not available for the '${event}' hook event`,
      }, false);
    }
    const async = handler.type === "command" && (handler.async === true || handler.asyncRewake === true);
    const configuredTimeout = handler.timeout;
    const timeoutMs = budgetMs !== undefined && configuredTimeout === undefined
      ? budgetMs
      : hookTimeoutMs(event, handler.type, configuredTimeout);

    const startedAt = this.now();
    const execute = async (): Promise<HookExecutionRecord> => {
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      // Background command hooks are not bound by `timeout` once running, except asyncRewake.
      const enforceTimeout = !(handler.type === "command" && handler.async === true && handler.asyncRewake !== true);
      const timer = enforceTimeout ? setTimeout(() => controller.abort(new HookTimeoutError()), timeoutMs) : undefined;
      try {
        const raw = await this.invoke(event, registration, input, stdin, timeoutMs, controller.signal, options);
        const result = controller.signal.reason instanceof HookTimeoutError ? markTimedOut(raw) : raw;
        return await this.finish(key, occurrenceId, event, registration, startedAt, interpretHookRun(event, result), async);
      } catch (error) {
        if (options.signal?.aborted && !(controller.signal.reason instanceof HookTimeoutError)) throw error;
        const timedOut = controller.signal.reason instanceof HookTimeoutError;
        return await this.finish(key, occurrenceId, event, registration, startedAt, {
          status: "non_blocking_error",
          failed: true,
          timedOut,
          message: timedOut ? "Hook timed out" : safeMessage(error),
        }, async);
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      }
    };

    if (async) {
      // Detach: async hooks cannot control the action; their context arrives next turn.
      void execute().then(async (record) => {
        const composed = composeHookEvent(event, [this.entryFor(event, registration, record.outcome, undefined)]);
        const rewake = handler.type === "command" && handler.asyncRewake === true && record.outcome.status === "blocking";
        await this.host.deliverAsync?.(record, composed, rewake);
      }).catch(() => {});
      return { ...placeholderRecord(key, occurrenceId, event, registration, startedAt), async: true };
    }
    return execute();
  }

  private async invoke(
    event: HookEventName,
    registration: Registration,
    input: HookInput,
    stdin: string,
    timeoutMs: number,
    signal: AbortSignal,
    options: HookDispatchOptions,
  ): Promise<HookRunResult> {
    const handler = registration.handler;
    switch (handler.type) {
      case "command": {
        if (!this.host.runCommand) return { kind: "command", exitCode: null, stdout: "", stderr: "", startError: "Command hooks are not available on this host" };
        const env = {
          ...this.baseEnv,
          ...options.env,
          CLAUDE_PROJECT_DIR: this.projectDir,
          ...(isRecord(input.effort) && typeof input.effort.level === "string" ? { CLAUDE_EFFORT: input.effort.level } : {}),
        };
        const exec = handler.args !== undefined;
        const substitute = (value: string) => substitutePathPlaceholders(value, env);
        return this.host.runCommand({
          event,
          handler,
          command: exec ? substitute(handler.command) : handler.command,
          ...(exec ? { argv: handler.args!.map(substitute) } : {}),
          shell: handler.shell ?? "bash",
          stdin,
          env,
          cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : this.projectDir,
          timeoutMs,
          signal,
        });
      }
      case "http": {
        if (!this.host.runHttp) return { kind: "http", error: "HTTP hooks are not available on this host" };
        const allowed = new Set(handler.allowedEnvVars ?? []);
        const values = this.host.httpEnv?.() ?? {};
        const headers = Object.fromEntries(Object.entries(handler.headers ?? {}).map(([name, value]) =>
          [name, interpolateHeader(value, (variable) => allowed.has(variable) ? values[variable] ?? "" : "")]));
        return this.host.runHttp({
          event,
          handler,
          url: handler.url,
          headers: { ...headers, "content-type": "application/json" },
          body: stdin,
          timeoutMs,
          signal,
        });
      }
      case "mcp_tool": {
        if (!this.host.runMcpTool) return { kind: "mcp_tool", error: "MCP tool hooks are not available on this host" };
        return this.host.runMcpTool({
          event,
          handler,
          input: substituteInputTemplates(handler.input ?? {}, input) as Record<string, unknown>,
          timeoutMs,
          signal,
        });
      }
      case "prompt":
      case "agent": {
        const run = handler.type === "prompt" ? this.host.runPrompt : this.host.runAgent;
        if (!run) return { kind: handler.type, error: `${handler.type} hooks are not available on this host` };
        return run.call(this.host, {
          event,
          handler,
          prompt: renderHookPrompt(handler.prompt, stdin),
          input,
          timeoutMs,
          signal,
        });
      }
    }
  }

  private async finish(
    key: string,
    occurrenceId: string,
    event: HookEventName,
    registration: Registration,
    startedAt: Date,
    outcome: HookRunOutcome,
    async: boolean,
  ): Promise<HookExecutionRecord> {
    const completedAt = this.now();
    const record: HookExecutionRecord = {
      key,
      occurrenceId,
      event,
      source: registration.source,
      sourceName: registration.sourceName,
      handlerType: registration.handler.type,
      label: registration.label,
      status: outcome.status,
      failed: outcome.failed,
      timedOut: outcome.timedOut,
      async,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      outcome,
    };
    // A decision must not take effect before its receipt is durable.
    await this.host.record?.(record);
    return record;
  }
}

class HookTimeoutError extends Error {
  override readonly name = "HookTimeoutError";
  constructor() { super("Hook timed out"); }
}

function markTimedOut(result: HookRunResult): HookRunResult {
  return { ...result, timedOut: true } as HookRunResult;
}

function placeholderRecord(key: string, occurrenceId: string, event: HookEventName, registration: Registration, startedAt: Date): HookExecutionRecord {
  const at = startedAt.toISOString();
  return {
    key, occurrenceId, event,
    source: registration.source, sourceName: registration.sourceName,
    handlerType: registration.handler.type, label: registration.label,
    status: "success", failed: false, timedOut: false, async: true,
    startedAt: at, completedAt: at, durationMs: 0,
    outcome: { status: "success", failed: false, timedOut: false },
  };
}

function sessionEndBudgetMs(selected: readonly Registration[]): number {
  const configured = selected.map((registration) => registration.handler.timeout).filter((value): value is number => typeof value === "number");
  const seconds = Math.min(SESSION_END_MAX_BUDGET_SECONDS, Math.max(HOOK_EVENTS.SessionEnd.defaultTimeoutSeconds, ...configured));
  return Math.round(seconds * 1000);
}

/** `$ARGUMENTS` → input JSON; `\$` is a literal `$`; input appended when absent. */
export function renderHookPrompt(prompt: string, inputJson: string): string {
  let found = false;
  const rendered = prompt.replace(/\\\$|\$ARGUMENTS/g, (match) => {
    if (match === "\\$") return "$";
    found = true;
    return inputJson;
  });
  return found ? rendered : `${rendered}\n\n${inputJson}`;
}

/** `${path.to.field}` in MCP tool input strings, resolved from the hook input. */
export function substituteInputTemplates(value: unknown, input: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (_match, path: string) => {
      const resolved = path.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, input);
      if (resolved === undefined || resolved === null) return "";
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substituteInputTemplates(item, input));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteInputTemplates(item, input)]));
  return value;
}

/** `$VAR` / `${VAR}` in header values; unlisted variables become "". */
export function interpolateHeader(value: string, resolve: (name: string) => string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string | undefined, bare: string | undefined) =>
    resolve((braced ?? bare)!));
}

/** `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` as plain strings (exec form). */
export function substitutePathPlaceholders(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g, (match, name: string) => env[name] ?? match);
}

function limiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function handlerIdentity(event: HookEventName, matcher: string | undefined, handler: HookHandler): string {
  return JSON.stringify({ event, matcher, handler: canonicalJson(handler) });
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}

function handlerLabel(handler: HookHandler): string {
  switch (handler.type) {
    case "command":
      return [handler.command, ...(handler.args ?? [])].join(" ");
    case "http":
      return handler.url;
    case "mcp_tool":
      return `${handler.server}/${handler.tool}`;
    case "prompt":
    case "agent":
      return `${handler.type}: ${handler.prompt.slice(0, 60)}`;
  }
}

function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deterministic identity hash (not a secret). */
export function stableHash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    a ^= code;
    a = Math.imul(a, 0x01000193);
    b ^= code + Math.imul(index + 1, 0x45d9f3b);
    b = Math.imul(b, 0x27d4eb2d);
  }
  const hex = (part: number) => (part >>> 0).toString(16).padStart(8, "0");
  return `${hex(a)}${hex(b)}${hex(a ^ b)}${hex(Math.imul(a, b))}`;
}
