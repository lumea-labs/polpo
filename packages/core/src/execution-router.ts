import type { ProjectLoopConfig } from "./loop/types.js";
import { resolveLoopSelection } from "./loop/selector.js";
import type { AgentConfig, Task } from "./types.js";
import {
  RUNTIME_INVOCATION_SOURCES,
  RUNTIME_SURFACES,
  type RuntimeDecisionSource,
  type RuntimeInvocationSource,
  type RuntimeSurface,
} from "./runtime-plan/index.js";

export const EXECUTION_ROUTER_MODES = ["off", "auto"] as const;
export type ExecutionRouterMode = (typeof EXECUTION_ROUTER_MODES)[number];

export const DEFAULT_EXECUTION_ROUTE_MIN_CONFIDENCE = 0.7;
export const DEFAULT_EXECUTION_ROUTE_TIMEOUT_MS = 1_000;
export const DEFAULT_EXECUTION_ROUTE_MAX_INPUT_CHARS = 4_096;
export const MAX_EXECUTION_ROUTE_INPUT_CHARS = 16_384;
export const MAX_EXECUTION_ROUTE_LOOPS = 32;
export const MAX_EXECUTION_ROUTE_NAME_CHARS = 128;
export const MAX_EXECUTION_ROUTE_LABEL_CHARS = 128;
export const MAX_EXECUTION_ROUTE_DESCRIPTION_CHARS = 512;
export const MAX_EXECUTION_ROUTE_LABELS = 16;
export const MAX_EXECUTION_ROUTE_CONTEXT_LABEL_CHARS = 64;
export const MAX_EXECUTION_ROUTE_REASON_CHARS = 512;

export interface ExecutionRouterConfig {
  readonly mode?: ExecutionRouterMode;
  /**
   * Automatic routing can only narrow assignedLoops. Auto mode requires at
   * least one explicit entry so enabling the router never grants every loop by
   * accident.
   */
  readonly allowedLoops?: readonly string[];
  readonly minConfidence?: number;
  readonly timeoutMs?: number;
  readonly maxInputChars?: number;
}

export interface ExecutionRouteLoopManifest {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
}

export interface ExecutionRouteManifest {
  readonly version: 1;
  readonly loops: readonly ExecutionRouteLoopManifest[];
  readonly unresolvedLoops: readonly string[];
}

export interface CompileExecutionRouteManifestInput {
  readonly assignedLoops?: readonly string[];
  readonly projectLoops?: readonly ProjectLoopConfig[];
}

export type ExecutionRouteDecision =
  | Readonly<{
      mode: "direct";
      confidence: number;
      reason: string;
    }>
  | Readonly<{
      mode: "loop";
      loop: string;
      confidence: number;
      reason: string;
    }>;

/**
 * Compact, host-neutral classifier payload. It deliberately excludes loop
 * prompts, steps, tools, models, policies, metadata, history, and credentials.
 */
export interface ExecutionRouteClassifierInput {
  readonly version: 1;
  readonly surface: RuntimeSurface;
  readonly source: RuntimeInvocationSource;
  readonly input: string;
  readonly loops: readonly ExecutionRouteLoopManifest[];
  readonly labels: readonly string[];
}

export interface ExecutionRouteClassifierOptions {
  readonly signal: AbortSignal;
}

export interface ExecutionRouteClassifier {
  classify(
    input: ExecutionRouteClassifierInput,
    options: ExecutionRouteClassifierOptions,
  ): Promise<unknown>;
}

/**
 * Host-private identity supplied when resolving a classifier. It is never
 * included in the compact classifier input or sent to the model.
 */
export interface ExecutionRouteClassifierResolverContext {
  readonly surface: RuntimeSurface;
  readonly source: RuntimeInvocationSource;
  readonly agentName: string;
  readonly userId?: string;
}

export interface ResolveExecutionRouteInput {
  readonly surface: RuntimeSurface;
  readonly source: RuntimeInvocationSource;
  /** Current request/task summary only. Callers must not pass full history. */
  readonly input?: string;
  readonly labels?: readonly string[];
  readonly explicitLoop?: string;
  readonly manifest: ExecutionRouteManifest;
  readonly config: ExecutionRouterConfig;
}

export interface ResolveExecutionRouteOptions {
  readonly classifier?: ExecutionRouteClassifier;
  /** Lazily creates a classifier only after every deterministic skip. */
  readonly resolveClassifier?: () =>
    | ExecutionRouteClassifier
    | undefined
    | Promise<ExecutionRouteClassifier | undefined>;
  readonly signal?: AbortSignal;
}

export interface ResolveTaskExecutionRouteInput {
  readonly task: Pick<Task, "description" | "loop" | "title" | "user">;
  readonly agent: AgentConfig;
}

export interface ResolveTaskExecutionRouteOptions {
  readonly getProjectLoop?: (
    name: string,
  ) => ProjectLoopConfig | null | Promise<ProjectLoopConfig | null>;
  readonly resolveClassifier?: (
    context: ExecutionRouteClassifierResolverContext,
  ) =>
    | ExecutionRouteClassifier
    | undefined
    | Promise<ExecutionRouteClassifier | undefined>;
  readonly signal?: AbortSignal;
}

export interface CreateExplicitExecutionRouteInput {
  readonly surface: RuntimeSurface;
  readonly source: RuntimeInvocationSource;
  readonly loop: string;
  readonly reason?: string;
}

export type ExecutionRouteStatus =
  | "disabled"
  | "explicit"
  | "skipped"
  | "routed"
  | "fallback";

export interface ResolvedExecutionRoute {
  readonly surface: RuntimeSurface;
  readonly invocationSource: RuntimeInvocationSource;
  readonly status: ExecutionRouteStatus;
  readonly decisionSource: Extract<
    RuntimeDecisionSource,
    "request" | "router" | "default"
  >;
  readonly mode: "direct" | "loop";
  readonly loop?: string;
  readonly confidence?: number;
  readonly reason: string;
  readonly latencyMs: number;
  readonly fallbackUsed: boolean;
}

export interface ExecutionRouteRuntimePlanFields {
  readonly execution: Readonly<{
    mode: "direct" | "loop";
    loop?: string;
    source: Extract<RuntimeDecisionSource, "request" | "router" | "default">;
  }>;
  readonly audit: Readonly<{
    reasons: readonly string[];
    warnings: readonly string[];
    confidence?: number;
    fallbackUsed: boolean;
  }>;
}

export interface ExecutionRouteResolvedEvent {
  readonly type: "runtime.execution_route.resolved";
  readonly route: ResolvedExecutionRoute;
}

export class ExecutionRouteCancelledError extends Error {
  readonly code = "EXECUTION_ROUTE_CANCELLED" as const;

  constructor() {
    super("Execution routing was cancelled");
    this.name = "ExecutionRouteCancelledError";
  }
}

interface NormalizedExecutionRouterConfig {
  readonly mode: ExecutionRouterMode;
  readonly allowedLoops: readonly string[];
  readonly minConfidence: number;
  readonly timeoutMs: number;
  readonly maxInputChars: number;
}

type ClassifierOutcome =
  | { readonly type: "decision"; readonly value: unknown }
  | { readonly type: "unavailable" }
  | { readonly type: "error" }
  | { readonly type: "timeout" };

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freeze(nested);
  }
  return Object.freeze(value);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function normalizedName(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  if (value.length > MAX_EXECUTION_ROUTE_NAME_CHARS) {
    throw new Error(
      `${label} must not exceed ${MAX_EXECUTION_ROUTE_NAME_CHARS} characters`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return value;
}

function assertRuntimeMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

function validateInvocation(
  surface: unknown,
  source: unknown,
): void {
  assertRuntimeMember(surface, RUNTIME_SURFACES, "Execution route surface");
  assertRuntimeMember(
    source,
    RUNTIME_INVOCATION_SOURCES,
    "Execution route source",
  );
}

function normalizedNames(
  value: unknown,
  label: string,
  options: { allowEmpty: boolean },
): string[] {
  if (value === undefined && options.allowEmpty) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = normalizedName(item, `${label} entry`);
    if (seen.has(name)) continue;
    seen.add(name);
    output.push(name);
    if (output.length > MAX_EXECUTION_ROUTE_LOOPS) {
      throw new Error(
        `${label} must not contain more than ${MAX_EXECUTION_ROUTE_LOOPS} values`,
      );
    }
  }
  return output;
}

function optionalDisplayText(
  value: unknown,
  label: string,
  maximumChars: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maximumChars);
}

function finiteRange(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be a finite number between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  label: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function normalizeConfig(
  config: ExecutionRouterConfig,
): NormalizedExecutionRouterConfig {
  const record = plainRecord(config, "Execution router config");
  const supported = new Set([
    "mode",
    "allowedLoops",
    "minConfidence",
    "timeoutMs",
    "maxInputChars",
  ]);
  if (Object.keys(record).some((key) => !supported.has(key))) {
    throw new Error("Execution router config contains unsupported fields");
  }
  const mode = config.mode ?? "off";
  if (!EXECUTION_ROUTER_MODES.includes(mode)) {
    throw new Error(
      `Execution router mode must be one of: ${EXECUTION_ROUTER_MODES.join(", ")}`,
    );
  }
  const allowedLoops = normalizedNames(
    config.allowedLoops,
    "Execution router allowedLoops",
    { allowEmpty: true },
  );
  if (mode === "auto" && allowedLoops.length === 0) {
    throw new Error(
      "Execution router auto mode requires at least one allowed loop",
    );
  }
  return freeze({
    mode,
    allowedLoops,
    minConfidence: finiteRange(
      config.minConfidence,
      DEFAULT_EXECUTION_ROUTE_MIN_CONFIDENCE,
      "Execution router minConfidence",
      0,
      1,
    ),
    timeoutMs: positiveInteger(
      config.timeoutMs,
      DEFAULT_EXECUTION_ROUTE_TIMEOUT_MS,
      "Execution router timeoutMs",
      60_000,
    ),
    maxInputChars: positiveInteger(
      config.maxInputChars,
      DEFAULT_EXECUTION_ROUTE_MAX_INPUT_CHARS,
      "Execution router maxInputChars",
      MAX_EXECUTION_ROUTE_INPUT_CHARS,
    ),
  });
}

/**
 * Validate persisted execution-router settings without resolving a route.
 * Hosts call this at their configuration boundary so invalid settings fail
 * before a request or task starts.
 */
export function validateExecutionRouterConfig(
  config: ExecutionRouterConfig,
): void {
  normalizeConfig(config);
}

/**
 * Resolve routing for task execution independently of the host transport.
 * Orchestrators and direct task APIs share this helper so task semantics cannot
 * diverge between background and request-driven execution.
 */
export async function resolveTaskExecutionRoute(
  input: ResolveTaskExecutionRouteInput,
  options: ResolveTaskExecutionRouteOptions = {},
): Promise<ResolvedExecutionRoute | undefined> {
  const { task, agent } = input;
  if (task.loop) {
    resolveLoopSelection(agent, task.loop);
    return createExplicitExecutionRoute({
      surface: "task",
      source: "task",
      loop: task.loop,
    });
  }

  if (agent.executionRouter?.mode !== "auto") return undefined;
  validateExecutionRouterConfig(agent.executionRouter);

  const assignedLoops = Array.isArray(agent.assignedLoops)
    ? agent.assignedLoops
    : [];
  const configuredAllowedLoops = Array.isArray(
    agent.executionRouter.allowedLoops,
  )
    ? agent.executionRouter.allowedLoops
    : [];
  const allowed = new Set(configuredAllowedLoops);
  const candidateNames = [...new Set(
    assignedLoops.filter((name) => allowed.has(name)),
  )];
  const projectLoops: ProjectLoopConfig[] = [];
  if (options.getProjectLoop) {
    const loaded = await Promise.all(
      candidateNames.map((name) => options.getProjectLoop!(name)),
    );
    projectLoops.push(...loaded.filter(
      (loop): loop is ProjectLoopConfig => loop !== null,
    ));
  }

  return resolveExecutionRoute({
    surface: "task",
    source: "task",
    input: [task.title, task.description].filter(Boolean).join("\n\n"),
    labels: [],
    manifest: compileExecutionRouteManifest({
      assignedLoops: candidateNames,
      projectLoops,
    }),
    config: agent.executionRouter,
  }, {
    resolveClassifier: options.resolveClassifier
      ? () => options.resolveClassifier!({
          surface: "task",
          source: "task",
          agentName: agent.name,
          ...(task.user ? { userId: task.user } : {}),
        })
      : undefined,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

function normalizeManifest(
  manifest: ExecutionRouteManifest,
): ExecutionRouteManifest {
  const record = plainRecord(manifest, "Execution route manifest");
  if (record.version !== 1) {
    throw new Error("Execution route manifest version must be 1");
  }
  if (!Array.isArray(record.loops)) {
    throw new Error("Execution route manifest loops must be an array");
  }
  if (!Array.isArray(record.unresolvedLoops)) {
    throw new Error("Execution route manifest unresolvedLoops must be an array");
  }
  if (record.loops.length > MAX_EXECUTION_ROUTE_LOOPS) {
    throw new Error(
      `Execution route manifest must not contain more than ${MAX_EXECUTION_ROUTE_LOOPS} loops`,
    );
  }
  const loops: ExecutionRouteLoopManifest[] = [];
  const seen = new Set<string>();
  for (const rawLoop of record.loops) {
    const loop = plainRecord(rawLoop, "Execution route loop");
    const keys = Object.keys(loop).sort();
    if (keys.some((key) => !["description", "label", "name"].includes(key))) {
      throw new Error("Execution route loop contains unsupported fields");
    }
    const name = normalizedName(loop.name, "Execution route loop name");
    if (seen.has(name)) throw new Error(`Duplicate execution route loop "${name}"`);
    seen.add(name);
    const label = optionalDisplayText(
      loop.label,
      "Execution route loop label",
      MAX_EXECUTION_ROUTE_LABEL_CHARS,
    );
    const description = optionalDisplayText(
      loop.description,
      "Execution route loop description",
      MAX_EXECUTION_ROUTE_DESCRIPTION_CHARS,
    );
    loops.push(freeze({
      name,
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
    }));
  }
  const unresolvedLoops = normalizedNames(
    record.unresolvedLoops,
    "Execution route unresolvedLoops",
    { allowEmpty: true },
  );
  return freeze({
    version: 1 as const,
    loops,
    unresolvedLoops,
  });
}

function normalizeContextLabels(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Execution router labels must be an array of strings");
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new Error("Execution router labels must contain only strings");
    }
    const normalized = raw
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_EXECUTION_ROUTE_CONTEXT_LABEL_CHARS);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length === MAX_EXECUTION_ROUTE_LABELS) break;
  }
  return output;
}

function routeResult(
  value: ResolvedExecutionRoute,
): ResolvedExecutionRoute {
  return freeze({ ...value });
}

function directResult(
  input: ResolveExecutionRouteInput,
  details: {
    status: Extract<ExecutionRouteStatus, "disabled" | "skipped" | "fallback">;
    decisionSource: Extract<RuntimeDecisionSource, "router" | "default">;
    reason: string;
    confidence?: number;
    latencyMs?: number;
    fallbackUsed: boolean;
  },
): ResolvedExecutionRoute {
  return routeResult({
    surface: input.surface,
    invocationSource: input.source,
    status: details.status,
    decisionSource: details.decisionSource,
    mode: "direct",
    ...(details.confidence !== undefined
      ? { confidence: details.confidence }
      : {}),
    reason: details.reason,
    latencyMs: details.latencyMs ?? 0,
    fallbackUsed: details.fallbackUsed,
  });
}

function sanitizeReason(value: string): string {
  const reason = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!reason || reason.length > MAX_EXECUTION_ROUTE_REASON_CHARS) {
    throw new Error(
      `Execution route reason must not exceed ${MAX_EXECUTION_ROUTE_REASON_CHARS} characters`,
    );
  }
  return reason;
}

function parseDecision(
  value: unknown,
  allowedLoops: readonly string[],
): ExecutionRouteDecision {
  let parsed = value;
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  const record = plainRecord(parsed, "Execution route decision");
  if (record.mode !== "direct" && record.mode !== "loop") {
    throw new Error("Execution route decision mode must be direct or loop");
  }
  const expectedKeys = record.mode === "loop"
    ? ["confidence", "loop", "mode", "reason"]
    : ["confidence", "mode", "reason"];
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Execution route decision contains unsupported fields");
  }
  if (record.confidence === undefined) {
    throw new Error("Execution route decision confidence is required");
  }
  const confidence = finiteRange(
    record.confidence,
    0,
    "Execution route decision confidence",
    0,
    1,
  );
  if (typeof record.reason !== "string") {
    throw new Error("Execution route decision reason must be a string");
  }
  const reason = sanitizeReason(record.reason);
  if (record.mode === "direct") {
    return freeze({ mode: "direct" as const, confidence, reason });
  }
  const loop = normalizedName(record.loop, "Execution route decision loop");
  if (!allowedLoops.includes(loop)) {
    throw new Error(`Execution route decision selected disallowed loop "${loop}"`);
  }
  return freeze({ mode: "loop" as const, loop, confidence, reason });
}

async function classifyWithDeadline(
  options: ResolveExecutionRouteOptions,
  input: ExecutionRouteClassifierInput,
  timeoutMs: number,
): Promise<ClassifierOutcome> {
  if (options.classifier && options.resolveClassifier) {
    throw new Error(
      "Provide either classifier or resolveClassifier, not both",
    );
  }
  if (options.signal?.aborted) throw new ExecutionRouteCancelledError();

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;

  const classifierOutcome: Promise<ClassifierOutcome> = Promise.resolve()
    .then(async () => {
      const resolved = options.classifier
        ?? await options.resolveClassifier?.();
      if (!resolved) return { type: "unavailable" } as const;
      const value = await resolved.classify(input, { signal: controller.signal });
      return { type: "decision", value } as const;
    })
    .catch((): ClassifierOutcome => ({ type: "error" }));

  const timeoutOutcome = new Promise<ClassifierOutcome>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort(new Error("Execution router timeout"));
      resolve({ type: "timeout" });
    }, timeoutMs);
  });

  const outcomes: Promise<ClassifierOutcome>[] = [
    classifierOutcome,
    timeoutOutcome,
  ];
  if (options.signal) {
    outcomes.push(new Promise<ClassifierOutcome>((_resolve, reject) => {
      onCallerAbort = () => {
        controller.abort(new ExecutionRouteCancelledError());
        reject(new ExecutionRouteCancelledError());
      };
      options.signal!.addEventListener("abort", onCallerAbort, { once: true });
    }));
  }

  try {
    return await Promise.race(outcomes);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (options.signal && onCallerAbort) {
      options.signal.removeEventListener("abort", onCallerAbort);
    }
  }
}

export function compileExecutionRouteManifest(
  input: CompileExecutionRouteManifestInput,
): ExecutionRouteManifest {
  plainRecord(input, "Execution route manifest input");
  const assignedLoops = normalizedNames(
    input.assignedLoops,
    "Execution route assignedLoops",
    { allowEmpty: true },
  );
  if (input.projectLoops !== undefined && !Array.isArray(input.projectLoops)) {
    throw new Error("Execution route projectLoops must be an array");
  }
  const byName = new Map<string, ProjectLoopConfig>();
  for (const projectLoop of input.projectLoops ?? []) {
    plainRecord(projectLoop, "Execution route project loop");
    const name = normalizedName(
      projectLoop.name,
      "Execution route project loop name",
    );
    if (byName.has(name)) {
      throw new Error(`Duplicate execution route project loop "${name}"`);
    }
    byName.set(name, projectLoop);
  }

  const loops: ExecutionRouteLoopManifest[] = [];
  const unresolvedLoops: string[] = [];
  for (const name of assignedLoops) {
    const projectLoop = byName.get(name);
    if (!projectLoop) {
      unresolvedLoops.push(name);
      continue;
    }
    const label = optionalDisplayText(
      projectLoop.label,
      `Execution route loop "${name}" label`,
      MAX_EXECUTION_ROUTE_LABEL_CHARS,
    );
    const description = optionalDisplayText(
      projectLoop.description,
      `Execution route loop "${name}" description`,
      MAX_EXECUTION_ROUTE_DESCRIPTION_CHARS,
    );
    loops.push(freeze({
      name,
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
    }));
  }

  return freeze({
    version: 1 as const,
    loops,
    unresolvedLoops,
  });
}

export async function resolveExecutionRoute(
  input: ResolveExecutionRouteInput,
  options: ResolveExecutionRouteOptions = {},
): Promise<ResolvedExecutionRoute> {
  plainRecord(input, "Execution route input");
  validateInvocation(input.surface, input.source);
  const config = normalizeConfig(input.config);
  const manifest = normalizeManifest(input.manifest);

  if (input.explicitLoop !== undefined) {
    const loop = normalizedName(input.explicitLoop, "Explicit loop");
    if (!manifest.loops.some((candidate) => candidate.name === loop)) {
      throw new Error(`Explicit loop "${loop}" is not authorized`);
    }
    return createExplicitExecutionRoute({
      surface: input.surface,
      source: input.source,
      loop,
    });
  }

  if (config.mode === "off") {
    return directResult(input, {
      status: "disabled",
      decisionSource: "default",
      reason: "Execution router is disabled",
      fallbackUsed: false,
    });
  }

  const allowed = new Set(config.allowedLoops);
  const candidateLoops = manifest.loops.filter((loop) => allowed.has(loop.name));
  if (candidateLoops.length === 0) {
    return directResult(input, {
      status: "skipped",
      decisionSource: "default",
      reason: "No authorized execution router loops are available",
      fallbackUsed: false,
    });
  }

  const compactInput = (input.input ?? "")
    .trim()
    .slice(0, config.maxInputChars);
  if (!compactInput) {
    return directResult(input, {
      status: "skipped",
      decisionSource: "default",
      reason: "Execution router input was empty",
      fallbackUsed: false,
    });
  }

  const classifierInput = freeze({
    version: 1 as const,
    surface: input.surface,
    source: input.source,
    input: compactInput,
    loops: candidateLoops,
    labels: normalizeContextLabels(input.labels),
  });
  const startedAt = Date.now();
  const outcome = await classifyWithDeadline(
    options,
    classifierInput,
    config.timeoutMs,
  );
  const latencyMs = Math.max(0, Date.now() - startedAt);

  if (outcome.type === "unavailable") {
    return directResult(input, {
      status: "skipped",
      decisionSource: "default",
      reason: "Execution router classifier is unavailable",
      latencyMs,
      fallbackUsed: false,
    });
  }
  if (outcome.type === "timeout") {
    return directResult(input, {
      status: "fallback",
      decisionSource: "router",
      reason: `Execution router timed out after ${config.timeoutMs}ms`,
      latencyMs,
      fallbackUsed: true,
    });
  }
  if (outcome.type === "error") {
    return directResult(input, {
      status: "fallback",
      decisionSource: "router",
      reason: "Execution router classifier failed",
      latencyMs,
      fallbackUsed: true,
    });
  }

  let decision: ExecutionRouteDecision;
  try {
    decision = parseDecision(
      outcome.value,
      candidateLoops.map((loop) => loop.name),
    );
  } catch {
    return directResult(input, {
      status: "fallback",
      decisionSource: "router",
      reason: "Execution router returned an invalid decision",
      latencyMs,
      fallbackUsed: true,
    });
  }

  if (decision.confidence < config.minConfidence) {
    return directResult(input, {
      status: "fallback",
      decisionSource: "router",
      reason: `Execution router confidence was below ${config.minConfidence}`,
      confidence: decision.confidence,
      latencyMs,
      fallbackUsed: true,
    });
  }

  return routeResult({
    surface: input.surface,
    invocationSource: input.source,
    status: "routed",
    decisionSource: "router",
    mode: decision.mode,
    ...(decision.mode === "loop" ? { loop: decision.loop } : {}),
    confidence: decision.confidence,
    reason: decision.reason,
    latencyMs,
    fallbackUsed: false,
  });
}

export function createExplicitExecutionRoute(
  input: CreateExplicitExecutionRouteInput,
): ResolvedExecutionRoute {
  plainRecord(input, "Explicit execution route input");
  validateInvocation(input.surface, input.source);
  const loop = normalizedName(input.loop, "Explicit loop");
  const reason = input.reason === undefined
    ? "Explicit loop request"
    : sanitizeReason(input.reason);
  return routeResult({
    surface: input.surface,
    invocationSource: input.source,
    status: "explicit",
    decisionSource: "request",
    mode: "loop",
    loop,
    confidence: 1,
    reason,
    latencyMs: 0,
    fallbackUsed: false,
  });
}

export function executionRouteRuntimePlanFields(
  route: ResolvedExecutionRoute,
): ExecutionRouteRuntimePlanFields {
  const warnings = route.status === "fallback"
    ? ["Execution router fell back to direct execution"]
    : [];
  return freeze({
    execution: {
      mode: route.mode,
      ...(route.loop ? { loop: route.loop } : {}),
      source: route.decisionSource,
    },
    audit: {
      reasons: [route.reason],
      warnings,
      ...(route.confidence !== undefined
        ? { confidence: route.confidence }
        : {}),
      fallbackUsed: route.fallbackUsed,
    },
  });
}

export function createExecutionRouteResolvedEvent(
  route: ResolvedExecutionRoute,
): ExecutionRouteResolvedEvent {
  return freeze({
    type: "runtime.execution_route.resolved" as const,
    route,
  });
}
