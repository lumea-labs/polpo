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
  maybeParseJson,
  normalizeProjectLoop,
  normalizeRuntimeContextTrustMode,
  normalizeToolInput,
  loopUserVisibleContext,
  resolveRuntimeContext,
  stringifyLoopContext,
  type ContextBag,
  type LoopApprovedGate,
  type LoopRunRecord,
  type LoopResumeState,
  type LoopTraceEvent,
  type ProjectLoopConfig,
  type RuntimeContextTrustMode,
  type RuntimeContextResolution,
  type ResolvedExecutionRoute,
  type RuntimePlan,
  type ToolInvocationContext,
  type ToolInvocationJsonValue,
} from "@polpo-ai/core";
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
} from "./sse.js";
import { emitFileChanged, persistAssistantMessage, type LoopRuntimeToolCall } from "./tool-mapping.js";
import { createGuardedCompletionToolExecutor } from "./tool-guardrails.js";
import {
  applyCompletionOutputPolicy,
  streamingOutputPolicyMode,
} from "./output-guardrails.js";
import type { CompletionSseWriter } from "./chat-handler.js";

export interface ProjectLoopRunResult {
  text: string;
  usage: LanguageModelUsage;
  model: string;
  resolvedModel?: CompletionResolvedModelInfo;
  providerMetadata?: Record<string, unknown>;
  toolCalls: any[];
  context: ContextBag;
  trace: LoopTraceEvent[];
  loopRunId?: string;
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

function projectLoopToolInvocation(input: {
  loopRunId?: string;
  runtimeInvocation?: CompletionRuntimeInvocation;
  sessionId?: string | null;
  user?: string;
  requestMetadata?: Readonly<Record<string, string>>;
}): ToolInvocationContext {
  const runtime = input.runtimeInvocation;
  const id = input.loopRunId ?? runtime?.runId ?? runtime?.requestId ?? `loop-${nanoid(16)}`;
  const surface = runtime?.surface === "channel" || runtime?.source === "channel"
    ? "channel"
    : runtime?.source === "schedule"
      ? "schedule"
      : runtime?.surface === "task" || runtime?.source === "task"
        ? "task"
        : "loop";
  return createToolInvocationContext({
    requestId: runtime?.requestId ?? id,
    runId: input.loopRunId ?? runtime?.runId ?? id,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(runtime?.user ?? input.user ? { user: runtime?.user ?? input.user } : {}),
    metadata: (runtime?.metadata ?? input.requestMetadata ?? {}) as Record<
      string,
      ToolInvocationJsonValue
    >,
    ...(runtime?.scope ? { scope: runtime.scope } : {}),
    surface,
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
  resumeRun?: LoopRunRecord;
  executionRoute?: ResolvedExecutionRoute;
  activatedSkills?: readonly string[];
  deliveryRunId?: string;
  parallelToolCalls?: boolean;
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
  const initialContext: ContextBag = resumeState?.context ?? {
    request: {
      metadata: { ...(options.requestMetadata ?? {}) },
    },
  };
  const loopRunId = resumeRun?.id ?? (loopRunStore ? `looprun-${nanoid(16)}` : undefined);
  const toolInvocation = providedToolInvocation ?? projectLoopToolInvocation({
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
    );
  } catch (error) {
    await toolRunScope?.cleanup?.().catch(() => {});
    throw error;
  }
  const cleanupToolRun = async () => {
    await rootTools.cleanup?.().catch(() => {});
    await toolRunScope?.cleanup?.().catch(() => {});
  };
  const deterministicTools = rootTools.runtimeTools ?? rootTools.tools;
  const executeLoopTool = createGuardedCompletionToolExecutor({
    executor: rootTools.runtimeExecutor ?? rootTools.executor,
    tools: deterministicTools,
    middleware: deps.runToolMiddleware,
    context: {
      planId: options.runtimePlan?.id,
      surface: options.runtimePlan?.surface,
      source: "loop-step",
      agent: agentConfig.name,
      runId: loopRunId,
      sessionId: sessionId ?? undefined,
    },
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
    await loopRunStore.updateRun(loopRunId, {
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
    }).catch(async (error) => {
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
  let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  let lastModel = initialModel;
  let lastResolvedModel: CompletionResolvedModelInfo | undefined;
  let lastProviderMetadata: Record<string, unknown> | undefined;
  const toolCallsAccum: any[] = [];
  const events: LoopTraceEvent[] = [];

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
        approvedGates: resumeState.approvedGates,
      } : undefined,
      onTrace: async (event) => {
        await emitTrace(event);
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
      runLoop: async (name, loop, context) => {
        const id = `loop-step-${nanoid(12)}`;
        await onToolCall?.({
          id,
          name: `loop:${name}`,
          arguments: { loop: projectLoop.name, step: name },
          state: "calling",
        });
        const stepAgent = buildLoopStepAgent(agentConfig, name, loop);
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
        const stepResult = await runAgentStepCompletion({
          deps,
          agentConfig: stepAgent,
          aiMessages,
          extraSystemParts,
          context,
          stepName: name,
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
          parallelToolCalls: options.parallelToolCalls,
        });
        finalText = stepResult.text || finalText;
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

    if (!finalText) finalText = JSON.stringify(loopUserVisibleContext(result.context), null, 2);
    if (loopRunStore && loopRunId) {
      await loopRunStore.updateRun(loopRunId, {
        status: "completed",
        context: result.context,
        trace: resumeRun ? [...resumeRun.trace, ...result.events] : result.events,
        resume: undefined,
        approval: resumeRun?.approval ? { ...resumeRun.approval, status: "approved" } : undefined,
        completedAt: new Date().toISOString(),
      });
    }
    return {
      text: finalText,
      usage: totalUsage,
      model: lastModel,
      resolvedModel: lastResolvedModel,
      providerMetadata: lastProviderMetadata,
      toolCalls: toolCallsAccum,
      context: result.context,
      trace: result.events,
      loopRunId,
    };
  } catch (err) {
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
        await loopRunStore.updateRun(loopRunId, {
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
          ),
          error: err.message,
        });
      } else {
        await loopRunStore.updateRun(loopRunId, {
          status: "failed",
          trace: resumeRun ? [...resumeRun.trace, ...events] : events,
          error: err instanceof Error ? err.message : String(err),
          completedAt: new Date().toISOString(),
        });
      }
    }
    throw err;
  } finally {
    await cleanupToolRun();
  }
}

export function buildLoopResumeState(
  continuation: { context: ContextBag; steps: any[]; previousNode?: string } | undefined,
  aiMessages: any[],
  extraSystemParts: string[],
  approvedGates: LoopApprovedGate[] | undefined,
  contextTrust: RuntimeContextTrustMode = "off",
  activatedSkills: readonly string[] = [],
  parallelToolCalls?: boolean,
): LoopResumeState | undefined {
  if (!continuation) return undefined;
  return {
    context: continuation.context,
    steps: continuation.steps,
    previousNode: continuation.previousNode,
    approvedGates: approvedGates ?? [],
    runtime: {
      aiMessages,
      extraSystemParts,
      ...(contextTrust === "enforce" ? { contextTrust } : {}),
      ...(activatedSkills.length > 0
        ? { activatedSkills: [...activatedSkills] }
        : {}),
      ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
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

  const agents = await options.deps.getAgents();
  const agentConfig = agents.find((agent: any) => agent.name === run.agentName);
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
  const toolInvocation = resolvedToolInvocation
    ? createToolInvocationContext({
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
  body: {
    stream?: boolean;
    agent?: string;
    user?: string;
    metadata?: Record<string, string>;
    parallel_tool_calls?: boolean;
  };
  completionId: string;
  agentConfig: any;
  projectLoop: ProjectLoopConfig;
  aiMessages: any[];
  extraSystemParts: string[];
  contextTrust?: RuntimeContextTrustMode;
  runtimeContext?: RuntimeContextResolution;
  runtimeInvocation?: CompletionRuntimeInvocation;
  sessionStore: any;
  sessionId: string | null;
  runtimePlan?: RuntimePlan;
  executionRoute?: ResolvedExecutionRoute;
  activatedSkills?: readonly string[];
}

export async function handleProjectLoopCompletion(
  c: any,
  options: ProjectLoopCompletionOptions,
): Promise<any> {
  if (options.body.stream) {
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
          options,
          abortController.signal,
        );
      } finally {
        clearInterval(heartbeatInterval);
      }
    }) as any;
  }

  return runNonStreamingProjectLoopCompletion(c, options);
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

      let assistantMsgId: string | null = null;
      let finalText = "";
      let runUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
      let runModel = agentConfigForModelPrimary(
        agentConfig,
        deps.getConfig()?.settings,
      ).model ?? "polpo";
      let resolvedModel: CompletionResolvedModelInfo | undefined;
      let providerMetadata: Record<string, unknown> | undefined;
      let toolCalls: any[] = [];
      const outputMode = streamingOutputPolicyMode(deps.runOutputPolicy);

      try {
        await stream.writeSSE({ data: sseChunk(completionId, { role: "assistant" }) });
        if (sessionStore && sessionId) {
          const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
          assistantMsgId = placeholder.id;
        }

        const run = await runProjectLoopCompletion({
          deps,
          agentConfig,
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
        });
        finalText = run.text;
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
        if (!signal.aborted) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { loop_run_id: run.loopRunId }) });
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
        throw err;
      } finally {
        await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCalls);
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
  try {
    if (sessionStore && sessionId) {
      const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
      assistantMsgId = placeholder.id;
    }
    const run = await runProjectLoopCompletion({
      deps,
      agentConfig,
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
    });
    finalText = run.text;
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
    return c.json(completionResponse(completionId, finalText, runUsage, { loop_trace: run.trace, loop_run_id: run.loopRunId }));
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
        || loopError.code === "loop_tool_input_invalid";
      return c.json({ error: loopError }, (invalidInput ? 400 : 403) as any);
    }
    throw err;
  } finally {
    await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCalls);
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
  }
}
