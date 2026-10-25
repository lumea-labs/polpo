import type { CompletionToolExecutor } from "./tool-guardrails.js";
/**
 * Single agent-step execution for the loop runtimes.
 *
 * Runs one agent step (multi-turn streamed model tool loop) with the
 * step's overlay-merged agent config — used by the project loop runtime
 * to execute `loop:` steps inside a deterministic pipeline.
 */

import {
  agentMemoryScope,
  compactIfNeeded,
  createRuntimePromptContextSegment,
  loopContextPrompt,
  loopAgentInputPrompt,
  loopUserVisibleContext,
  type PreparedLoopAgentInput,
  maybeParseJson,
  normalizeRuntimeContextTrustMode,
  protectRuntimeToolResultMessages,
  renderRuntimePromptContextSegment,
  renderRuntimeToolResult,
  renderRuntimeContextPrompt,
  replacesLegacyAgentMemory,
  replacesLegacySharedMemory,
  type ContextBag,
  type ModelSelection,
  type RuntimeContextResolution,
  resolveConfiguredModelSelection,
  type PolpoSettings,
  type RuntimePlan,
  type ToolInvocationContext,
  type SummarizeFn,
  type RuntimeContextTrustMode,
  type ResolvedAllowedToolPolicy,
  isClientInteractionToolName,
  LoopInteractiveToolUnsupportedError,
  LoopAgentOutputError,
  ToolProgressTracker,
  prepareLoopAgentOutput,
  assertToolNameAllowedByPolicy,
} from "@polpo-ai/core";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";
import { TerminationGate, TerminationGateError, type TerminationGateState } from "@polpo-ai/core/runtime-hooks";
import type { ModelMessage, UserContent } from "ai";
import type {
  ResolvedSteeringPolicy,
  SteeringController,
  SteeringMessage,
} from "@polpo-ai/core/steering";
import {
  classifyRuntimeError,
  prepareModelMessagesForProvider,
  prepareModelMessagesForTransport,
  isStructuredModelOutputError,
  modelOutputForJsonSchema,
  runModelPolicyTurn,
} from "@polpo-ai/llm";
import type {
  CompletionRouteDeps,
  CompletionToolRunScope,
} from "../completions.js";
import { CompletionModelInvocationLedger, type CompletionModelInvocation } from "./model-invocations.js";
import { appendModelResponseMessages } from "./message-mapping.js";
import {
  appendReasoningSummary,
  emitFileChanged,
  indexToolResultsByCallId,
  invalidModelToolCallEvent,
  isInvalidModelToolCall,
  invalidToolBatchEntries,
  inToolCallOrder,
  type ToolBatchEntry,
  providerToolCallEvent,
  toAITools,
  toAIToolChoice,
  type LoopRuntimeToolCall,
} from "./tool-mapping.js";
import { createGuardedCompletionToolExecutor } from "./tool-guardrails.js";
import { assertModelPreflightValue } from "./preflight-validation.js";
import {
  MODEL_CONTROLLED_TOOL_PROMPT,
  createModelControlledToolPool,
  forcedModelToolName,
  resolveToolLoadingDecision,
} from "./tool-disclosure.js";
import {
  executeCompletionToolCall,
  executeCompletionToolBatch,
} from "./tool-execution-batch.js";
import {
  createPolicyGuardedToolExecutor,
  filterToolDefinitionsByPolicy,
  filterToolRecordByPolicy,
  toolPolicyAuditData,
} from "./tool-policy-runtime.js";
import {
  RuntimeHookPromptBlockedError,
  RuntimeHookStopError,
  createRuntimeHookedToolExecutor,
  dispatchCompletionModelPolicyHook,
  hookContextMessage,
  hookContextSection,
  latestUserPrompt,
  runPostCompactHooks,
  runPostToolBatchHooks,
  runPreCompactHooks,
  runSessionEndHooks,
  runSessionStartHooks,
  runStopFailureHooks,
  runUserPromptSubmitHooks,
  type CompletionRuntimeHookContext,
} from "./runtime-hooks.js";

export const MAX_TURNS = 20;

const CONTEXT_ONLY_STEP_INSTRUCTION =
  "Execute the current loop step using the deterministic loop context provided in the system instructions.";

export class LoopAgentStepPromptRequiredError extends Error {
  readonly code = "loop_agent_step_prompt_required";

  constructor(readonly stepName: string) {
    super(`Loop agent step "${stepName}" has neither model messages nor deterministic context`);
    this.name = "LoopAgentStepPromptRequiredError";
  }
}

/**
 * Minimal model info needed by the completions route.
 * Matches the shape returned by resolveAgentModel.
 */
export interface ResolvedModelInfo {
  /** Model identifier (e.g. "claude-sonnet-4.5") — optional for backwards compat. */
  id?: string;
  /** Human-facing model name/slug when distinct from id. */
  name?: string;
  aiModel: LanguageModel;
  provider: string;
  /** Runtime used to construct the AI SDK model. */
  runtimeMode?: "provider" | "gateway";
  contextWindow: number;
  maxTokens: number;
  /** Capability proof for the concrete provider/model/adapter/endpoint. */
  capabilities?: import("@polpo-ai/llm").ModelRuntimeCapabilities;
}

export interface CompletionResolvedModelInfo {
  id?: string;
  name?: string;
  provider: string;
  runtimeMode?: "provider" | "gateway";
}

export interface AgentStepRunResult {
  text: string;
  reasoning: string;
  output: unknown;
  usage: LanguageModelUsage;
  model: string;
  resolvedModel?: CompletionResolvedModelInfo;
  /** Metadata of the step's last model call; use `invocations` for billing. */
  providerMetadata?: Record<string, unknown>;
  /** Every provider call this step made in this process (never replayed from a checkpoint). */
  invocations: CompletionModelInvocation[];
  toolCalls: any[];
}

export interface AgentStepCheckpoint {
  version: 1;
  step: string;
  invocationId: string;
  configuration: string;
  systemPrompt: string;
  nextTurn: number;
  phase: "operational" | "in_flight" | "validating" | "accepted";
  history: any[];
  text: string;
  reasoning: string;
  output?: unknown;
  structured: boolean;
  usage: LanguageModelUsage;
  toolCalls: any[];
  terminationGate: TerminationGateState;
  /** Consecutive Stop-hook continuations, restored so the cap survives a resume. */
  stopHooks?: { consecutiveStopContinuations: number; stopHookActive?: boolean };
}

function steeringModelMessage(message: SteeringMessage): ModelMessage {
  const content: UserContent = [];
  if (message.content.text !== undefined) content.push({ type: "text", text: message.content.text });
  for (const attachment of message.content.attachments ?? []) {
    const url = new URL(attachment.url);
    if (attachment.type === "image") {
      content.push({ type: "image", image: url, ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}) });
    } else {
      content.push({
        type: "file",
        data: url,
        mediaType: attachment.mediaType ?? (attachment.type === "audio" ? "audio/mpeg" : "application/octet-stream"),
        ...(attachment.name ? { filename: attachment.name } : {}),
      });
    }
  }
  return { role: "user", content };
}

export function completionResolvedModelInfo(model: ResolvedModelInfo): CompletionResolvedModelInfo {
  return {
    ...(model.id ? { id: model.id } : {}),
    ...(model.name ? { name: model.name } : {}),
    provider: model.provider,
    ...(model.runtimeMode ? { runtimeMode: model.runtimeMode } : {}),
  };
}

export function modelSelectionForResolvedModel(model: ResolvedModelInfo): string {
  const modelId = model.id ?? model.name;
  return modelId ? `${model.provider}/${modelId}` : model.provider;
}

export function resolveAgentModelSelection(
  agentConfig: any,
  settings: Partial<PolpoSettings> | undefined,
): ModelSelection | undefined {
  if (!agentConfig?.model) return undefined;
  return resolveConfiguredModelSelection(
    agentConfig.model,
    settings ?? {},
    agentConfig.allowedModelProfiles,
  ).selection;
}

export function modelSelectionForAgent(
  agentConfig: any,
  fallback: string,
  settings?: Partial<PolpoSettings>,
): ModelSelection {
  return resolveAgentModelSelection(agentConfig, settings) ?? fallback;
}

export function agentConfigForModelPrimary(
  agentConfig: any,
  settings?: Partial<PolpoSettings>,
): any {
  const selection = resolveAgentModelSelection(agentConfig, settings);
  if (!selection) return agentConfig;
  return {
    ...agentConfig,
    model: typeof selection === "string" ? selection : selection.primary,
  };
}

export function agentConfigForModelAttempt(agentConfig: any, model: string): any {
  return {
    ...agentConfig,
    model,
  };
}

export function addUsage(a: LanguageModelUsage, b: LanguageModelUsage): LanguageModelUsage {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
  } as LanguageModelUsage;
}

/**
 * Build a SummarizeFn using AI SDK's generateText.
 * Used by context compaction to summarize conversation history.
 */
export function buildSummarizeFn(
  m: ResolvedModelInfo,
  providerOptions?: Record<string, any>,
  budget?: {
    gate?: TerminationGate;
    signal?: AbortSignal;
    onUsage?: (usage: LanguageModelUsage) => void;
    invocations?: CompletionModelInvocationLedger;
  },
): SummarizeFn {
  return async (msgs: any[], prompt: string): Promise<string> => {
    budget?.gate?.assertAvailable();
    const result = await generateText({
      model: m.aiModel,
      system: prompt,
      messages: prepareModelMessagesForTransport(msgs, m.aiModel),
      providerOptions,
      ...(budget?.gate ? { maxOutputTokens: Math.min(m.maxTokens, budget.gate.remainingTokens) } : {}),
      ...(budget?.signal ? { abortSignal: budget.signal } : {}),
    });
    budget?.gate?.recordUsage(result.usage);
    budget?.onUsage?.(result.usage);
    budget?.invocations?.record("compaction", result, m.id ?? m.provider);
    return result.text.trim();
  };
}

export async function buildRuntimeAgentPrompt(
  deps: CompletionRouteDeps,
  agentConfig: any,
  extraSystemParts: string[],
  loopContextPart?: string,
  contextTrust: RuntimeContextTrustMode = "off",
  runtimeContext?: RuntimeContextResolution,
  activatedSkills: readonly string[] = [],
  isolateModelContext = false,
): Promise<string> {
  let fullSystemPrompt: string;
  if (deps.buildRuntimePrompt) {
    fullSystemPrompt = await deps.buildRuntimePrompt(agentConfig, {
      mode: "loop-step",
      extraSystemParts,
      loopContextPart,
      includeAgentMemory: !isolateModelContext && !replacesLegacyAgentMemory(runtimeContext),
      includeSharedMemory: !isolateModelContext && !replacesLegacySharedMemory(runtimeContext),
      ...(activatedSkills.length > 0 ? { activatedSkills } : {}),
    });
  } else {
    const agentSystemPrompt = await deps.buildAgentPrompt(
      agentConfig,
      activatedSkills.length > 0 ? { activatedSkills } : undefined,
    );
    const conversationalPreamble = isolateModelContext ? "" : [
      "You are now in interactive conversation mode with the user.",
      "Unlike task execution, you should engage in dialogue: ask clarifying questions,",
      "explain your reasoning, and wait for user input when needed.",
      "You still have access to all your coding tools to help the user.",
    ].join("\n");

    fullSystemPrompt = conversationalPreamble
      ? `${conversationalPreamble}\n\n${agentSystemPrompt}`
      : agentSystemPrompt;
    if (extraSystemParts.length > 0) {
      fullSystemPrompt += `\n\n## Additional context from caller\n\n${extraSystemParts.join("\n\n")}`;
    }
    if (loopContextPart) {
      fullSystemPrompt += `\n\n${loopContextPart}`;
    }

    if (!isolateModelContext && !replacesLegacyAgentMemory(runtimeContext)) {
      const memoryStore = deps.getMemoryStore();
      const agentMemory = await memoryStore?.get(agentMemoryScope(agentConfig.name));
      if (agentMemory) {
        fullSystemPrompt += contextTrust === "enforce"
          ? `\n\n${renderRuntimePromptContextSegment(createRuntimePromptContextSegment({
              kind: "memory.agent",
              sourceId: agentConfig.name,
              trust: "untrusted",
              content: agentMemory,
            }))}`
          : `\n\n## Your persistent memory\n\n${agentMemory}`;
      }
    }
  }
  const runtimeContextPrompt = isolateModelContext
    ? ""
    : renderRuntimeContextPrompt(runtimeContext);
  if (runtimeContextPrompt) {
    fullSystemPrompt += `\n\n${runtimeContextPrompt}`;
  }
  return fullSystemPrompt;
}

export async function runAgentStepCompletion(options: {
  deps: CompletionRouteDeps;
  agentConfig: any;
  aiMessages: any[];
  extraSystemParts: string[];
  context: Readonly<ContextBag>;
  stepName: string;
  contextTrust?: RuntimeContextTrustMode;
  runtimePlan?: RuntimePlan;
  signal?: AbortSignal;
  runId?: string;
  sessionId?: string;
  runtimeContext?: RuntimeContextResolution;
  activatedSkills?: readonly string[];
  toolRunScope?: CompletionToolRunScope;
  toolInvocation?: ToolInvocationContext;
  onToolCall?: (toolCall: LoopRuntimeToolCall) => Promise<void>;
  onReasoning?: (text: string) => Promise<void>;
  parallelToolCalls?: boolean;
  toolPolicy?: ResolvedAllowedToolPolicy;
  projectedInput?: PreparedLoopAgentInput;
  /** JSON Schema enforced on the terminal, non-tool model turn. */
  outputSchema?: unknown;
  steering?: SteeringController;
  steeringPolicy?: ResolvedSteeringPolicy;
  loopName?: string;
  resume?: AgentStepCheckpoint;
  checkpointAvailable?: boolean;
  onCheckpoint?: (checkpoint: AgentStepCheckpoint) => Promise<void>;
  /** Shared per-completion ledger; provider calls are recorded even if the step throws. */
  invocations?: CompletionModelInvocationLedger;
}): Promise<AgentStepRunResult> {
  const {
    deps,
    agentConfig,
    aiMessages,
    extraSystemParts,
    context,
    stepName,
    runtimeContext,
    onToolCall,
  } = options;
  let runtimeHookToolExecutor: CompletionToolExecutor | undefined;
  const callerSignal = options.signal;
  const configuration = JSON.stringify({ agentConfig, outputSchema: options.outputSchema, toolPolicy: options.toolPolicy });
  const invocationId = options.resume?.invocationId ?? `gate-${crypto.randomUUID()}`;
  const hookRuntime = await deps.resolveRuntimeHooks?.({
    agentConfig,
    surface: "loop",
    runId: options.runId,
    sessionId: options.sessionId,
    step: stepName,
    loop: options.loopName,
    activatedSkills: options.activatedSkills,
    toolRunScope: options.toolRunScope,
    getToolExecutor: () => runtimeHookToolExecutor,
    turnId: invocationId,
  });
  const runtimeHooks: CompletionRuntimeHookContext | undefined = hookRuntime
    ? { runtime: hookRuntime, surface: "loop" }
    : undefined;
  const stopHooks = Boolean(runtimeHooks?.runtime.has("Stop"));
  if (options.resume && (!stopHooks || options.resume.version !== 1 || options.resume.step !== stepName)) {
    throw new TerminationGateError("termination_gate_checkpoint_invalid", "Agent checkpoint does not match this configured gate");
  }
  if (options.resume) {
    const r = options.resume;
    if (r.configuration !== configuration || typeof r.systemPrompt !== "string" || !r.invocationId || !Number.isSafeInteger(r.nextTurn) || r.nextTurn < 0 || !Array.isArray(r.history)
      || !Array.isArray(r.toolCalls) || !["operational", "validating", "accepted", "in_flight"].includes(r.phase)
      || typeof r.text !== "string" || typeof r.reasoning !== "string" || typeof r.structured !== "boolean"
      || !r.usage || (r.phase === "validating") !== Boolean(r.terminationGate?.pending)
      || (r.phase === "accepted") !== Boolean(r.terminationGate?.accepted)) {
      throw new TerminationGateError("termination_gate_checkpoint_invalid", "Invalid agent termination checkpoint");
    }
    if (r.phase === "in_flight") throw new TerminationGateError("termination_gate_effect_unconfirmed", "An interrupted model/tool operation may have committed effects; reconcile before retrying");
  }
  const gate = stopHooks ? new TerminationGate(runtimeHooks!.stopPolicy ?? {}, options.resume?.terminationGate) : undefined;
  if (stopHooks) runtimeHooks!.runtime.restoreStopState(options.resume?.stopHooks);
  if (gate) {
    if (options.checkpointAvailable === false) throw new TerminationGateError("termination_gate_parallel_unsupported", "Durable termination gates require a sequential agent step");
    if (options.resume?.phase !== "accepted") {
      gate.assertAvailable();
      if (Number.isFinite(gate.remainingMs)) {
        const deadline = AbortSignal.timeout(gate.remainingMs);
        options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline };
      }
    }
  }
  if (runtimeHooks) runtimeHooks.signal = options.signal;
  const settings = deps.getConfig()?.settings;
  const contextTrust = normalizeRuntimeContextTrustMode(
    options.contextTrust ?? settings?.contextTrust,
  );
  const reasoning = agentConfig.reasoning ?? settings?.reasoning;
  const visibleLoopContext = loopUserVisibleContext(context);
  const projectedInput = options.projectedInput;
  let fullSystemPrompt = await buildRuntimeAgentPrompt(
    deps,
    agentConfig,
    projectedInput ? [] : extraSystemParts,
    projectedInput
      ? ""
      : loopContextPrompt(
          stepName,
          visibleLoopContext,
          contextTrust,
        ),
    contextTrust,
    runtimeContext,
    options.activatedSkills,
    Boolean(projectedInput),
  );
  if (!options.resume && runtimeHooks) {
    // Each agent node is one headless invocation: SessionStart, then the
    // step input is the submitted prompt. A resumed checkpoint already holds
    // the prompt and context it was started with.
    const sessionContext = await runSessionStartHooks(runtimeHooks, "startup");
    const promptContext = await runUserPromptSubmitHooks(
      runtimeHooks,
      projectedInput ? loopAgentInputPrompt(stepName, projectedInput) : latestUserPrompt(aiMessages),
    );
    fullSystemPrompt += hookContextSection("SessionStart", sessionContext) + hookContextSection("UserPromptSubmit", promptContext);
  }
  if (options.resume) fullSystemPrompt = options.resume.systemPrompt;
  let messages: any[] = projectedInput
    ? [{ role: "user", content: loopAgentInputPrompt(stepName, projectedInput) }]
    : contextTrust === "enforce"
      ? protectRuntimeToolResultMessages(aiMessages)
      : [...aiMessages];
  if (
    prepareModelMessagesForProvider(messages).length === 0
    && Object.keys(visibleLoopContext).length > 0
  ) {
    messages = [{ role: "user", content: CONTEXT_ONLY_STEP_INSTRUCTION }];
  }
  if (deps.runPreflightPolicy) {
    const guarded = await deps.runPreflightPolicy.evaluate({
      phase: "model.preflight",
      value: {
        systemPrompt: fullSystemPrompt,
        messages,
        ...(runtimeContext ? { runtimeContext } : {}),
      },
      mode: deps.runPreflightPolicyMode ?? "enforce",
      context: {
        planId: options.runtimePlan?.id,
        surface: options.runtimePlan?.surface ?? "agent",
        source: "loop-step",
        agent: agentConfig.name,
        runId: options.runId,
        sessionId: options.sessionId,
      },
      signal: options.signal,
    });
    assertModelPreflightValue(guarded.value, guarded.decisions);
    fullSystemPrompt = guarded.value.systemPrompt;
    messages = guarded.value.messages;
  }
  if (prepareModelMessagesForProvider(messages).length === 0) {
    throw new LoopAgentStepPromptRequiredError(stepName);
  }
  const initialResolved = await deps.resolveAgentModel(
    agentConfigForModelPrimary(agentConfig, settings),
    reasoning,
  );
  let m = initialResolved.model;
  let providerOpts = initialResolved.providerOptions;
  const modelSelection = modelSelectionForAgent(
    agentConfig,
    modelSelectionForResolvedModel(m),
    settings,
  );
  const resolvedTools = await deps.resolveAgentTools(
    agentConfig,
    options.toolRunScope,
    options.toolInvocation,
    options.signal,
  );
  const forcedTool = agentConfig.toolChoice
    && typeof agentConfig.toolChoice === "object"
    && agentConfig.toolChoice.mode === "required"
    ? agentConfig.toolChoice.tool
    : undefined;
  if (isClientInteractionToolName(forcedTool)) {
    throw new LoopInteractiveToolUnsupportedError(forcedTool, stepName);
  }
  if (forcedTool && options.toolPolicy) {
    assertToolNameAllowedByPolicy(forcedTool, options.toolPolicy);
  }
  if (options.toolPolicy) {
    deps.emit("runtime:tool-policy", toolPolicyAuditData({
      policy: options.toolPolicy,
      requested: [
        ...resolvedTools.tools
          .map((tool) => tool?.name)
          .filter((name): name is string => typeof name === "string"),
        ...Object.keys(resolvedTools.extraAiTools ?? {}),
      ],
      mode: "loop",
    }));
  }
  const policyTools = options.toolPolicy
    ? filterToolDefinitionsByPolicy(resolvedTools.tools, options.toolPolicy)
    : resolvedTools.tools;
  const loopTools = policyTools.filter(
    (tool) => !isClientInteractionToolName(tool?.name),
  );
  const policyExtraAiTools = options.toolPolicy
    ? filterToolRecordByPolicy(resolvedTools.extraAiTools, options.toolPolicy)
    : resolvedTools.extraAiTools ?? {};
  const loopExtraAiTools = Object.fromEntries(
    Object.entries(policyExtraAiTools).filter(
      ([name]) => !isClientInteractionToolName(name),
    ),
  );
  const policyExecutor = options.toolPolicy
    ? createPolicyGuardedToolExecutor(resolvedTools.executor, options.toolPolicy)
    : resolvedTools.executor;
  runtimeHookToolExecutor = createGuardedCompletionToolExecutor({
      executor: policyExecutor,
      tools: loopTools,
      middleware: deps.runToolMiddleware,
      context: {
        planId: options.runtimePlan?.id,
        surface: options.runtimePlan?.surface,
        source: "loop-step",
        agent: agentConfig.name,
        runId: options.runId,
        sessionId: options.sessionId,
      },
      receiptStore: options.toolRunScope?.receiptStore,
  });
  let executeTool = createRuntimeHookedToolExecutor({ hooks: runtimeHooks, executor: runtimeHookToolExecutor });
  const progressTracker = new ToolProgressTracker();
  const toolAnnotations = new Map(
    loopTools
      .filter((tool) => tool && typeof tool.name === "string")
      .map((tool) => [tool.name, tool.annotations]),
  );
  let stalledToolLoop:
    | { toolName: string; fingerprint: string; observation: number; message: string }
    | undefined;
  const guardedExecuteTool = executeTool;
  executeTool = async (name, args, execution) => {
    const call = {
      name,
      args,
      annotations: toolAnnotations.get(name),
    };
    const progress = progressTracker.inspect(call);
    if (progress.action === "reuse") {
      deps.emit("runtime:tool-progress", {
        action: "reuse",
        tool: name,
        fingerprint: progress.fingerprint,
        observation: progress.observation,
        step: stepName,
        agent: agentConfig.name,
        runId: options.runId,
        sessionId: options.sessionId,
      });
      return progress.result;
    }
    if (progress.action === "stall") {
      stalledToolLoop = {
        toolName: name,
        fingerprint: progress.fingerprint,
        observation: progress.observation,
        message: progress.message,
      };
      deps.emit("runtime:tool-progress", {
        action: "stall",
        code: progress.code,
        tool: name,
        fingerprint: progress.fingerprint,
        observation: progress.observation,
        step: stepName,
        agent: agentConfig.name,
        runId: options.runId,
        sessionId: options.sessionId,
      });
      return `Error: ${progress.message}`;
    }
    const result = await guardedExecuteTool(name, args, execution);
    progressTracker.record({
      ...call,
      result,
      isError: result.startsWith("Error:"),
    });
    return result;
  };
  const modelToolChoice = toAIToolChoice(agentConfig.toolChoice);
  let modelTools = loopTools;
  let activeToolNames: (() => string[]) | undefined;
  let activeCompactionTools: (() => any[]) | undefined;
  const toolLoadingDecision = resolveToolLoadingDecision(
    resolvedTools.disclosure,
    modelTools,
  );
  deps.emit("runtime:tool-loading", {
    ...toolLoadingDecision,
    mode: "loop",
    source: "loop-step",
    agent: agentConfig.name,
    runId: options.runId,
    sessionId: options.sessionId,
  });
  if (toolLoadingDecision.effectiveMode === "progressive") {
    const configuredInitial = [...(resolvedTools.disclosure?.initiallyLoaded ?? [])];
    const forcedTool = forcedModelToolName(modelToolChoice);
    if (forcedTool && modelTools.some((tool) => tool?.name === forcedTool)) {
      configuredInitial.push(forcedTool);
    }
    const pool = createModelControlledToolPool({
      tools: modelTools,
      executor: executeTool,
      initiallyLoaded: [...new Set(configuredInitial)],
      maxLoadedTools: resolvedTools.disclosure?.maxLoadedTools,
      maxLoadBatch: resolvedTools.disclosure?.maxLoadBatch,
      maxSearchResults: resolvedTools.disclosure?.maxSearchResults,
    });
    const providerToolNames = Object.keys(loopExtraAiTools);
    modelTools = pool.tools;
    executeTool = pool.executor;
    activeToolNames = () => [...new Set([
      ...pool.startModelTurn(),
      ...providerToolNames,
    ])];
    activeCompactionTools = pool.activeTools;
    fullSystemPrompt = `${fullSystemPrompt}\n\n${MODEL_CONTROLLED_TOOL_PROMPT}`;
  }
  const aiTools = {
    ...toAITools(modelTools),
    ...loopExtraAiTools,
  };
  const providerToolNames = new Set(Object.keys(loopExtraAiTools));
  const outputSchema = options.outputSchema;
  const modelOutput = outputSchema !== undefined
    ? modelOutputForJsonSchema(outputSchema, `loop_${stepName}_output`)
    : undefined;
  let finalText = "";
  let haltedByHook: string | undefined;
  let finalReasoning = "";
  let finalOutput: unknown;
  let completedStructuredOutput = false;
  let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  let lastProviderMetadata: Record<string, unknown> | undefined;
  // Step-local ledger (mirrored into the completion's ledger). Resumed
  // checkpoints carry token totals but never invocations, so only calls made
  // by this process are reported and earlier calls are never billed twice.
  const invocations = new CompletionModelInvocationLedger(options.invocations);
  const toolCallsAccum: any[] = [];
  const maxTurns = agentConfig.maxTurns ?? MAX_TURNS;
  let nextTurn = options.resume?.nextTurn ?? 0;
  let gatePhase: AgentStepCheckpoint["phase"] = options.resume?.phase ?? "operational";
  if (options.resume) {
    messages = structuredClone(options.resume.history);
    finalText = options.resume.text;
    finalReasoning = options.resume.reasoning;
    finalOutput = options.resume.output;
    completedStructuredOutput = options.resume.structured;
    totalUsage = options.resume.usage;
    toolCallsAccum.push(...options.resume.toolCalls);
  }
  const checkpoint = async () => {
    if (!gate || !options.onCheckpoint) return;
    // A failed durable write must stop before starting another repair/model call.
    await options.onCheckpoint(structuredClone({ version: 1, step: stepName, invocationId, configuration, systemPrompt: fullSystemPrompt, nextTurn,
      phase: gatePhase, history: messages, text: finalText, reasoning: finalReasoning,
      output: finalOutput, structured: completedStructuredOutput, usage: totalUsage,
      toolCalls: toolCallsAccum, terminationGate: gate.snapshot(), stopHooks: runtimeHooks!.runtime.stopState() }));
  };
  if (options.steering) {
    await options.steering.configure(options.steeringPolicy ?? {
      acceptance: "best_effort",
      source: "platform",
    });
  }
  const deliverSteering = async (includeFollowUps: boolean): Promise<SteeringMessage[]> => {
    if (!options.steering) return [];
    const steeringMessages = await options.steering.drain({ includeFollowUps });
    if (steeringMessages.length === 0) return [];
    try {
      messages.push(...steeringMessages.map(steeringModelMessage));
      await options.steering.settle(steeringMessages.map((message) => message.id), "delivered");
      return steeringMessages;
    } catch (error) {
      await options.steering.settle(
        steeringMessages.map((message) => message.id),
        "failed",
        "model_message_adapter_failed",
      );
      throw error;
    }
  };

  const terminalMessages = (isRecovery: boolean) => [
    ...messages,
    {
      role: "user" as const,
      content: isRecovery
        ? "The previous terminal response did not satisfy the required output schema. All operational work is already complete. Return only the terminal result required by the configured schema, using the canonical conversation and tool results. Do not call tools, modify files, repeat side effects, reinterpret the requested scope, or claim work not evidenced by those results."
        : "Operational work is complete. Return only the terminal result required by the configured schema, using the canonical conversation and tool results. Do not call tools or repeat side effects.",
    },
  ];

  const completeTerminalStructuredOutput = async () => {
    if (modelOutput === undefined) return;

    let originalDiagnostic: ReturnType<typeof classifyRuntimeError> | undefined;
    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
      gate?.assertAvailable();
      options.signal?.throwIfAborted();
      const isRecovery = attemptIndex === 1;
      if (isRecovery) {
        const { raw: _raw, ...original } = originalDiagnostic!;
        deps.emit("runtime:structured-output-recovery", {
          phase: "started",
          step: stepName,
          agent: agentConfig.name,
          runId: options.runId,
          sessionId: options.sessionId,
          original,
        });
      }

      const resolvedAttempts = new Map<number, typeof initialResolved>();
      try {
        const terminalResult = await runModelPolicyTurn({
          selection: modelSelection,
          resolveAttempt: async (attempt) => {
            const resolvedAttempt = attempt.index === 0
              ? initialResolved
              : await deps.resolveAgentModel(
                  agentConfigForModelAttempt(agentConfig, attempt.model),
                  reasoning,
                );
            resolvedAttempts.set(attempt.index, resolvedAttempt);
            return {
              model: resolvedAttempt.model.aiModel,
              maxOutputTokens: gate ? Math.min(resolvedAttempt.model.maxTokens, gate.remainingTokens) : resolvedAttempt.model.maxTokens,
              providerOptions: resolvedAttempt.providerOptions,
              capabilities: resolvedAttempt.model.capabilities,
            };
          },
          preserveSingleAttemptError: true,
          onPolicyEvent: (event) => {
            invocations.observePolicyEvent("terminal", event);
            return dispatchCompletionModelPolicyHook(runtimeHooks, event);
          },
          allowCommittedFallback: true,
          maxRecoverableStreamRetries: 0,
          system: fullSystemPrompt,
          messages: terminalMessages(isRecovery),
          output: modelOutput,
          ...(options.signal ? { abortSignal: options.signal } : {}),
          });
        gate?.recordUsage(terminalResult.usage);
        totalUsage = addUsage(totalUsage, terminalResult.usage);
        invocations.record("terminal", terminalResult);
        if (terminalResult.toolCalls.length > 0 || terminalResult.output === undefined) {
          throw new Error(
            terminalResult.toolCalls.length > 0
              ? "Terminal structured-output phase returned a tool call"
              : "Terminal structured-output phase completed without structured output",
          );
        }
        for (const warning of terminalResult.warnings ?? []) {
          deps.emit("runtime:model-warning", {
            source: "loop-step-terminal-output",
            step: stepName,
            agent: agentConfig.name,
            runId: options.runId,
            sessionId: options.sessionId,
            warning,
          });
        }

        const prepared = prepareLoopAgentOutput(
          stepName,
          terminalResult.output,
          outputSchema,
        );
        const selectedResolved = resolvedAttempts.get(terminalResult.selectedAttempt.index);
        if (selectedResolved) {
          m = selectedResolved.model;
          providerOpts = selectedResolved.providerOptions;
        }
        finalReasoning = appendReasoningSummary(finalReasoning, terminalResult.reasoning);
        lastProviderMetadata = terminalResult.providerMetadata as Record<string, unknown> | undefined;
        finalOutput = prepared.value;
        finalText = prepared.serialized;
        completedStructuredOutput = true;
        if (gate) await appendModelResponseMessages(messages, terminalResult, finalText, [], contextTrust);
        if (isRecovery) {
          deps.emit("runtime:structured-output-recovery", {
            phase: "succeeded",
            step: stepName,
            agent: agentConfig.name,
            runId: options.runId,
            sessionId: options.sessionId,
          });
        }
        return;
      } catch (error) {
        if (error instanceof TerminationGateError || options.signal?.aborted) throw error;
        const diagnostic = classifyRuntimeError(error);
        if (!isRecovery) {
          originalDiagnostic = diagnostic;
          continue;
        }

        const { raw: _originalRaw, ...original } = originalDiagnostic!;
        const { raw: _recoveryRaw, ...recovery } = diagnostic;
        deps.emit("runtime:structured-output-recovery", {
          phase: "failed",
          step: stepName,
          agent: agentConfig.name,
          runId: options.runId,
          sessionId: options.sessionId,
          original,
          recovery,
        });
        throw new LoopAgentOutputError(
          "loop_agent_output_invalid",
          stepName,
          `Agent step ${JSON.stringify(stepName)} did not produce valid structured output after one terminal recovery attempt`,
          {
            phase: "terminal_output_recovery",
            original,
            recovery,
          },
          { cause: error },
        );
      }
    }
  };

  try {
    if (gate) await checkpoint();
    gateLoop: while (true) {
      const hasOperationalTools = Object.keys(aiTools).length > 0;
      if (outputSchema !== undefined && !hasOperationalTools && gatePhase === "operational") {
        nextTurn += 1;
        if (gate) { gatePhase = "in_flight"; await checkpoint(); }
        await options.steering?.setBoundary({ open: false, reservable: false });
        await completeTerminalStructuredOutput();
      }

      for (
        ;
        gatePhase === "operational" && !completedStructuredOutput && nextTurn < maxTurns;
      ) {
        const turn = nextTurn++;
        if (gate) { gatePhase = "in_flight"; await checkpoint(); }
        gate?.assertAvailable();
        options.signal?.throwIfAborted();
        await options.steering?.setBoundary({ open: true, reservable: true });
        await deliverSteering(false);
        const compactionResult = await compactIfNeeded({
          systemPrompt: fullSystemPrompt,
          messages,
          tools: activeCompactionTools?.() ?? modelTools,
          config: {
            contextWindow: m.contextWindow ?? 200_000,
            maxOutputTokens: m.maxTokens ?? 8192,
          },
          summarize: buildSummarizeFn(m, providerOpts, { gate, signal: options.signal, invocations, onUsage: (usage) => { totalUsage = addUsage(totalUsage, usage); } }),
          mode: "chat",
          beforeCompact: () => runPreCompactHooks(runtimeHooks),
        });
        if (compactionResult.compacted) {
          const compacted = contextTrust === "enforce"
            ? protectRuntimeToolResultMessages(compactionResult.messages)
            : compactionResult.messages;
          messages.splice(0, messages.length, ...compacted);
          await runPostCompactHooks(runtimeHooks, compactionResult.summary);
        }

        const toolCallNames = new Map<string, string>();
        const resolvedAttempts = new Map<number, typeof initialResolved>();
        let turnResult;
        await options.steering?.setBoundary({
          open: true,
          reservable: turn + 1 < maxTurns,
        });
        try {
          turnResult = await runModelPolicyTurn({
            selection: modelSelection,
            resolveAttempt: async (attempt) => {
              const resolvedAttempt = attempt.index === 0
                ? initialResolved
                : await deps.resolveAgentModel(agentConfigForModelAttempt(agentConfig, attempt.model), reasoning);
              resolvedAttempts.set(attempt.index, resolvedAttempt);
              return {
                model: resolvedAttempt.model.aiModel,
                maxOutputTokens: gate ? Math.min(resolvedAttempt.model.maxTokens, gate.remainingTokens) : resolvedAttempt.model.maxTokens,
                providerOptions: resolvedAttempt.providerOptions,
                capabilities: resolvedAttempt.model.capabilities,
              };
            },
            preserveSingleAttemptError: true,
            onPolicyEvent: (event) => {
              invocations.observePolicyEvent("operational", event);
              return dispatchCompletionModelPolicyHook(runtimeHooks, event);
            },
            system: fullSystemPrompt,
            messages,
            tools: aiTools,
            ...(activeToolNames ? { activeTools: activeToolNames() } : {}),
            ...(modelToolChoice ? { toolChoice: modelToolChoice as any } : {}),
            ...(options.parallelToolCalls !== undefined
              ? { parallelToolCalls: options.parallelToolCalls }
              : {}),
            ...(options.signal ? { abortSignal: options.signal } : {}),
          }, async (event) => {
            if (event.type === "warning") {
              deps.emit("runtime:model-warning", {
                source: "loop-step",
                step: stepName,
                agent: agentConfig.name,
                runId: options.runId,
                sessionId: options.sessionId,
                warning: event.warning,
              });
            } else if (event.type === "tool-input-start") {
              toolCallNames.set(event.id, event.name);
              await onToolCall?.({
                id: event.id,
                name: event.name,
                state: "preparing",
              });
            } else if (event.type === "reasoning-delta") {
              await options.onReasoning?.(event.text);
            } else if (event.type === "tool-input-delta") {
              await onToolCall?.({
                id: event.id,
                name: toolCallNames.get(event.id) ?? "",
                state: "preparing",
                argumentsDelta: event.delta,
              });
            } else if (event.type === "tool-input-aborted") {
              toolCallNames.delete(event.id);
              await onToolCall?.({
                id: event.id,
                name: event.name,
                state: "interrupted",
                result: `Error: ${event.error.message ?? "Model stream interrupted during tool input"}`,
              });
            }
            });
        } catch (error) {
          if (outputSchema !== undefined && isStructuredModelOutputError(error)) {
            throw new LoopAgentOutputError(
              "loop_agent_output_invalid",
              stepName,
              `Agent step ${JSON.stringify(stepName)} failed during the operational phase`,
              { phase: "operational" },
              { cause: error },
            );
          } else {
            throw error;
          }
        }

        const turnText = turnResult.text;
        finalReasoning = appendReasoningSummary(finalReasoning, turnResult.reasoning);
        const selectedResolved = resolvedAttempts.get(turnResult.selectedAttempt.index);
        if (selectedResolved) {
          m = selectedResolved.model;
          providerOpts = selectedResolved.providerOptions;
        }
        totalUsage = addUsage(totalUsage, turnResult.usage);
        gate?.recordUsage(turnResult.usage);
        invocations.record("operational", turnResult);
        lastProviderMetadata = turnResult.providerMetadata as Record<string, unknown> | undefined;

        await appendModelResponseMessages(
          messages,
          turnResult,
          turnText,
          turnResult.toolCalls,
          contextTrust,
        );
        if (outputSchema === undefined) finalText += turnText;

        if (turnResult.toolCalls.length === 0) {
          const delivered = turn + 1 < maxTurns
            ? await deliverSteering(true)
            : [];
          if (delivered.length > 0) { gatePhase = "operational"; await checkpoint(); continue; }
          await options.steering?.setBoundary({ open: false, reservable: false });
          if (outputSchema !== undefined) {
            await completeTerminalStructuredOutput();
          }
          break;
        }

        const dispatchableToolCalls = turnResult.toolCalls.filter(
          (call) => !isInvalidModelToolCall(call),
        );
        for (const call of turnResult.toolCalls.filter(isInvalidModelToolCall)) {
          const event = invalidModelToolCallEvent(call);
          toolCallsAccum.push(event);
          await onToolCall?.(event);
        }
        if (dispatchableToolCalls.length === 0) {
          gatePhase = "operational";
          await checkpoint();
          const batch = await runPostToolBatchHooks(runtimeHooks, invalidToolBatchEntries(turnResult.toolCalls));
          if (batch.context.length) messages.push(hookContextMessage(batch.context));
          if (batch.stop !== undefined) {
            haltedByHook = batch.stop;
            break;
          }
          continue;
        }

        const providerToolResults = indexToolResultsByCallId(turnResult.toolResults as any[] | undefined);

        const batchCalls: ToolBatchEntry[] = invalidToolBatchEntries(turnResult.toolCalls);
        const appendLocalResult = async (
          call: { toolCallId: string; toolName: string },
          callArgs: Record<string, unknown>,
          result: string,
          isError: boolean,
        ) => {
          batchCalls.push({ name: call.toolName, input: callArgs, toolUseId: call.toolCallId, result });
          emitFileChanged(call.toolName, callArgs, result, deps.emit);
          const event = {
            id: call.toolCallId,
            name: call.toolName,
            arguments: callArgs,
            result,
            state: isError ? "error" : "completed",
          } satisfies LoopRuntimeToolCall;
          toolCallsAccum.push(event);
          await onToolCall?.(event);
          const modelResult = contextTrust === "enforce"
            ? renderRuntimeToolResult(call.toolName, call.toolCallId, result)
            : result;
          messages.push({
            role: "tool",
            content: [{
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: isError
                ? { type: "error-text" as const, value: modelResult }
                : { type: "text" as const, value: modelResult },
            }],
          });
        };

        if (options.parallelToolCalls === true) {
          const localCalls = dispatchableToolCalls
            .filter((call) => !providerToolNames.has(call.toolName))
            .map((call) => ({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input as Record<string, unknown>,
            }));
          const localResults = await executeCompletionToolBatch({
            calls: localCalls,
            executor: executeTool,
            signal: options.signal,
            onCalling: async (call) => {
              await onToolCall?.({
                id: call.toolCallId,
                name: call.toolName,
                arguments: call.input,
                state: "calling",
              });
            },
          });
          let localResultIndex = 0;
          for (const call of dispatchableToolCalls) {
            if (providerToolNames.has(call.toolName)) {
              const event = providerToolCallEvent(call, providerToolResults);
              toolCallsAccum.push(event);
              await onToolCall?.(event);
              continue;
            }
            const local = localResults[localResultIndex++]!;
            await appendLocalResult(call, local.input, local.result, local.isError);
          }
        } else {
          for (const call of dispatchableToolCalls) {
            const callArgs = call.input as Record<string, unknown>;
            if (providerToolNames.has(call.toolName)) {
              const event = providerToolCallEvent(call, providerToolResults);
              toolCallsAccum.push(event);
              await onToolCall?.(event);
              continue;
            }

            await onToolCall?.({
              id: call.toolCallId,
              name: call.toolName,
              arguments: callArgs,
              state: "calling",
            });
            const local = await executeCompletionToolCall({
              call: {
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: callArgs,
              },
              executor: executeTool,
              signal: options.signal,
            });
            await appendLocalResult(call, callArgs, local.result, local.isError);
          }
        }
        gatePhase = "operational";
        await checkpoint();
        if (stalledToolLoop) break;
        const batch = await runPostToolBatchHooks(runtimeHooks, inToolCallOrder(turnResult.toolCalls, batchCalls));
        if (batch.context.length) messages.push(hookContextMessage(batch.context));
        if (batch.stop !== undefined) {
          haltedByHook = batch.stop;
          break;
        }
      }

      await options.steering?.setBoundary({ open: false, reservable: false });

      if (stalledToolLoop) {
        throw new LoopAgentOutputError(
          "tool_loop_stalled",
          stepName,
          stalledToolLoop.message,
          {
            phase: "tool_progress",
            tool: stalledToolLoop.toolName,
            fingerprint: stalledToolLoop.fingerprint,
            observation: stalledToolLoop.observation,
          },
        );
      }

      if (
        outputSchema !== undefined
        && !completedStructuredOutput
        && toolCallsAccum.some((toolCall) => toolCall?.state === "completed")
      ) {
        await completeTerminalStructuredOutput();
      }

      if (outputSchema !== undefined && !completedStructuredOutput) {
        throw new LoopAgentOutputError(
          "loop_agent_output_invalid",
          stepName,
          `Agent step ${JSON.stringify(stepName)} exhausted maxTurns before producing structured output`,
          { phase: "max_turns" },
        );
      }

      if (gate && haltedByHook === undefined) {
        if (gatePhase === "accepted") break gateLoop;
        const attempt = gate.beginAttempt();
        gatePhase = "validating";
        await checkpoint();
        deps.emit("runtime:termination-gate", { runId: options.runId, sessionId: options.sessionId, step: stepName, attempt, phase: "validating" });
        const stop = await runtimeHooks!.runtime.stop(finalText, { attempt, ...(options.signal ? { signal: options.signal } : {}) });
        options.signal?.throwIfAborted();
        const feedback = gate.decide(stop.action === "continue" ? { action: "continue", feedback: stop.feedback! } : { action: "allow" }, maxTurns - nextTurn);
        if (feedback !== undefined) {
          messages.push({ role: "user", content: feedback });
          finalText = "";
          finalOutput = undefined;
          completedStructuredOutput = false;
          gatePhase = "operational";
          await checkpoint();
          deps.emit("runtime:termination-gate", { runId: options.runId, sessionId: options.sessionId, step: stepName, attempt, phase: "continuing" });
          continue gateLoop;
        }
        gatePhase = "accepted";
        await checkpoint();
        deps.emit("runtime:termination-gate", { runId: options.runId, sessionId: options.sessionId, step: stepName, attempt, phase: "accepted" });
        break gateLoop;
      }
      break gateLoop;
    }

    return {
      text: finalText,
      reasoning: finalReasoning,
      output: outputSchema !== undefined ? finalOutput : maybeParseJson(finalText),
      usage: options.resume ? {
        inputTokens: Math.max(0, (totalUsage.inputTokens ?? 0) - (options.resume.usage.inputTokens ?? 0)),
        outputTokens: Math.max(0, (totalUsage.outputTokens ?? 0) - (options.resume.usage.outputTokens ?? 0)),
        totalTokens: Math.max(0, (totalUsage.totalTokens ?? 0) - (options.resume.usage.totalTokens ?? 0)),
      } as LanguageModelUsage : totalUsage,
      model: m.id ?? m.provider,
      resolvedModel: completionResolvedModelInfo(m),
      providerMetadata: lastProviderMetadata,
      invocations: invocations.list(),
      toolCalls: toolCallsAccum,
    };
  } catch (error) {
    if (gate) deps.emit("runtime:termination-gate", { runId: options.runId, sessionId: options.sessionId, step: stepName, attempt: gate.snapshot().attempts, phase: "failed", code: error instanceof TerminationGateError ? error.code : "execution_failed" });
    if (!(error instanceof RuntimeHookPromptBlockedError) && !(error instanceof RuntimeHookStopError) && !callerSignal?.aborted) await runStopFailureHooks(runtimeHooks, error, finalText);
    if (gate && options.signal?.aborted && !callerSignal?.aborted) throw new TerminationGateError("termination_gate_time_exhausted", "Termination gate time limit exhausted");
    throw error;
  } finally {
    await options.steering?.setBoundary({ open: false, reservable: false });
    await runSessionEndHooks(runtimeHooks);
    if (resolvedTools.cleanup) {
      await resolvedTools.cleanup().catch(() => {});
    }
  }
}
