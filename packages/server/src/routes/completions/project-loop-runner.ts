/**
 * Project loop runtime for the chat completions endpoint.
 *
 * Runs an assigned/default project loop as a deterministic pipeline
 * (PipelineExecutor) with agent steps delegated to the agent-step runner.
 * Also owns loop-run persistence (traces, approvals, resume checkpoints)
 * and the HTTP wiring for loop-mode requests (streaming + non-streaming).
 */

import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import {
  PipelineExecutor,
  LoopApprovalRequiredError,
  LoopToolInputValidationError,
  LoopPermissionApprovalRequiredError,
  buildLoopStepAgent,
  createToolInvocationContext,
  normalizeAgentIdentity,
  assertAgentIdentity,
  AgentIdentityError,
  type AgentIdentity,
  maybeParseJson,
  normalizeProjectLoop,
  normalizeRuntimeContextTrustMode,
  normalizeToolInput,
  loopUserVisibleContext,
  prepareProjectLoopResult,
  resolveRuntimeContext,
  stringifyLoopContext,
  type ContextBag,
  type LoopApprovedGate,
  type LoopLifecycleHook,
  type LoopRunRecord,
  type LoopRunStore,
  type LoopResumeState,
  type LoopTraceEvent,
  type LoopPresentation,
  type ProjectLoopConfig,
  type RuntimeContextTrustMode,
  type RuntimeContextResolution,
  type ResolvedExecutionRoute,
  type RuntimePlan,
  type ToolInvocationContext,
  type ToolInvocationJsonValue,
} from "@polpo-ai/core";
import { TerminationGateError } from "@polpo-ai/core/runtime-hooks";
import type { AgentStepCheckpoint } from "./agent-step-runner.js";
import { validateToolInput } from "@polpo-ai/llm";
import type { LanguageModelUsage } from "ai";
import type {
  CompletionRouteDeps,
  CompletionRuntimeInvocation,
} from "../completions.js";
import {
  agentConfigForModelPrimary,
  addUsage,
  runAgentStepCompletion,
  type CompletionResolvedModelInfo,
} from "./agent-step-runner.js";
import {
  completionResponse,
  guardrailErrorEnvelope,
  loopRuntimeErrorEnvelope,
  modelNotFoundEnvelope,
  sseChunk,
  ssePolpoChunk,
} from "./sse.js";
import { completionRuntimeErrorEnvelope } from "./runtime-error.js";
import {
  appendReasoningSummary,
  emitFileChanged,
  persistAssistantMessage,
  notifyCanonicalTurnCommitted,
  type CanonicalTurnPersistenceContext,
  type LoopRuntimeToolCall,
} from "./tool-mapping.js";
import { createGuardedCompletionToolExecutor } from "./tool-guardrails.js";
import {
  createPolicyGuardedToolExecutor,
  filterToolDefinitionsByPolicy,
  resolveExecutionToolPolicy,
  toolPolicyAuditData,
} from "./tool-policy-runtime.js";
import {
  createRuntimeHookedToolExecutor,
  dispatchCompletionRuntimeHook,
  runtimeHookDecisionError,
  type CompletionRuntimeHookContext,
} from "./runtime-hooks.js";
import {
  applyCompletionOutputPolicy,
  streamingOutputPolicyMode,
} from "./output-guardrails.js";
import type { ChatSuggestion } from "@polpo-ai/core/chat-interactions";
import {
  resolveSteeringPolicy,
  type SteeringController,
  type SteeringPolicy,
} from "@polpo-ai/core/steering";
import type { CompletionRequestBody } from "./schemas.js";
import { suggestionsForProjectLoopCompletion } from "./chat-interaction-runtime.js";
import type { CompletionSseWriter } from "./chat-handler.js";

export interface ProjectLoopRunResult {
  text: string;
  reasoning: string;
  usage: LanguageModelUsage;
  model: string;
  resolvedModel?: CompletionResolvedModelInfo;
  providerMetadata?: Record<string, unknown>;
  toolCalls: any[];
  context: ContextBag;
  trace: LoopTraceEvent[];
  loopRunId?: string;
  loopResult?: unknown;
  loopPresentation?: LoopPresentation;
}

export interface CompletionRunSteeringScope {
  steering?: SteeringController;
  release: () => void | Promise<void>;
}

/**
 * Register the public completion id before the response becomes observable.
 * The idempotent release wrapper lets every transport close the scope from its
 * own terminal path without leaking or double-unregistering the run.
 */
export async function createCompletionRunSteeringScope(
  deps: CompletionRouteDeps,
  runId: string,
): Promise<CompletionRunSteeringScope> {
  const scope: CompletionRunSteeringScope = await deps.createRunSteeringScope?.(runId)
    ?? { steering: undefined, release: () => {} };
  let released = false;
  return {
    steering: scope.steering,
    release: async () => {
      if (released) return;
      released = true;
      let closeError: unknown;
      try {
        await scope.steering?.close("too_late", "run_scope_released");
      } catch (error) {
        closeError = error;
      }
      try {
        await scope.release();
      } catch (error) {
        if (closeError === undefined) closeError = error;
      }
      if (closeError !== undefined) throw closeError;
    },
  };
}

const RUNTIME_PROJECT_LOOP_EVENTS = new Set<LoopLifecycleHook>([
  "loop:start",
  "step:before",
  "loop:transition",
  "step:after",
  "loop:end",
]);

function isRuntimeProjectLoopEvent(event: LoopLifecycleHook): event is
  | "loop:start"
  | "step:before"
  | "loop:transition"
  | "step:after"
  | "loop:end" {
  return RUNTIME_PROJECT_LOOP_EVENTS.has(event);
}

function runtimeProjectLoopEventData(
  event: "loop:start" | "step:before" | "loop:transition" | "step:after" | "loop:end",
  data: Readonly<{ context: ContextBag } & Record<string, unknown>>,
  loop: string,
  resumed: boolean,
): Record<string, unknown> {
  if (event === "loop:start") return { loop, resumed };
  if (event === "loop:end") {
    return { loop, status: recordValue(data.loop)?.status ?? data.status ?? "completed" };
  }
  if (event === "loop:transition") {
    const transition = recordValue(data.transition);
    return {
      loop,
      from: transition?.from,
      to: transition?.to,
      fromStepKey: transition?.fromStepKey,
      toStepKey: transition?.toStepKey,
    };
  }
  const step = recordValue(data.step);
  return {
    loop,
    step: step?.name,
    stepKey: step?.key,
    kind: step?.type,
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const runtimeSurfaces = new Set(["agent", "task", "channel", "webhook"]);
const runtimeSources = new Set([
  "request",
  "channel",
  "task",
  "schedule",
  "loop-step",
  "internal",
]);
const LOOP_RUN_PERSIST_ATTEMPTS = 3;

async function persistLoopRunUpdate(
  store: LoopRunStore,
  runId: string,
  patch: Partial<Omit<LoopRunRecord, "id" | "startedAt">>,
  emit: CompletionRouteDeps["emit"],
  phase: string,
): Promise<LoopRunRecord> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOOP_RUN_PERSIST_ATTEMPTS; attempt += 1) {
    try {
      const updated = await store.updateRun(runId, patch);
      if (!updated) throw new Error(`Loop run "${runId}" no longer exists`);
      return updated;
    } catch (error) {
      lastError = error;
      emit("loop_run:persist_retry", {
        loopRunId: runId,
        phase,
        attempt,
        maxAttempts: LOOP_RUN_PERSIST_ATTEMPTS,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw lastError;
}

function runtimeInvocationMetadata(
  value: unknown,
): CompletionRuntimeInvocation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.surface !== "string"
    || !runtimeSurfaces.has(candidate.surface)
    || typeof candidate.source !== "string"
    || !runtimeSources.has(candidate.source)
  ) {
    return undefined;
  }
  return {
    surface: candidate.surface as CompletionRuntimeInvocation["surface"],
    source: candidate.source as CompletionRuntimeInvocation["source"],
    ...(candidate.channelEvent
      && typeof candidate.channelEvent === "object"
      && !Array.isArray(candidate.channelEvent)
      ? {
          channelEvent: candidate.channelEvent as Readonly<Record<string, unknown>>,
        }
      : {}),
    ...(typeof candidate.channelId === "string" && candidate.channelId.trim()
      ? { channelId: candidate.channelId }
      : {}),
    ...(typeof candidate.requestId === "string" && candidate.requestId.trim()
      ? { requestId: candidate.requestId }
      : {}),
    ...(typeof candidate.runId === "string" && candidate.runId.trim()
      ? { runId: candidate.runId }
      : {}),
    ...(candidate.scope
      && typeof candidate.scope === "object"
      && !Array.isArray(candidate.scope)
      && typeof (candidate.scope as Record<string, unknown>).key === "string"
      && (candidate.scope as Record<string, unknown>).key
      ? {
          scope: {
            key: String((candidate.scope as Record<string, unknown>).key),
            ...(typeof (candidate.scope as Record<string, unknown>).version === "string"
              ? { version: String((candidate.scope as Record<string, unknown>).version) }
              : {}),
          },
        }
      : {}),
  };
}

function stringArrayRuntimeValue(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`Loop resume ${field} is invalid`);
  }
  return value.map((entry) => entry.trim());
}

function projectLoopToolInvocation(input: {
  agentIdentity?: AgentIdentity;
  loopRunId?: string;
  runtimeInvocation?: CompletionRuntimeInvocation;
  sessionId?: string | null;
  user?: string;
  requestMetadata?: Readonly<Record<string, string>>;
}): ToolInvocationContext {
  const runtime = input.runtimeInvocation;
  const id = input.loopRunId ?? runtime?.runId ?? runtime?.requestId ?? `loop-${nanoid(16)}`;
  return createToolInvocationContext({
    ...(input.agentIdentity ? { agent: input.agentIdentity } : {}),
    requestId: runtime?.requestId ?? id,
    runId: input.loopRunId ?? runtime?.runId ?? id,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(runtime?.user ?? input.user ? { user: runtime?.user ?? input.user } : {}),
    metadata: (runtime?.metadata ?? input.requestMetadata ?? {}) as Record<
      string,
      ToolInvocationJsonValue
    >,
    ...(runtime?.scope ? { scope: runtime.scope } : {}),
    // The invocation has transitioned into a Project Loop. Preserve trusted
    // ingress identity separately, but do not leak the prior surface policy.
    surface: "loop",
  });
}

function loopRequestMetadata(
  run: LoopRunRecord,
): Record<string, string> | undefined {
  const request = run.resume?.context.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }
  const metadata = (request as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const entries = Object.entries(metadata);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("Loop resume request metadata is invalid");
  }
  return Object.fromEntries(entries);
}

function latestUserText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const candidate = message as { role?: unknown; content?: unknown };
    if (candidate.role !== "user") continue;
    if (typeof candidate.content === "string") return candidate.content.trim();
    if (!Array.isArray(candidate.content)) return "";
    return candidate.content
      .filter((part): part is { type: "text"; text: string } =>
        !!part
        && typeof part === "object"
        && (part as { type?: unknown }).type === "text"
        && typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Approval resumes resolve a new snapshot. Persisting retrieved content would
 * retain forgotten or newly unauthorized data across the approval boundary.
 */
export async function resolveProjectLoopResumeRuntimeContext(
  deps: CompletionRouteDeps,
  run: LoopRunRecord,
  aiMessages = Array.isArray(run.resume?.runtime?.aiMessages)
    ? run.resume.runtime.aiMessages
    : [],
): Promise<RuntimeContextResolution | undefined> {
  if (!deps.runtimeContext || !run.agentName) return undefined;
  const query = latestUserText(aiMessages);
  if (!query) return undefined;
  const invocation = runtimeInvocationMetadata(
    run.metadata?.runtimeInvocation,
  ) ?? { surface: "agent", source: "loop-step" };
  try {
    return await resolveRuntimeContext(deps.runtimeContext, {
      agentName: run.agentName,
      query,
      surface: invocation.surface,
      source: invocation.source,
      ...(run.user ? { externalUserId: run.user } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(invocation.channelId ? { channelId: invocation.channelId } : {}),
      runId: run.id,
      ...(invocation.scope ? { scope: invocation.scope } : {}),
    });
  } catch {
    throw new Error("Runtime context retrieval failed");
  }
}

export async function runProjectLoopCompletion(options: {
  deps: CompletionRouteDeps;
  agentConfig: any;
  agentIdentity?: AgentIdentity;
  projectLoop: ProjectLoopConfig;
  aiMessages: any[];
  extraSystemParts: string[];
  contextTrust?: RuntimeContextTrustMode;
  runtimeContext?: RuntimeContextResolution;
  runtimeInvocation?: CompletionRuntimeInvocation;
  toolInvocation?: ToolInvocationContext;
  sessionId?: string | null;
  user?: string;
  requestMetadata?: Readonly<Record<string, string>>;
  runtimePlan?: RuntimePlan;
  signal?: AbortSignal;
  onToolCall?: (toolCall: LoopRuntimeToolCall) => Promise<void>;
  onTrace?: (event: LoopTraceEvent) => Promise<void>;
  onReasoning?: (text: string) => Promise<void>;
  resumeRun?: LoopRunRecord;
  executionRoute?: ResolvedExecutionRoute;
  activatedSkills?: readonly string[];
  deliveryRunId?: string;
  parallelToolCalls?: boolean;
  requestAllowedTools?: readonly string[];
  executionAllowedTools?: readonly string[];
  grantAllowedTools?: readonly string[];
  /** Public completion-Run steering scope shared by every agentic graph node. */
  steering?: SteeringController;
  /** Trusted project fallback, below the graph/agent declarations. */
  steeringPolicy?: SteeringPolicy;
}): Promise<ProjectLoopRunResult> {
  const {
    deps,
    agentConfig,
    projectLoop,
    aiMessages,
    extraSystemParts,
    runtimeContext,
    runtimeInvocation,
    toolInvocation: providedToolInvocation,
    sessionId,
    user,
    onToolCall,
    onTrace,
    resumeRun,
    runtimePlan,
    executionRoute,
  } = options;
  const activatedSkills = [...(options.activatedSkills ?? [])];
  const contextTrust = normalizeRuntimeContextTrustMode(
    options.contextTrust
      ?? resumeRun?.resume?.runtime?.contextTrust
      ?? deps.getConfig()?.settings?.contextTrust,
  );
  const normalized = normalizeProjectLoop(projectLoop);
  if (!normalized.pipeline) throw new Error(`Loop "${projectLoop.name}" does not define a pipeline`);

  const loopRunStore = deps.getLoopRunStore?.();
  const resumeState = resumeRun?.resume;
  const agentCheckpoint = resumeState?.runtime?.agentStep as AgentStepCheckpoint | undefined;
  if (agentCheckpoint && (resumeState?.steps[0] as any)?.loop !== agentCheckpoint.step) throw new TerminationGateError("termination_gate_checkpoint_invalid", "Agent checkpoint does not match the pipeline cursor");
  const initialContext: ContextBag = resumeState?.context ?? {
    request: {
      metadata: { ...(options.requestMetadata ?? {}) },
    },
  };
  const loopRunId = resumeRun?.id ?? (loopRunStore ? `looprun-${nanoid(16)}` : undefined);
  const runtimeHookDispatcher = await deps.resolveRuntimeHooks?.({
    agentConfig,
    surface: "loop",
    runId: loopRunId,
    sessionId: sessionId ?? undefined,
    loop: projectLoop.name,
    activatedSkills,
  });
  const runtimeHooks: CompletionRuntimeHookContext | undefined = runtimeHookDispatcher
    ? {
        dispatcher: runtimeHookDispatcher,
        surface: "loop",
        identity: {
          runId: loopRunId,
          sessionId: sessionId ?? undefined,
          agent: agentConfig.name,
          loop: projectLoop.name,
        },
      }
    : undefined;
  const agentIdentity = options.agentIdentity === undefined ? providedToolInvocation?.agent : normalizeAgentIdentity(options.agentIdentity);
  if ((agentIdentity && agentIdentity.name !== agentConfig.name)
    || (providedToolInvocation?.agent && (providedToolInvocation.agent.name !== agentIdentity?.name
      || providedToolInvocation.agent.incarnation !== agentIdentity?.incarnation))) throw new AgentIdentityError();
  const toolInvocation = providedToolInvocation ? createToolInvocationContext({
      ...providedToolInvocation,
      metadata: providedToolInvocation.metadata as Record<string, ToolInvocationJsonValue>,
      ...(agentIdentity ? { agent: agentIdentity } : {}),
    }) : projectLoopToolInvocation({
      agentIdentity,
      loopRunId,
      runtimeInvocation,
      sessionId,
      user,
      requestMetadata: options.requestMetadata,
    });
  const toolRunScope = await deps.createToolRunScope?.({
    agentConfig,
    runId: loopRunId,
    sessionId: sessionId ?? undefined,
    runtimePlan,
    signal: options.signal,
  });
  let rootTools: Awaited<ReturnType<CompletionRouteDeps["resolveAgentTools"]>>;
  try {
    rootTools = await deps.resolveAgentTools(
      agentConfig,
      toolRunScope,
      toolInvocation,
      options.signal,
    );
  } catch (error) {
    await toolRunScope?.cleanup?.().catch(() => {});
    throw error;
  }
  const cleanupToolRun = async () => {
    await rootTools.cleanup?.().catch(() => {});
    await toolRunScope?.cleanup?.().catch(() => {});
  };
  const rootPolicy = resolveExecutionToolPolicy({
    agent: agentConfig,
    mode: "loop",
    requestAllowedTools: options.requestAllowedTools,
    executionAllowedTools: options.executionAllowedTools,
    loopAllowedTools: projectLoop.allowedTools,
    grantAllowedTools: options.grantAllowedTools,
  });
  const rootResolvedTools = rootTools.runtimeTools ?? rootTools.tools;
  const deterministicTools = filterToolDefinitionsByPolicy(
    rootResolvedTools,
    rootPolicy,
  );
  deps.emit("runtime:tool-policy", toolPolicyAuditData({
    policy: rootPolicy,
    requested: rootResolvedTools
      .map((tool: any) => tool?.name)
      .filter((name: unknown): name is string => typeof name === "string"),
    mode: "loop",
  }));
  const rootExecutor = createPolicyGuardedToolExecutor(
    rootTools.runtimeExecutor ?? rootTools.executor,
    rootPolicy,
  );
  const executeLoopTool = createRuntimeHookedToolExecutor({
    hooks: runtimeHooks,
    executor: createGuardedCompletionToolExecutor({
      executor: rootExecutor,
    // Validation uses the complete authorized runtime catalog. Policy denial
    // stays in rootExecutor so a known-but-denied tool returns the typed policy
    // error instead of being misclassified as an unknown tool.
    tools: rootResolvedTools,
    middleware: deps.runToolMiddleware,
    context: {
      planId: options.runtimePlan?.id,
      surface: options.runtimePlan?.surface,
      source: "loop-step",
      agent: agentConfig.name,
      runId: loopRunId,
      sessionId: sessionId ?? undefined,
    },
      receiptStore: toolRunScope?.receiptStore,
    }),
  });
  const rootToolSchemas = new Map<string, unknown>(
    deterministicTools
      .filter((tool: any) => tool
        && typeof tool.name === "string"
        && (tool.parameters !== undefined || tool.inputSchema !== undefined))
      .map((tool: any) => [tool.name, tool.parameters ?? tool.inputSchema]),
  );
  const validateDeterministicToolInput = async (
    name: string,
    input: unknown,
  ): Promise<Record<string, unknown>> => {
    let args = normalizeToolInput(input);
    if (!rootToolSchemas.has(name)) return args;
    const validation = await validateToolInput(rootToolSchemas.get(name), args);
    if (!validation.success) {
      throw new LoopToolInputValidationError(name, validation.error.message);
    }
    args = normalizeToolInput(validation.value);
    return args;
  };
  const initialModel = agentConfigForModelPrimary(
    agentConfig,
    deps.getConfig()?.settings,
  ).model ?? "polpo";
  if (loopRunStore && loopRunId && resumeRun) {
    await persistLoopRunUpdate(loopRunStore, loopRunId, {
      status: "resuming",
      error: undefined,
      completedAt: undefined,
      metadata: {
        ...resumeRun.metadata,
        resumedAt: new Date().toISOString(),
        resumeAttempts: (resumeState?.attempts ?? 0) + 1,
      },
      resume: resumeState ? {
        ...resumeState,
        attempts: (resumeState.attempts ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      } : undefined,
    }, deps.emit, "resuming").catch(async (error) => {
      await cleanupToolRun();
      throw error;
    });
  } else if (loopRunStore && loopRunId) {
    await loopRunStore.createRun({
      id: loopRunId,
      loop: projectLoop,
      agentName: agentConfig.name,
      sessionId: sessionId ?? undefined,
      user,
      context: initialContext,
      metadata: {
        runtime: "chat.completions",
        ...(agentIdentity ? { agentIdentity } : {}),
        ...(options.deliveryRunId ? { deliveryRunId: options.deliveryRunId } : {}),
        surface: runtimePlan?.surface ?? executionRoute?.surface ?? "agent",
        source:
          runtimePlan?.source
          ?? executionRoute?.invocationSource
          ?? "request",
        execution: {
          mode: "loop",
          loop: projectLoop.name,
          source:
            runtimePlan?.execution.source
            ?? executionRoute?.decisionSource
            ?? "request",
        },
        ...(runtimePlan ? { runtimePlanId: runtimePlan.id } : {}),
        ...(executionRoute
          ? {
              executionRoute: {
                status: executionRoute.status,
                decisionSource: executionRoute.decisionSource,
                confidence: executionRoute.confidence,
                reason: executionRoute.reason,
                latencyMs: executionRoute.latencyMs,
                fallbackUsed: executionRoute.fallbackUsed,
              },
            }
          : {}),
        loopVersion: projectLoop.version ?? "1",
        ...(runtimeInvocation
          ? {
              runtimeInvocation: {
                surface: runtimeInvocation.surface,
                source: runtimeInvocation.source,
                ...(runtimeInvocation.channelEvent
                  ? { channelEvent: runtimeInvocation.channelEvent }
                  : {}),
                ...(runtimeInvocation.channelId
                  ? { channelId: runtimeInvocation.channelId }
                  : {}),
                ...(runtimeInvocation.requestId
                  ? { requestId: runtimeInvocation.requestId }
                  : {}),
                ...(runtimeInvocation.runId
                  ? { runId: runtimeInvocation.runId }
                  : {}),
                ...(runtimeInvocation.scope
                  ? { scope: runtimeInvocation.scope }
                  : {}),
              },
            }
          : {}),
      },
    }).catch(async (error) => {
      await cleanupToolRun();
      throw error;
    });
  }
  const executor = new PipelineExecutor();
  let finalText = "";
  let finalReasoning = "";
  let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  let lastModel = initialModel;
  let lastResolvedModel: CompletionResolvedModelInfo | undefined;
  let lastProviderMetadata: Record<string, unknown> | undefined;
  const toolCallsAccum: any[] = [];
  const events: LoopTraceEvent[] = [];
  let pendingAgentCheckpoint = agentCheckpoint;
  const persistCheckpoint = async (position: { steps: any[]; previousNode?: string; previousStepKey?: string }, context: Readonly<ContextBag>, agentStep?: AgentStepCheckpoint) => {
    if (!loopRunStore || !loopRunId) return;
    const resume = buildLoopResumeState({ ...position, context: { ...context } }, aiMessages, extraSystemParts,
      resumeState?.approvedGates, contextTrust, activatedSkills, options.parallelToolCalls,
      options.requestAllowedTools, options.executionAllowedTools, options.grantAllowedTools)!;
    if (agentStep) resume.runtime = { ...resume.runtime, agentStep };
    const serialized = JSON.stringify(resume);
    if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) throw new TerminationGateError("termination_gate_checkpoint_too_large", "Agent checkpoint exceeds 2 MiB; execution stopped before another operation");
    await persistLoopRunUpdate(loopRunStore, loopRunId, { resume: JSON.parse(serialized) }, deps.emit, "checkpoint");
  };

  await options.steering?.setBoundary({ open: false, reservable: false });

  const emitTrace = async (event: LoopTraceEvent) => {
    events.push(event);
    if (loopRunStore && loopRunId) {
      try {
        await loopRunStore.appendTrace(loopRunId, event);
      } catch (err) {
        deps.emit("loop_run:trace_persist_failed", {
          loopRunId,
          loop: projectLoop.name,
          eventType: event.type,
          error: (err as Error).message,
        });
      }
    }
    try {
      await onTrace?.(event);
    } catch (err) {
      deps.emit("loop_run:trace_delivery_failed", {
        loopRunId,
        loop: projectLoop.name,
        eventType: event.type,
        error: (err as Error).message,
      });
    }
  };

  try {
    await dispatchCompletionRuntimeHook(runtimeHooks, "run:start", {
      loop: projectLoop.name,
      resumed: Boolean(resumeRun),
    });
    const result = await executor.execute({
      name: projectLoop.name,
      pipeline: resumeState ? { ...normalized.pipeline, steps: resumeState.steps } : normalized.pipeline,
      loops: normalized.loops,
      context: initialContext,
      protectedContextRoots: ["request"],
      projectHooks: projectLoop.hooks,
      projectPermissions: projectLoop.permissions,
      projectPolicies: projectLoop.policies,
      resume: resumeState ? {
        previousNode: resumeState.previousNode,
        previousStepKey: resumeState.previousStepKey,
        approvedGates: resumeState.approvedGates,
      } : undefined,
      checkpointRequired: true,
      onCheckpoint: loopRunStore ? async checkpoint => persistCheckpoint(checkpoint, checkpoint.context) : undefined,
      onTrace: async (event) => {
        await emitTrace(event);
      },
      onLifecyclePoint: async (event, data) => {
        if (!isRuntimeProjectLoopEvent(event)) return;
        const decision = await dispatchCompletionRuntimeHook(
          runtimeHooks,
          event,
          runtimeProjectLoopEventData(event, data, projectLoop.name, Boolean(resumeRun)),
        );
        const error = runtimeHookDecisionError(decision);
        if (error) throw error;
      },
      validateToolInput: validateDeterministicToolInput,
      runTool: async (name, input) => {
        const args = normalizeToolInput(input);
        const id = `loop-tool-${nanoid(12)}`;
        await onToolCall?.({
          id,
          name,
          arguments: args,
          state: "calling",
        });
        const output = await executeLoopTool(name, args, {
          callId: id,
          signal: options.signal,
        });
        const isError = output.startsWith("Error:");
        emitFileChanged(name, args, output, deps.emit);
        const event = {
          id,
          name,
          arguments: args,
          result: output,
          state: isError ? "error" as const : "completed" as const,
        };
        toolCallsAccum.push(event);
        await onToolCall?.(event);
        if (isError) throw new Error(output);
        return { output: maybeParseJson(output) };
      },
      runLoop: async (name, loop, context, position, agentInput) => {
        const id = `loop-step-${nanoid(12)}`;
        await onToolCall?.({
          id,
          name: `loop:${name}`,
          arguments: { loop: projectLoop.name, step: name },
          state: "calling",
        });
        const stepAgent = buildLoopStepAgent(agentConfig, name, loop);
        const stepAllowedTools = loop.allowedTools ?? loop.tools;
        const stepToolPolicy = resolveExecutionToolPolicy({
          agent: agentConfig,
          mode: "loop",
          requestAllowedTools: options.requestAllowedTools,
          executionAllowedTools: options.executionAllowedTools,
          loopAllowedTools: projectLoop.allowedTools,
          stepAllowedTools,
          grantAllowedTools: options.grantAllowedTools,
        });
        const stepSkillNames = new Set(
          Array.isArray(stepAgent.skills)
            ? stepAgent.skills.filter(
                (skill: unknown): skill is string => typeof skill === "string",
              )
            : [],
        );
        const stepActivatedSkills = activatedSkills.filter((skill) =>
          stepSkillNames.has(skill)
        );
        const stepResume = pendingAgentCheckpoint;
        pendingAgentCheckpoint = undefined;
        const stepResult = await runAgentStepCompletion({
          deps,
          agentConfig: stepAgent,
          aiMessages,
          extraSystemParts,
          context,
          stepName: name,
          loopName: projectLoop.name,
          resume: stepResume,
          checkpointAvailable: !loopRunStore || Boolean(position),
          onCheckpoint: loopRunStore ? async checkpoint => {
            if (!position) throw new TerminationGateError("termination_gate_parallel_unsupported", "Durable termination gates require a sequential agent step; parallel checkpoint/resume is not supported");
            await persistCheckpoint(position, context, checkpoint);
          } : undefined,
          contextTrust,
          runtimePlan: options.runtimePlan,
          signal: options.signal,
          runId: loopRunId,
          sessionId: sessionId ?? undefined,
          runtimeContext,
          activatedSkills: stepActivatedSkills,
          toolRunScope,
          toolInvocation,
          onToolCall,
          onReasoning: options.onReasoning,
          parallelToolCalls: options.parallelToolCalls,
          toolPolicy: stepToolPolicy,
          projectedInput: agentInput,
          outputSchema: loop.output?.schema,
          steering: options.steering,
          steeringPolicy: resolveSteeringPolicy([
            { policy: loop.steering, source: "node" },
            { policy: projectLoop.steering, source: "loop" },
            { policy: agentConfig.steering, source: "agent" },
            { policy: options.steeringPolicy, source: "project" },
          ]),
        });
        finalText = stepResult.text || finalText;
        finalReasoning = appendReasoningSummary(finalReasoning, stepResult.reasoning);
        totalUsage = addUsage(totalUsage, stepResult.usage);
        lastModel = stepResult.model;
        lastResolvedModel = stepResult.resolvedModel;
        lastProviderMetadata = stepResult.providerMetadata;
        toolCallsAccum.push(...stepResult.toolCalls);
        const output = stringifyLoopContext({ [name]: stepResult.output });
        const event = {
          id,
          name: `loop:${name}`,
          arguments: { loop: projectLoop.name, step: name },
          result: output,
          state: "completed" as const,
        };
        toolCallsAccum.push(event);
        await onToolCall?.(event);
        return { output: stepResult.output };
      },
      handleHuman: async (name) => {
        throw new Error(`Loop human step "${name}" cannot run inside chat completions yet`);
      },
    });

    const projectedResult = prepareProjectLoopResult(projectLoop.result, result.context);
    if (projectedResult.presentation) finalText = projectedResult.presentation.text;
    if (!finalText) finalText = JSON.stringify(loopUserVisibleContext(result.context), null, 2);
    if (loopRunStore && loopRunId) {
      await persistLoopRunUpdate(loopRunStore, loopRunId, {
        status: "completed",
        context: result.context,
        trace: resumeRun ? [...resumeRun.trace, ...result.events] : result.events,
        ...(projectedResult.data === undefined ? {} : { result: projectedResult.data }),
        ...(projectedResult.presentation === undefined
          ? {}
          : { presentation: projectedResult.presentation }),
        resume: undefined,
        approval: resumeRun?.approval ? { ...resumeRun.approval, status: "approved" } : undefined,
        completedAt: new Date().toISOString(),
      }, deps.emit, "completed");
    }
    await dispatchCompletionRuntimeHook(runtimeHooks, "run:end", {
      loop: projectLoop.name,
      status: "completed",
    });
    await options.steering?.close("too_late", "graph_finished");
    return {
      text: finalText,
      reasoning: finalReasoning,
      usage: totalUsage,
      model: lastModel,
      resolvedModel: lastResolvedModel,
      providerMetadata: lastProviderMetadata,
      toolCalls: toolCallsAccum,
      context: result.context,
      trace: result.events,
      loopRunId,
      ...(projectedResult.data === undefined ? {} : { loopResult: projectedResult.data }),
      ...(projectedResult.presentation === undefined
        ? {}
        : { loopPresentation: projectedResult.presentation }),
    };
  } catch (err) {
    const awaitingApproval = err instanceof LoopApprovalRequiredError || err instanceof LoopPermissionApprovalRequiredError;
    await options.steering?.close(
      options.signal?.aborted ? "cancelled" : awaitingApproval ? "cancelled" : "failed",
      options.signal?.aborted
        ? "graph_cancelled"
        : awaitingApproval
          ? "graph_suspended_for_approval"
          : "graph_failed",
    );
    if (awaitingApproval) {
      await dispatchCompletionRuntimeHook(runtimeHooks, "approval:request", {
        loop: projectLoop.name,
        approvalType: err instanceof LoopPermissionApprovalRequiredError ? "permission" : "policy",
        gateId: err instanceof LoopPermissionApprovalRequiredError
          ? err.permission.id ?? "anonymous"
          : err.policy.id ?? "anonymous",
        lifecycle: err.hook,
        reason: err.message,
      }).catch(() => {});
      await dispatchCompletionRuntimeHook(runtimeHooks, "loop:stop", {
        loop: projectLoop.name,
        status: "awaiting_approval",
      }).catch(() => {});
    }
    await dispatchCompletionRuntimeHook(runtimeHooks, "loop:end", {
      loop: projectLoop.name,
      status: awaitingApproval ? "awaiting_approval" : "failed",
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    await dispatchCompletionRuntimeHook(runtimeHooks, "run:end", {
      loop: projectLoop.name,
      status: awaitingApproval ? "awaiting_approval" : "failed",
    }).catch(() => {});
    if (loopRunStore && loopRunId) {
      (err as any).loopRunId = loopRunId;
      if (err instanceof LoopApprovalRequiredError || err instanceof LoopPermissionApprovalRequiredError) {
        const approvalStore = deps.getApprovalStore?.();
        let approvalRequestId: string | undefined;
        const gateId = err instanceof LoopPermissionApprovalRequiredError
          ? err.permission.id ?? `loop-permission-${nanoid(8)}`
          : err.policy.id ?? `loop-policy-${nanoid(8)}`;
        const gateName = err instanceof LoopPermissionApprovalRequiredError
          ? err.permission.description ?? err.permission.id ?? "Loop permission approval"
          : err.policy.description ?? err.policy.id ?? "Loop policy approval";
        const approvalType = err instanceof LoopPermissionApprovalRequiredError ? "permission" : "policy";
        if (approvalStore) {
          approvalRequestId = `approval-${nanoid(16)}`;
          await approvalStore.upsert({
            id: approvalRequestId,
            gateId,
            gateName,
            status: "pending",
            payload: {
              type: "loop_approval",
              approvalType,
              loopRunId,
              loopName: projectLoop.name,
              agentName: agentConfig.name,
              hook: err.hook,
              ...(err instanceof LoopPermissionApprovalRequiredError ? { permission: err.permission } : { policy: err.policy }),
              payload: err.payload,
              context: err.context,
              trace: events,
            },
            requestedAt: new Date().toISOString(),
          });
          (err as any).approvalRequestId = approvalRequestId;
        }
        await persistLoopRunUpdate(loopRunStore, loopRunId, {
          status: "awaiting_approval",
          context: err.context,
          trace: resumeRun ? [...resumeRun.trace, ...events] : events,
          approvalRequestId,
          approval: {
            type: approvalType,
            policyId: err instanceof LoopPermissionApprovalRequiredError ? "permission" : err.policy.id ?? "anonymous",
            permissionId: err instanceof LoopPermissionApprovalRequiredError ? err.permission.id ?? "anonymous" : undefined,
            hook: err.hook,
            message: err instanceof LoopPermissionApprovalRequiredError ? err.permission.message : err.policy.message,
            payload: err.payload,
            context: err.context,
            status: "pending",
          },
          resume: buildLoopResumeState(
            err.resume,
            aiMessages,
            extraSystemParts,
            resumeRun?.resume?.approvedGates,
            contextTrust,
            activatedSkills,
            options.parallelToolCalls,
            options.requestAllowedTools,
            options.executionAllowedTools,
            options.grantAllowedTools,
          ),
          error: err.message,
        }, deps.emit, "awaiting_approval");
      } else {
        try {
          await persistLoopRunUpdate(loopRunStore, loopRunId, {
            status: "failed",
            trace: resumeRun ? [...resumeRun.trace, ...events] : events,
            error: err instanceof Error ? err.message : String(err),
            completedAt: new Date().toISOString(),
          }, deps.emit, "failed");
        } catch (persistenceError) {
          deps.emit("loop_run:terminal_persist_failed", {
            loopRunId,
            loop: projectLoop.name,
            status: "failed",
            error: persistenceError instanceof Error
              ? persistenceError.message
              : String(persistenceError),
          });
        }
      }
    }
    throw err;
  } finally {
    await options.steering?.close("too_late", "graph_scope_released");
    await cleanupToolRun();
  }
}

export function buildLoopResumeState(
  continuation: {
    context: ContextBag;
    steps: any[];
    previousNode?: string;
    previousStepKey?: string;
  } | undefined,
  aiMessages: any[],
  extraSystemParts: string[],
  approvedGates: LoopApprovedGate[] | undefined,
  contextTrust: RuntimeContextTrustMode = "off",
  activatedSkills: readonly string[] = [],
  parallelToolCalls?: boolean,
  requestAllowedTools?: readonly string[],
  executionAllowedTools?: readonly string[],
  grantAllowedTools?: readonly string[],
): LoopResumeState | undefined {
  if (!continuation) return undefined;
  return {
    context: continuation.context,
    steps: continuation.steps,
    previousNode: continuation.previousNode,
    previousStepKey: continuation.previousStepKey,
    approvedGates: approvedGates ?? [],
    runtime: {
      aiMessages,
      extraSystemParts,
      ...(contextTrust === "enforce" ? { contextTrust } : {}),
      ...(activatedSkills.length > 0
        ? { activatedSkills: [...activatedSkills] }
        : {}),
      ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
      ...(requestAllowedTools !== undefined
        ? { requestAllowedTools: [...requestAllowedTools] }
        : {}),
      ...(executionAllowedTools !== undefined
        ? { executionAllowedTools: [...executionAllowedTools] }
        : {}),
      ...(grantAllowedTools !== undefined
        ? { grantAllowedTools: [...grantAllowedTools] }
        : {}),
    },
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
}

export async function resumeProjectLoopRun(options: {
  deps: CompletionRouteDeps;
  runId: string;
  resolvedBy?: string;
}): Promise<LoopRunRecord> {
  const loopRunStore = options.deps.getLoopRunStore?.();
  if (!loopRunStore) throw new Error("Loop run store is not configured");

  const run = await loopRunStore.getRun(options.runId);
  if (!run) throw new Error(`Loop run "${options.runId}" not found`);
  if (run.status !== "approval_approved") {
    throw new Error(`Loop run "${options.runId}" is ${run.status}, not approval_approved`);
  }
  if (!run.resume || run.resume.steps.length === 0) {
    throw new Error(`Loop run "${options.runId}" has no resume checkpoint`);
  }

  const agentIdentity = run.metadata?.agentIdentity === undefined ? undefined : normalizeAgentIdentity(run.metadata.agentIdentity);
  let agentConfig: any;
  if (options.deps.getAgentSnapshot) {
    const snapshot = run.agentName ? await options.deps.getAgentSnapshot(run.agentName) : undefined;
    assertAgentIdentity(agentIdentity, snapshot);
    agentConfig = snapshot!.agent;
  } else {
    // A bound checkpoint must never become unbound after a host downgrade.
    if (agentIdentity) throw new AgentIdentityError();
    const agents = await options.deps.getAgents();
    agentConfig = agents.find((agent: any) => agent.name === run.agentName);
  }
  if (!agentConfig) throw new Error(`Agent "${run.agentName ?? "unknown"}" not found for loop run "${run.id}"`);
  if (!options.deps.getProjectLoop) throw new Error("Project loop resolver is not configured");
  const projectLoop = await options.deps.getProjectLoop(run.loopName);
  if (!projectLoop) throw new Error(`Project loop "${run.loopName}" not found`);

  const aiMessages = Array.isArray(run.resume.runtime?.aiMessages) ? run.resume.runtime.aiMessages : [];
  const extraSystemParts = Array.isArray(run.resume.runtime?.extraSystemParts)
    ? run.resume.runtime.extraSystemParts as string[]
    : [];
  const contextTrust = normalizeRuntimeContextTrustMode(
    run.resume.runtime?.contextTrust,
  );
  const activatedSkills = Array.isArray(run.resume.runtime?.activatedSkills)
    ? run.resume.runtime.activatedSkills.filter(
        (skill): skill is string => typeof skill === "string" && skill.length > 0,
      )
    : [];
  const parallelToolCalls = typeof run.resume.runtime?.parallelToolCalls === "boolean"
    ? run.resume.runtime.parallelToolCalls
    : undefined;
  const requestAllowedTools = stringArrayRuntimeValue(
    run.resume.runtime?.requestAllowedTools,
    "requestAllowedTools",
  );
  const executionAllowedTools = stringArrayRuntimeValue(
    run.resume.runtime?.executionAllowedTools,
    "executionAllowedTools",
  );
  const grantAllowedTools = stringArrayRuntimeValue(
    run.resume.runtime?.grantAllowedTools,
    "grantAllowedTools",
  );
  const assignedSkills = new Set(
    Array.isArray(agentConfig.skills)
      ? agentConfig.skills.filter(
          (skill: unknown): skill is string => typeof skill === "string",
        )
      : [],
  );
  const removedSkill = activatedSkills.find((skill) => !assignedSkills.has(skill));
  if (removedSkill) {
    throw new Error(
      `Cannot resume loop: skill "${removedSkill}" is no longer assigned to agent "${agentConfig.name}"`,
    );
  }
  const runtimeContext = await resolveProjectLoopResumeRuntimeContext(
    options.deps,
    run,
    aiMessages,
  );
  const resolvedToolInvocation = await options.deps.resolveResumedToolInvocation?.(run);
  if (resolvedToolInvocation?.agent && (resolvedToolInvocation.agent.name !== agentIdentity?.name
    || resolvedToolInvocation.agent.incarnation !== agentIdentity?.incarnation)) throw new AgentIdentityError();
  const toolInvocation = resolvedToolInvocation
    ? createToolInvocationContext({
        ...(agentIdentity ? { agent: agentIdentity } : {}),
        requestId: resolvedToolInvocation.requestId,
        runId: resolvedToolInvocation.runId,
        ...(resolvedToolInvocation.sessionId
          ? { sessionId: resolvedToolInvocation.sessionId }
          : {}),
        ...(resolvedToolInvocation.user ? { user: resolvedToolInvocation.user } : {}),
        metadata: resolvedToolInvocation.metadata as Record<string, ToolInvocationJsonValue>,
        ...(resolvedToolInvocation.scope ? { scope: resolvedToolInvocation.scope } : {}),
        surface: resolvedToolInvocation.surface,
      })
    : undefined;
  if (toolInvocation) {
    if (toolInvocation.runId !== run.id) {
      throw new Error("Resumed tool invocation run id does not match the loop run");
    }
    if (run.sessionId && toolInvocation.sessionId !== run.sessionId) {
      throw new Error("Resumed tool invocation session id does not match the loop run");
    }
    if (run.user && toolInvocation.user !== run.user) {
      throw new Error("Resumed tool invocation user does not match the loop run");
    }
    const storedScope = runtimeInvocationMetadata(
      run.metadata?.runtimeInvocation,
    )?.scope;
    if (
      storedScope?.key !== toolInvocation.scope?.key
      || storedScope?.version !== toolInvocation.scope?.version
    ) {
      throw new Error("Resumed tool invocation scope does not match the loop run");
    }
  }

  await runProjectLoopCompletion({
    deps: options.deps,
    agentConfig,
    agentIdentity,
    projectLoop,
    aiMessages,
    extraSystemParts,
    contextTrust,
    runtimeContext,
    runtimeInvocation: runtimeInvocationMetadata(
      run.metadata?.runtimeInvocation,
    ),
    toolInvocation,
    sessionId: run.sessionId,
    user: run.user,
    requestMetadata: loopRequestMetadata(run),
    activatedSkills,
    parallelToolCalls,
    requestAllowedTools,
    executionAllowedTools,
    grantAllowedTools,
    resumeRun: run,
  });

  const updated = await loopRunStore.getRun(run.id);
  if (!updated) throw new Error(`Loop run "${run.id}" disappeared after resume`);
  return updated;
}

/**
 * HTTP wiring for loop-mode completion requests: runs the project loop
 * pipeline and adapts it to the OpenAI response surface (SSE stream with
 * tool_call / loop_trace chunks, or a single JSON body).
 */
export interface ProjectLoopCompletionOptions {
  deps: CompletionRouteDeps;
  body: Partial<Pick<CompletionRequestBody, "stream" | "agent" | "user" | "metadata" | "parallel_tool_calls" | "polpo" | "response_format">> & { messages?: CompletionRequestBody["messages"] };
  completionId: string;
  agentConfig: any;
  agentIdentity?: AgentIdentity;
  projectLoop: ProjectLoopConfig;
  aiMessages: any[];
  extraSystemParts: string[];
  contextTrust?: RuntimeContextTrustMode;
  runtimeContext?: RuntimeContextResolution;
  runtimeInvocation?: CompletionRuntimeInvocation;
  sessionStore: any;
  sessionId: string | null;
  turnId?: string;
  canonicalTurn?: CanonicalTurnPersistenceContext;
  runtimePlan?: RuntimePlan;
  executionRoute?: ResolvedExecutionRoute;
  activatedSkills?: readonly string[];
  requestAllowedTools?: readonly string[];
  executionAllowedTools?: readonly string[];
  grantAllowedTools?: readonly string[];
  /** Scope registered under completionId before response headers are exposed. */
  steeringScope?: CompletionRunSteeringScope;
}

export async function handleProjectLoopCompletion(
  c: any,
  options: ProjectLoopCompletionOptions,
): Promise<any> {
  const steeringScope = options.steeringScope
    ?? await createCompletionRunSteeringScope(options.deps, options.completionId);
  const scopedOptions = { ...options, steeringScope };
  if (options.body.stream) {
    try {
      return streamSSE(c, async (stream) => {
        const abortController = new AbortController();
        stream.onAbort(() => { abortController.abort(); });
        const heartbeatInterval = setInterval(() => {
          if (abortController.signal.aborted) {
            clearInterval(heartbeatInterval);
            return;
          }
          stream.write(": ping\n\n").catch(() => {
            clearInterval(heartbeatInterval);
          });
        }, 20_000);
        try {
          await executeStreamingProjectLoopCompletion(
            stream,
            scopedOptions,
            abortController.signal,
          );
        } finally {
          clearInterval(heartbeatInterval);
        }
      }) as any;
    } catch (error) {
      await steeringScope.release();
      throw error;
    }
  }

  return runNonStreamingProjectLoopCompletion(c, scopedOptions);
}

/** Transport-independent loop producer used by attached and durable followers. */
export async function executeStreamingProjectLoopCompletion(
  stream: CompletionSseWriter,
  options: ProjectLoopCompletionOptions,
  signal: AbortSignal,
): Promise<void> {
  const {
    deps,
    body,
    completionId,
    agentConfig,
    projectLoop,
    aiMessages,
    extraSystemParts,
    runtimeContext,
    runtimeInvocation,
    sessionStore,
    sessionId,
    runtimePlan,
    executionRoute,
    activatedSkills,
  } = options;
  const contextTrust = normalizeRuntimeContextTrustMode(
    options.contextTrust ?? deps.getConfig()?.settings?.contextTrust,
  );
  const steeringScope = options.steeringScope
    ?? await createCompletionRunSteeringScope(deps, completionId);

      let assistantMsgId: string | null = null;
      let finalText = "";
      let finalReasoning = "";
      let runUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
      let runModel = agentConfigForModelPrimary(
        agentConfig,
        deps.getConfig()?.settings,
      ).model ?? "polpo";
      let resolvedModel: CompletionResolvedModelInfo | undefined;
      let providerMetadata: Record<string, unknown> | undefined;
      let toolCalls: any[] = [];
      let canonicalTurnSucceeded = false;
      let suggestions: ChatSuggestion[] = [];
      let assistantPersisted = false;
      const outputMode = streamingOutputPolicyMode(deps.runOutputPolicy);

      try {
        await stream.writeSSE({ data: sseChunk(completionId, { role: "assistant" }) });
        if (sessionStore && sessionId) {
          const placeholder = options.turnId
            ? await sessionStore.addMessage(sessionId, "assistant", "", {
                turnId: options.turnId,
              })
            : await sessionStore.addMessage(sessionId, "assistant", "");
          assistantMsgId = placeholder.id;
        }

        const run = await runProjectLoopCompletion({
          deps,
          agentConfig,
          agentIdentity: options.agentIdentity,
          projectLoop,
          aiMessages,
          extraSystemParts,
          contextTrust,
          runtimeContext,
          runtimeInvocation,
          sessionId,
          user: body.user,
          requestMetadata: body.metadata,
          runtimePlan,
          signal,
          executionRoute,
          activatedSkills,
          deliveryRunId: completionId,
          parallelToolCalls: body.parallel_tool_calls,
          requestAllowedTools: options.requestAllowedTools,
          executionAllowedTools: options.executionAllowedTools,
          grantAllowedTools: options.grantAllowedTools,
          steering: steeringScope.steering,
          onToolCall: async (toolCall) => {
            if (signal.aborted) return;
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, { tool_call: toolCall }),
            });
          },
          onTrace: async (event) => {
            if (signal.aborted) return;
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, { loop_trace: event }),
            });
          },
          onReasoning: async (text) => {
            if (signal.aborted) return;
            await stream.writeSSE({ data: sseChunk(completionId, {}, null, { thinking: text }) });
          },
        });
        finalText = run.text;
        finalReasoning = run.reasoning;
        runUsage = run.usage;
        runModel = run.model;
        resolvedModel = run.resolvedModel;
        providerMetadata = run.providerMetadata;
        toolCalls = run.toolCalls;
        finalText = await applyCompletionOutputPolicy({
          outputPolicy: deps.runOutputPolicy,
          text: finalText,
          mode: outputMode === "buffer" ? "enforce" : "audit",
          runtimePlan,
          agent: body.agent,
          runId: run.loopRunId,
          sessionId,
          signal,
        });

        if (!signal.aborted && finalText) {
          await stream.writeSSE({ data: sseChunk(completionId, { content: finalText }) });
        }
        suggestions = await suggestionsForProjectLoopCompletion(options, finalText, assistantMsgId, signal);
        if (!signal.aborted) {
          canonicalTurnSucceeded = true;
          const committedTurn = await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCalls, {
            reasoning: finalReasoning,
            ...(suggestions.length ? { suggestions } : {}),
            ...(options.canonicalTurn ? { canonicalTurn: options.canonicalTurn } : {}),
          });
          assistantPersisted = true;
          notifyCanonicalTurnCommitted(deps.onCanonicalTurnCommitted, committedTurn);
          if (suggestions.length) {
            await stream.writeSSE({ data: ssePolpoChunk(completionId, { suggestions, ...(assistantMsgId ? { suggestionsSource: { assistantMessageId: assistantMsgId } } : {}) }) });
          }
          await stream.writeSSE({
            data: sseChunk(completionId, {}, "stop", {
              loop_run_id: run.loopRunId,
              ...(run.loopResult === undefined ? {} : { loop_result: run.loopResult }),
              ...(run.loopPresentation === undefined
                ? {}
                : { loop_presentation: run.loopPresentation }),
            }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        }
      } catch (err) {
        if ((err instanceof DOMException && err.name === "AbortError") || signal.aborted) {
          return;
        }
        const guardrailError = guardrailErrorEnvelope(err);
        const notFound = modelNotFoundEnvelope(err, runModel, body.agent);
        if (guardrailError) {
          finalText = guardrailError.message;
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: guardrailError }) });
          await stream.writeSSE({ data: "[DONE]" });
          return;
        }
        if (notFound) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: notFound }) });
          await stream.writeSSE({ data: "[DONE]" });
          return;
        }
        const loopError = loopRuntimeErrorEnvelope(err);
        if (loopError) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: loopError }) });
          await stream.writeSSE({ data: "[DONE]" });
          return;
        }
        const runtimeError = completionRuntimeErrorEnvelope(err);
        if (runtimeError) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: runtimeError.error }) });
          await stream.writeSSE({ data: "[DONE]" });
          return;
        }
        throw err;
      } finally {
        const committedTurn = assistantPersisted ? undefined : await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCalls, {
          reasoning: finalReasoning,
          ...(canonicalTurnSucceeded && options.canonicalTurn
            ? { canonicalTurn: options.canonicalTurn }
            : {}),
        });
        notifyCanonicalTurnCommitted(deps.onCanonicalTurnCommitted, committedTurn);
        try {
          deps.onCompletionFinished?.({
            usage: runUsage,
            model: runModel,
            resolvedModel,
            agent: body.agent,
            sessionId: sessionId ?? undefined,
            user: body.user,
            providerMetadata,
          });
        } catch { /* never fail on callback */ }
        await steeringScope.release();
      }
}

async function runNonStreamingProjectLoopCompletion(
  c: any,
  options: ProjectLoopCompletionOptions,
): Promise<any> {
  const {
    deps,
    body,
    completionId,
    agentConfig,
    projectLoop,
    aiMessages,
    extraSystemParts,
    runtimeContext,
    runtimeInvocation,
    sessionStore,
    sessionId,
    runtimePlan,
    executionRoute,
    activatedSkills,
  } = options;
  const contextTrust = normalizeRuntimeContextTrustMode(
    options.contextTrust ?? deps.getConfig()?.settings?.contextTrust,
  );
  const steeringScope = options.steeringScope
    ?? await createCompletionRunSteeringScope(deps, completionId);
  let assistantMsgId: string | null = null;
  let runUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  let runModel = agentConfigForModelPrimary(
    agentConfig,
    deps.getConfig()?.settings,
  ).model ?? "polpo";
  let resolvedModel: CompletionResolvedModelInfo | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  let toolCalls: any[] = [];
  let finalText = "";
  let finalReasoning = "";
  let canonicalTurnSucceeded = false;
  let suggestions: ChatSuggestion[] = [];
  try {
    if (sessionStore && sessionId) {
      const placeholder = options.turnId
        ? await sessionStore.addMessage(sessionId, "assistant", "", {
            turnId: options.turnId,
          })
        : await sessionStore.addMessage(sessionId, "assistant", "");
      assistantMsgId = placeholder.id;
    }
    const run = await runProjectLoopCompletion({
      deps,
      agentConfig,
      agentIdentity: options.agentIdentity,
      projectLoop,
      aiMessages,
      extraSystemParts,
      contextTrust,
      runtimeContext,
      runtimeInvocation,
      sessionId,
      user: body.user,
      requestMetadata: body.metadata,
      runtimePlan,
      signal: c.req.raw.signal,
      executionRoute,
      activatedSkills,
      deliveryRunId: completionId,
      parallelToolCalls: body.parallel_tool_calls,
      requestAllowedTools: options.requestAllowedTools,
      executionAllowedTools: options.executionAllowedTools,
      grantAllowedTools: options.grantAllowedTools,
      steering: steeringScope.steering,
    });
    finalText = run.text;
    finalReasoning = run.reasoning;
    runUsage = run.usage;
    runModel = run.model;
    resolvedModel = run.resolvedModel;
    providerMetadata = run.providerMetadata;
    toolCalls = run.toolCalls;
    finalText = await applyCompletionOutputPolicy({
      outputPolicy: deps.runOutputPolicy,
      text: finalText,
      mode: "enforce",
      runtimePlan,
      agent: body.agent,
      runId: run.loopRunId,
      sessionId,
    });
    suggestions = await suggestionsForProjectLoopCompletion(options, finalText, assistantMsgId, c.req.raw.signal);
    canonicalTurnSucceeded = true;
    return c.json(completionResponse(completionId, finalText, runUsage, {
      ...(suggestions.length ? { polpo: { suggestions, ...(assistantMsgId ? { suggestionsSource: { assistantMessageId: assistantMsgId } } : {}) } } : {}),
      loop_trace: run.trace,
      loop_run_id: run.loopRunId,
      ...(run.loopResult === undefined ? {} : { loop_result: run.loopResult }),
      ...(run.loopPresentation === undefined
        ? {}
        : { loop_presentation: run.loopPresentation }),
    }));
  } catch (err) {
    const guardrailError = guardrailErrorEnvelope(err);
    if (guardrailError) {
      finalText = guardrailError.message;
      return c.json(
        { error: guardrailError },
        (guardrailError.code === "guardrail_approval_required" ? 409 : 403) as any,
      );
    }
    const notFound = modelNotFoundEnvelope(err, runModel, body.agent);
    if (notFound) {
      return c.json({ error: notFound }, 400 as any);
    }
    const loopError = loopRuntimeErrorEnvelope(err);
    if (loopError) {
      const invalidInput = loopError.code === "loop_binding_invalid"
        || loopError.code === "loop_binding_missing"
        || loopError.code === "loop_context_readonly"
        || loopError.code === "loop_tool_input_invalid"
        || loopError.code === "loop_agent_input_invalid"
        || loopError.code === "loop_agent_input_too_large"
        || loopError.code === "loop_result_invalid";
      return c.json({ error: loopError }, (invalidInput ? 400 : 403) as any);
    }
    const runtimeError = completionRuntimeErrorEnvelope(err);
    if (runtimeError) {
      return c.json({ error: runtimeError.error }, runtimeError.status as any);
    }
    throw err;
  } finally {
    const committedTurn = await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCalls, {
      reasoning: finalReasoning,
      ...(suggestions.length ? { suggestions } : {}),
      ...(canonicalTurnSucceeded && options.canonicalTurn
        ? { canonicalTurn: options.canonicalTurn }
        : {}),
    });
    notifyCanonicalTurnCommitted(deps.onCanonicalTurnCommitted, committedTurn);
    try {
      deps.onCompletionFinished?.({
        usage: runUsage,
        model: runModel,
        resolvedModel,
        agent: body.agent,
        sessionId: sessionId ?? undefined,
        user: body.user,
        providerMetadata,
      });
    } catch { /* never fail on callback */ }
    await steeringScope.release();
  }
}
