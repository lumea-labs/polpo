export const RUNTIME_HOOK_CONTRACT_VERSION = 1 as const;
export const DEFAULT_RUNTIME_HOOK_TIMEOUT_MS = 5_000;
export const DEFAULT_RUNTIME_HOOK_MAX_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_RUNTIME_HOOK_MAX_DEPTH = 2;

export type RuntimeHookEventName =
  | "session:start"
  | "session:resume"
  | "session:end"
  | "input:before"
  | "turn:stop"
  | "turn:error"
  | "model:before"
  | "model:after"
  | "model:error"
  | "tool:before"
  | "approval:request"
  | "approval:denied"
  | "tool:after"
  | "tool:error"
  | "tool:batch:after"
  | "agent:spawn"
  | "agent:end"
  | "context:compact:before"
  | "context:compact:after"
  | "model:switch:before"
  | "model:switch:after"
  | "loop:start"
  | "step:before"
  | "loop:transition"
  | "step:after"
  | "loop:stop"
  | "loop:end"
  | "sandbox:start"
  | "sandbox:cwd_changed"
  | "sandbox:file_changed"
  | "sandbox:end"
  | "run:start"
  | "run:end";

export type RuntimeHookSurface =
  | "chat"
  | "loop"
  | "channel"
  | "task"
  | "schedule"
  | "runtime";

export type RuntimeHookScope =
  | "platform"
  | "organization"
  | "project"
  | "environment"
  | "agent"
  | "skill"
  | "loop"
  | "step";

export const RUNTIME_HOOK_EVENT_NAMES = [
  "session:start", "session:resume", "session:end", "input:before", "turn:stop", "turn:error",
  "model:before", "model:after", "model:error", "tool:before", "approval:request", "approval:denied",
  "tool:after", "tool:error", "tool:batch:after", "agent:spawn", "agent:end",
  "context:compact:before", "context:compact:after", "model:switch:before", "model:switch:after",
  "loop:start", "step:before", "loop:transition", "step:after", "loop:stop", "loop:end",
  "sandbox:start", "sandbox:cwd_changed", "sandbox:file_changed", "sandbox:end", "run:start", "run:end",
] as const satisfies readonly RuntimeHookEventName[];

export const RUNTIME_HOOK_HANDLER_TYPES = [
  "command", "http", "tool", "mcp_tool", "prompt", "agent",
] as const satisfies readonly RuntimeHookHandler["type"][];

export const RUNTIME_HOOK_SURFACE_NAMES = [
  "chat", "loop", "channel", "task", "schedule", "runtime",
] as const satisfies readonly RuntimeHookSurface[];

export const RUNTIME_HOOK_SCOPE_NAMES = [
  "platform", "organization", "project", "environment", "agent", "skill", "loop", "step",
] as const satisfies readonly RuntimeHookScope[];

export interface RuntimeHookCapabilities {
  contractVersion: typeof RUNTIME_HOOK_CONTRACT_VERSION;
  events: readonly RuntimeHookEventName[];
  handlerTypes: readonly RuntimeHookHandler["type"][];
  surfaces: readonly RuntimeHookSurface[];
  scopes: readonly RuntimeHookScope[];
  durableReplay: true;
  fileEvents: "tool_attributed";
}

export const PORTABLE_RUNTIME_HOOK_CAPABILITIES: RuntimeHookCapabilities = Object.freeze({
  contractVersion: RUNTIME_HOOK_CONTRACT_VERSION,
  events: RUNTIME_HOOK_EVENT_NAMES,
  handlerTypes: RUNTIME_HOOK_HANDLER_TYPES,
  surfaces: RUNTIME_HOOK_SURFACE_NAMES,
  scopes: RUNTIME_HOOK_SCOPE_NAMES,
  durableReplay: true,
  fileEvents: "tool_attributed",
});

export type RuntimeHookJson =
  | string
  | number
  | boolean
  | null
  | RuntimeHookJson[]
  | { [key: string]: RuntimeHookJson };

export interface RuntimeHookIdentity {
  projectId?: string;
  environment?: string;
  organizationId?: string;
  runId?: string;
  sessionId?: string;
  turnId?: string;
  agent?: string;
  loop?: string;
  step?: string;
  toolCallId?: string;
  externalUserId?: string;
}

export interface RuntimeHookOrigin {
  kind: "runtime" | "hook";
  depth: number;
  hookId?: string;
}

export interface RuntimeHookEnvelope {
  version: typeof RUNTIME_HOOK_CONTRACT_VERSION;
  event: RuntimeHookEventName;
  eventId: string;
  occurredAt: string;
  surface: RuntimeHookSurface;
  identity: Readonly<RuntimeHookIdentity>;
  data: Readonly<Record<string, RuntimeHookJson>>;
  origin: RuntimeHookOrigin;
}

export interface RuntimeHookMatcher {
  surfaces?: RuntimeHookSurface[];
  agents?: string[];
  loops?: string[];
  steps?: string[];
  tools?: string[];
}

interface RuntimeHookHandlerBase {
  timeoutMs?: number;
}

export interface RuntimeHookCommandHandler extends RuntimeHookHandlerBase {
  type: "command";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface RuntimeHookHttpHandler extends RuntimeHookHandlerBase {
  type: "http";
  url: string;
  connection?: string;
  headers?: Record<string, string>;
}

export interface RuntimeHookToolHandler extends RuntimeHookHandlerBase {
  type: "tool";
  tool: string;
  input?: Record<string, RuntimeHookJson>;
}

export interface RuntimeHookMcpToolHandler extends RuntimeHookHandlerBase {
  type: "mcp_tool";
  connection: string;
  tool: string;
  input?: Record<string, RuntimeHookJson>;
}

export interface RuntimeHookPromptHandler extends RuntimeHookHandlerBase {
  type: "prompt";
  prompt: string;
  model?: string;
  maxOutputTokens?: number;
}

export interface RuntimeHookAgentHandler extends RuntimeHookHandlerBase {
  type: "agent";
  agent: string;
  prompt: string;
  allowedTools?: string[];
  maxTurns?: number;
}

export type RuntimeHookHandler =
  | RuntimeHookCommandHandler
  | RuntimeHookHttpHandler
  | RuntimeHookToolHandler
  | RuntimeHookMcpToolHandler
  | RuntimeHookPromptHandler
  | RuntimeHookAgentHandler;

export interface RuntimeHookDefinition {
  id: string;
  event: RuntimeHookEventName;
  scope?: RuntimeHookScope;
  priority?: number;
  mode?: "control" | "observe";
  onFailure?: "continue" | "block";
  matcher?: RuntimeHookMatcher;
  handler: RuntimeHookHandler;
  enabled?: boolean;
  /** Recursive hook execution is denied unless explicitly enabled and bounded. */
  allowRecursive?: boolean;
}

export interface RuntimeHookPack {
  version: typeof RUNTIME_HOOK_CONTRACT_VERSION;
  name: string;
  hooks: RuntimeHookDefinition[];
}

export interface RuntimeHookPackStore {
  list(): Promise<RuntimeHookPack[]>;
  get(name: string): Promise<RuntimeHookPack | undefined>;
  put(pack: RuntimeHookPack): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export type RuntimeHookDecision =
  | { action: "allow"; message?: string }
  | { action: "deny"; reason: string; code?: string }
  | { action: "ask"; reason: string; prompt?: string }
  | { action: "defer"; reason: string }
  | { action: "modify"; data: Record<string, RuntimeHookJson>; message?: string }
  | { action: "stop"; reason?: string; feedback?: string };

export interface RuntimeHookHandlerResult {
  decision?: RuntimeHookDecision;
  output?: RuntimeHookJson;
}

export interface RuntimeHookExecutionRequest {
  hook: RuntimeHookDefinition;
  envelope: RuntimeHookEnvelope;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface RuntimeHookHost {
  execute(request: RuntimeHookExecutionRequest): Promise<RuntimeHookHandlerResult | void>;
  /** Return a prior terminal execution to make durable Run replay side-effect free. */
  findCompleted?(
    request: RuntimeHookExecutionRequest,
  ): Promise<RuntimeHookReplay | undefined>;
  /** Persist the redacted terminal record and replayable controlling decision. */
  trace?(
    execution: RuntimeHookExecution,
    decision?: RuntimeHookDecision,
    envelope?: RuntimeHookEnvelope,
  ): void | Promise<void>;
}

export interface RuntimeHookReplay {
  execution: RuntimeHookExecution;
  decision?: RuntimeHookDecision;
}

export interface RuntimeHookExecution {
  idempotencyKey: string;
  eventId: string;
  hookId: string;
  handlerType: RuntimeHookHandler["type"];
  event: RuntimeHookEventName;
  scope: RuntimeHookScope;
  mode: "control" | "observe";
  priority: number;
  attempt: number;
  timeoutMs: number;
  onFailure: "continue" | "block";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: "allowed" | "denied" | "modified" | "stopped" | "observed" | "failed" | "timed_out";
  decision?: RuntimeHookDecision["action"];
  error?: string;
  replayed?: boolean;
}

export interface RuntimeHookDispatchResult {
  envelope: RuntimeHookEnvelope;
  decision: RuntimeHookDecision;
  executions: RuntimeHookExecution[];
}

export interface RuntimeHookDispatchInput {
  event: RuntimeHookEventName;
  surface: RuntimeHookSurface;
  identity?: RuntimeHookIdentity;
  data?: Record<string, unknown>;
  eventId?: string;
  occurredAt?: string;
  origin?: RuntimeHookOrigin;
}

export interface RuntimeHookDispatcher {
  dispatch(input: RuntimeHookDispatchInput): Promise<RuntimeHookDispatchResult>;
}

export interface RuntimeHookEngineOptions {
  definitions: readonly RuntimeHookDefinition[];
  host: RuntimeHookHost;
  now?: () => Date;
  maxPayloadBytes?: number;
  maxDepth?: number;
}

const SCOPE_ORDER: Record<RuntimeHookScope, number> = {
  platform: 0,
  organization: 1,
  project: 2,
  environment: 3,
  agent: 4,
  skill: 5,
  loop: 6,
  step: 7,
};

const SENSITIVE_KEY = /(?:authorization|cookie|secret|password|token|api[_-]?key|credential|private[_-]?key)/i;

export class RuntimeHookValidationError extends Error {
  override readonly name = "RuntimeHookValidationError";
}

export class RuntimeHookBlockedError extends Error {
  override readonly name = "RuntimeHookBlockedError";
  constructor(
    message: string,
    public readonly hookId: string,
    public readonly code = "runtime_hook_blocked",
  ) {
    super(message);
  }
}

export class RuntimeHookEngine implements RuntimeHookDispatcher {
  private readonly definitions: RuntimeHookDefinition[];
  private readonly host: RuntimeHookHost;
  private readonly now: () => Date;
  private readonly maxPayloadBytes: number;
  private readonly maxDepth: number;

  constructor(options: RuntimeHookEngineOptions) {
    this.host = options.host;
    this.now = options.now ?? (() => new Date());
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_RUNTIME_HOOK_MAX_PAYLOAD_BYTES;
    this.maxDepth = options.maxDepth ?? DEFAULT_RUNTIME_HOOK_MAX_DEPTH;
    this.definitions = options.definitions.map((definition, index) =>
      validateRuntimeHookDefinition(definition, index));
  }

  async dispatch(input: RuntimeHookDispatchInput): Promise<RuntimeHookDispatchResult> {
    const envelope = createRuntimeHookEnvelope(input, this.now, this.maxPayloadBytes);
    const matching = this.definitions
      .map((definition, declarationOrder) => ({ definition, declarationOrder }))
      .filter(({ definition }) => definition.enabled !== false && definition.event === envelope.event)
      .filter(({ definition }) => matchesRuntimeHook(definition.matcher, envelope))
      .filter(({ definition }) => envelope.origin.kind !== "hook" || definition.allowRecursive === true)
      .filter(() => envelope.origin.depth <= this.maxDepth)
      .sort((a, b) => {
        const scope = SCOPE_ORDER[a.definition.scope ?? "project"] - SCOPE_ORDER[b.definition.scope ?? "project"];
        if (scope !== 0) return scope;
        const priority = (a.definition.priority ?? 0) - (b.definition.priority ?? 0);
        return priority !== 0 ? priority : a.declarationOrder - b.declarationOrder;
      });
    const controlling = matching.filter(({ definition }) => (definition.mode ?? "control") === "control");
    const observing = matching.filter(({ definition }) => definition.mode === "observe");
    const executions: RuntimeHookExecution[] = [];
    let decision: RuntimeHookDecision = { action: "allow" };

    for (const { definition } of controlling) {
      const result = await this.execute(definition, envelope);
      executions.push(result.execution);
      if (!result.replayed) await this.host.trace?.(result.execution, result.decision, envelope);
      if (result.decision) decision = composeRuntimeHookDecision(decision, result.decision);
      if (["deny", "ask", "defer", "stop"].includes(decision.action)) break;
    }

    const observed = await Promise.all(observing.map(async ({ definition }) => {
      const result = await this.execute(definition, envelope, true);
      if (!result.replayed) await this.host.trace?.(result.execution, undefined, envelope);
      return result.execution;
    }));
    executions.push(...observed);

    return { envelope, decision, executions };
  }

  private async execute(
    hook: RuntimeHookDefinition,
    envelope: RuntimeHookEnvelope,
    observeOnly = false,
  ): Promise<{ execution: RuntimeHookExecution; decision?: RuntimeHookDecision; replayed?: boolean }> {
    const startedAt = this.now().toISOString();
    const controller = new AbortController();
    const timeoutMs = hook.handler.timeoutMs ?? DEFAULT_RUNTIME_HOOK_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(new Error("Runtime hook timed out")), timeoutMs);
    const idempotencyKey = runtimeHookIdempotencyKey(envelope.eventId, hook.id);
    const request: RuntimeHookExecutionRequest = {
      hook,
      envelope,
      idempotencyKey,
      signal: controller.signal,
    };
    try {
      const replay = await this.host.findCompleted?.(request);
      if (replay) {
        assertReplayMatches(replay, request);
        const decision = observeOnly
          ? undefined
          : normalizeRuntimeHookDecision(replay.decision);
        return {
          execution: { ...replay.execution, replayed: true },
          ...(decision ? { decision } : {}),
          replayed: true,
        };
      }
      const result = await Promise.race([
        this.host.execute(request),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        }),
      ]);
      const decision = observeOnly ? undefined : normalizeRuntimeHookDecision(result?.decision);
      const completedAt = this.now().toISOString();
      return {
        ...(decision ? { decision } : {}),
        execution: {
          idempotencyKey,
          eventId: envelope.eventId,
          hookId: hook.id,
          handlerType: hook.handler.type,
          event: envelope.event,
          scope: hook.scope ?? "project",
          mode: hook.mode ?? "control",
          priority: hook.priority ?? 0,
          attempt: 1,
          timeoutMs,
          onFailure: hook.onFailure ?? "continue",
          startedAt,
          completedAt,
          durationMs: durationBetween(startedAt, completedAt),
          outcome: observeOnly
            ? "observed"
            : decision?.action === "deny"
              ? "denied"
              : decision?.action === "modify"
                ? "modified"
                : decision?.action === "stop"
                  ? "stopped"
                  : "allowed",
          ...(decision ? { decision: decision.action } : {}),
        },
      };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const message = safeError(error);
      const completedAt = this.now().toISOString();
      const execution: RuntimeHookExecution = {
        idempotencyKey,
        eventId: envelope.eventId,
        hookId: hook.id,
        handlerType: hook.handler.type,
        event: envelope.event,
        scope: hook.scope ?? "project",
        mode: hook.mode ?? "control",
        priority: hook.priority ?? 0,
        attempt: 1,
        timeoutMs,
        onFailure: hook.onFailure ?? "continue",
        startedAt,
        completedAt,
        durationMs: durationBetween(startedAt, completedAt),
        outcome: timedOut ? "timed_out" : "failed",
        error: message,
      };
      if (!observeOnly && (hook.onFailure ?? "continue") === "block") {
        return {
          execution,
          decision: { action: "deny", reason: message, code: timedOut ? "runtime_hook_timeout" : "runtime_hook_failed" },
        };
      }
      return { execution };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function assertReplayMatches(
  replay: RuntimeHookReplay,
  request: RuntimeHookExecutionRequest,
): void {
  const execution = replay.execution;
  if (
    execution.idempotencyKey !== request.idempotencyKey
    || execution.eventId !== request.envelope.eventId
    || execution.event !== request.envelope.event
    || execution.hookId !== request.hook.id
    || execution.handlerType !== request.hook.handler.type
  ) {
    throw new RuntimeHookValidationError("Runtime hook replay identity does not match the current execution");
  }
}

function durationBetween(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

export function createRuntimeHookEnvelope(
  input: RuntimeHookDispatchInput,
  now: () => Date = () => new Date(),
  maxPayloadBytes = DEFAULT_RUNTIME_HOOK_MAX_PAYLOAD_BYTES,
): RuntimeHookEnvelope {
  const occurredAt = input.occurredAt ?? now().toISOString();
  if (Number.isNaN(Date.parse(occurredAt))) throw new RuntimeHookValidationError("occurredAt must be an ISO timestamp");
  const data = sanitizeRuntimeHookValue(input.data ?? {}, maxPayloadBytes) as Record<string, RuntimeHookJson>;
  const identity = sanitizeRuntimeHookValue(input.identity ?? {}, 32 * 1024) as RuntimeHookIdentity;
  const eventId = input.eventId ?? createEventId(input.event, identity, data);
  return Object.freeze({
    version: RUNTIME_HOOK_CONTRACT_VERSION,
    event: input.event,
    eventId,
    occurredAt,
    surface: input.surface,
    identity: Object.freeze(identity),
    data: Object.freeze(data),
    origin: Object.freeze(input.origin ?? { kind: "runtime" as const, depth: 0 }),
  });
}

export function validateRuntimeHookPack(input: unknown): RuntimeHookPack {
  if (!isRecord(input) || input.version !== RUNTIME_HOOK_CONTRACT_VERSION) {
    throw new RuntimeHookValidationError(`Runtime hook pack version must be ${RUNTIME_HOOK_CONTRACT_VERSION}`);
  }
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 128) {
    throw new RuntimeHookValidationError("Runtime hook pack name must contain 1-128 characters");
  }
  if (!Array.isArray(input.hooks)) throw new RuntimeHookValidationError("Runtime hook pack hooks must be an array");
  return {
    version: RUNTIME_HOOK_CONTRACT_VERSION,
    name: input.name,
    hooks: input.hooks.map((hook, index) => validateRuntimeHookDefinition(hook, index)),
  };
}

export function validateRuntimeHookDefinition(input: unknown, index = 0): RuntimeHookDefinition {
  if (!isRecord(input)) throw new RuntimeHookValidationError(`Hook ${index} must be an object`);
  if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 128) {
    throw new RuntimeHookValidationError(`Hook ${index} id must contain 1-128 characters`);
  }
  if (typeof input.event !== "string" || !RUNTIME_HOOK_EVENTS.has(input.event as RuntimeHookEventName)) {
    throw new RuntimeHookValidationError(`Hook ${input.id} has an unsupported event`);
  }
  if (
    !isRecord(input.handler)
    || typeof input.handler.type !== "string"
    || !HANDLER_TYPES.has(input.handler.type as RuntimeHookHandler["type"])
  ) {
    throw new RuntimeHookValidationError(`Hook ${input.id} has an unsupported handler`);
  }
  validateRuntimeHookHandler(input.id, input.handler);
  if (input.scope !== undefined && !RUNTIME_HOOK_SCOPES.has(input.scope as RuntimeHookScope)) {
    throw new RuntimeHookValidationError(`Hook ${input.id} has an unsupported scope`);
  }
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || Math.abs(Number(input.priority)) > 1_000_000)) {
    throw new RuntimeHookValidationError(`Hook ${input.id} priority must be an integer between -1000000 and 1000000`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new RuntimeHookValidationError(`Hook ${input.id} enabled must be a boolean`);
  }
  if (input.allowRecursive !== undefined && typeof input.allowRecursive !== "boolean") {
    throw new RuntimeHookValidationError(`Hook ${input.id} allowRecursive must be a boolean`);
  }
  if (input.matcher !== undefined) validateRuntimeHookMatcher(input.id, input.matcher);
  if (input.mode !== undefined && input.mode !== "control" && input.mode !== "observe") {
    throw new RuntimeHookValidationError(`Hook ${input.id} mode must be control or observe`);
  }
  if (input.onFailure !== undefined && input.onFailure !== "continue" && input.onFailure !== "block") {
    throw new RuntimeHookValidationError(`Hook ${input.id} onFailure must be continue or block`);
  }
  const timeoutMs = (input.handler as Record<string, unknown>).timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 300_000)) {
    throw new RuntimeHookValidationError(`Hook ${input.id} timeoutMs must be between 1 and 300000`);
  }
  return structuredClone(input) as unknown as RuntimeHookDefinition;
}

function validateRuntimeHookHandler(hookId: string, handler: Record<string, unknown>): void {
  const requireString = (field: string): string => {
    const value = handler[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new RuntimeHookValidationError(`Hook ${hookId} handler.${field} must be a non-empty string`);
    }
    return value;
  };
  const optionalStringArray = (field: string): void => {
    const value = handler[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw new RuntimeHookValidationError(`Hook ${hookId} handler.${field} must be an array of strings`);
    }
  };
  switch (handler.type) {
    case "command":
      requireString("command");
      optionalStringArray("args");
      if (handler.cwd !== undefined && typeof handler.cwd !== "string") {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.cwd must be a string`);
      }
      if (handler.env !== undefined && (!isRecord(handler.env) || Object.values(handler.env).some((value) => typeof value !== "string"))) {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.env must contain string values`);
      }
      if (isRecord(handler.env) && Object.keys(handler.env).some((key) => SENSITIVE_KEY.test(key))) {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.env must not contain inline credentials`);
      }
      break;
    case "http": {
      const rawUrl = requireString("url");
      let url: URL;
      try { url = new URL(rawUrl); } catch { throw new RuntimeHookValidationError(`Hook ${hookId} handler.url is invalid`); }
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.url must use HTTPS without embedded credentials`);
      }
      if (handler.connection !== undefined && typeof handler.connection !== "string") {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.connection must be a string`);
      }
      if (handler.headers !== undefined && (!isRecord(handler.headers) || Object.values(handler.headers).some((value) => typeof value !== "string"))) {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.headers must contain string values`);
      }
      if (isRecord(handler.headers) && Object.keys(handler.headers).some((key) => SENSITIVE_KEY.test(key))) {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.headers must not contain inline credentials; use handler.connection`);
      }
      break;
    }
    case "tool":
      requireString("tool");
      if (handler.input !== undefined && !isRecord(handler.input)) {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.input must be an object`);
      }
      break;
    case "mcp_tool":
      requireString("connection");
      requireString("tool");
      if (handler.input !== undefined && !isRecord(handler.input)) {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.input must be an object`);
      }
      break;
    case "prompt":
      requireString("prompt");
      if (handler.model !== undefined && typeof handler.model !== "string") {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.model must be a string`);
      }
      if (handler.maxOutputTokens !== undefined && (!Number.isInteger(handler.maxOutputTokens) || Number(handler.maxOutputTokens) < 1 || Number(handler.maxOutputTokens) > 32_768)) {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.maxOutputTokens must be between 1 and 32768`);
      }
      break;
    case "agent":
      requireString("agent");
      requireString("prompt");
      optionalStringArray("allowedTools");
      if (handler.maxTurns !== undefined && (!Number.isInteger(handler.maxTurns) || Number(handler.maxTurns) < 1 || Number(handler.maxTurns) > 20)) {
        throw new RuntimeHookValidationError(`Hook ${hookId} handler.maxTurns must be between 1 and 20`);
      }
      break;
  }
}

function validateRuntimeHookMatcher(hookId: string, value: unknown): void {
  if (!isRecord(value)) throw new RuntimeHookValidationError(`Hook ${hookId} matcher must be an object`);
  for (const field of ["agents", "loops", "steps", "tools"] as const) {
    const patterns = value[field];
    if (patterns !== undefined && (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string" || pattern.length > 256))) {
      throw new RuntimeHookValidationError(`Hook ${hookId} matcher.${field} must be an array of strings`);
    }
  }
  const surfaces = value.surfaces;
  if (surfaces !== undefined && (!Array.isArray(surfaces) || surfaces.some((surface) => !RUNTIME_HOOK_SURFACES.has(surface as RuntimeHookSurface)))) {
    throw new RuntimeHookValidationError(`Hook ${hookId} matcher.surfaces contains an unsupported surface`);
  }
}

export function composeRuntimeHookDecision(
  current: RuntimeHookDecision,
  next: RuntimeHookDecision,
): RuntimeHookDecision {
  const precedence: Record<RuntimeHookDecision["action"], number> = {
    allow: 0,
    modify: 1,
    defer: 2,
    ask: 3,
    stop: 4,
    deny: 5,
  };
  if (current.action === "modify" && next.action === "modify") {
    return { ...next, data: { ...current.data, ...next.data } };
  }
  return precedence[next.action] >= precedence[current.action] ? next : current;
}

export function runtimeHookIdempotencyKey(eventId: string, hookId: string): string {
  return stableHash(`${eventId}\u0000${hookId}`);
}

export function matchesRuntimeHook(matcher: RuntimeHookMatcher | undefined, envelope: RuntimeHookEnvelope): boolean {
  if (!matcher) return true;
  if (matcher.surfaces && !matcher.surfaces.includes(envelope.surface)) return false;
  if (matcher.agents && !matchesAny(matcher.agents, envelope.identity.agent)) return false;
  if (matcher.loops && !matchesAny(matcher.loops, envelope.identity.loop)) return false;
  if (matcher.steps && !matchesAny(matcher.steps, envelope.identity.step)) return false;
  if (matcher.tools && !matchesAny(matcher.tools, typeof envelope.data.tool === "string" ? envelope.data.tool : undefined)) return false;
  return true;
}

/** Normalize file mutations produced by the portable workspace tool contract. */
export function runtimeHookFileChangeForTool(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  result: string,
): Record<string, RuntimeHookJson> | undefined {
  if (result.startsWith("Error:")) return undefined;
  const action = tool === "write_file"
    ? "created"
    : tool === "edit_file"
      ? "modified"
      : undefined;
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (!action || !path) return undefined;
  const slash = path.lastIndexOf("/");
  return {
    action,
    path,
    directory: slash >= 0 ? path.slice(0, slash) || "/" : ".",
    sourceTool: tool,
  };
}

function normalizeRuntimeHookDecision(decision: RuntimeHookDecision | undefined): RuntimeHookDecision | undefined {
  if (!decision) return undefined;
  if (!["allow", "deny", "ask", "defer", "modify", "stop"].includes(decision.action)) {
    throw new RuntimeHookValidationError("Hook returned an unsupported decision");
  }
  return sanitizeRuntimeHookValue(decision, 64 * 1024) as unknown as RuntimeHookDecision;
}

function sanitizeRuntimeHookValue(value: unknown, maxBytes: number): RuntimeHookJson {
  const ancestors = new WeakSet<object>();
  const visit = (candidate: unknown, key?: string): RuntimeHookJson => {
    if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new RuntimeHookValidationError("Runtime hook data contains a non-finite number");
      return candidate;
    }
    if (typeof candidate !== "object") return String(candidate);
    if (ancestors.has(candidate)) throw new RuntimeHookValidationError("Runtime hook data contains a circular reference");
    ancestors.add(candidate);
    const output: RuntimeHookJson = Array.isArray(candidate)
      ? candidate.map((item) => visit(item))
      : Object.fromEntries(Object.entries(candidate as Record<string, unknown>).map(([name, item]) => [name, visit(item, name)]));
    ancestors.delete(candidate);
    return output;
  };
  const result = visit(value);
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > maxBytes) throw new RuntimeHookValidationError(`Runtime hook payload exceeds ${maxBytes} bytes`);
  return result;
}

function matchesAny(patterns: readonly string[], value: string | undefined): boolean {
  if (value === undefined) return false;
  return patterns.some((pattern) => globMatch(pattern, value));
}

function globMatch(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${expression}$`, "u").test(value);
}

function createEventId(
  event: RuntimeHookEventName,
  identity: RuntimeHookIdentity,
  data: Record<string, RuntimeHookJson>,
): string {
  return stableHash(JSON.stringify([event, identity, data]));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000).replace(SENSITIVE_KEY, "[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Portable deterministic hash; identity only, never used as a secret. */
function stableHash(value: string): string {
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

const HANDLER_TYPES = new Set<RuntimeHookHandler["type"]>(RUNTIME_HOOK_HANDLER_TYPES);
const RUNTIME_HOOK_EVENTS = new Set<RuntimeHookEventName>(RUNTIME_HOOK_EVENT_NAMES);
const RUNTIME_HOOK_SCOPES = new Set<RuntimeHookScope>(Object.keys(SCOPE_ORDER) as RuntimeHookScope[]);
const RUNTIME_HOOK_SURFACES = new Set<RuntimeHookSurface>(RUNTIME_HOOK_SURFACE_NAMES);
