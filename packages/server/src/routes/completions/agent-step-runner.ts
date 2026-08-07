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
  loopUserVisibleContext,
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
  type SummarizeFn,
  type RuntimeContextTrustMode,
} from "@polpo-ai/core";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";
import { prepareModelMessagesForTransport, runModelPolicyTurn } from "@polpo-ai/llm";
import type {
  CompletionRouteDeps,
  CompletionToolRunScope,
} from "../completions.js";
import { appendModelResponseMessages } from "./message-mapping.js";
import {
  emitFileChanged,
  indexToolResultsByCallId,
  invalidModelToolCallEvent,
  isInvalidModelToolCall,
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
} from "./tool-disclosure.js";

export const MAX_TURNS = 20;

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
}

export interface CompletionResolvedModelInfo {
  id?: string;
  name?: string;
  provider: string;
  runtimeMode?: "provider" | "gateway";
}

export interface AgentStepRunResult {
  text: string;
  output: unknown;
  usage: LanguageModelUsage;
  model: string;
  resolvedModel?: CompletionResolvedModelInfo;
  providerMetadata?: Record<string, unknown>;
  toolCalls: any[];
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
): SummarizeFn {
  return async (msgs: any[], prompt: string): Promise<string> => {
    const result = await generateText({
      model: m.aiModel,
      system: prompt,
      messages: prepareModelMessagesForTransport(msgs, m.aiModel),
      providerOptions,
    });
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
): Promise<string> {
  let fullSystemPrompt: string;
  if (deps.buildRuntimePrompt) {
    fullSystemPrompt = await deps.buildRuntimePrompt(agentConfig, {
      mode: "loop-step",
      extraSystemParts,
      loopContextPart,
      includeAgentMemory: !replacesLegacyAgentMemory(runtimeContext),
      includeSharedMemory: !replacesLegacySharedMemory(runtimeContext),
    });
  } else {
    const agentSystemPrompt = await deps.buildAgentPrompt(agentConfig);
    const conversationalPreamble = [
      "You are now in interactive conversation mode with the user.",
      "Unlike task execution, you should engage in dialogue: ask clarifying questions,",
      "explain your reasoning, and wait for user input when needed.",
      "You still have access to all your coding tools to help the user.",
    ].join("\n");

    fullSystemPrompt = `${conversationalPreamble}\n\n${agentSystemPrompt}`;
    if (extraSystemParts.length > 0) {
      fullSystemPrompt += `\n\n## Additional context from caller\n\n${extraSystemParts.join("\n\n")}`;
    }
    if (loopContextPart) {
      fullSystemPrompt += `\n\n${loopContextPart}`;
    }

    if (!replacesLegacyAgentMemory(runtimeContext)) {
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
  const runtimeContextPrompt = renderRuntimeContextPrompt(runtimeContext);
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
  toolRunScope?: CompletionToolRunScope;
  onToolCall?: (toolCall: LoopRuntimeToolCall) => Promise<void>;
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
  const settings = deps.getConfig()?.settings;
  const contextTrust = normalizeRuntimeContextTrustMode(
    options.contextTrust ?? settings?.contextTrust,
  );
  const reasoning = agentConfig.reasoning ?? settings?.reasoning;
  let fullSystemPrompt = await buildRuntimeAgentPrompt(
    deps,
    agentConfig,
    extraSystemParts,
    loopContextPrompt(
      stepName,
      loopUserVisibleContext(context),
      contextTrust,
    ),
    contextTrust,
    runtimeContext,
  );
  let messages: any[] = contextTrust === "enforce"
    ? protectRuntimeToolResultMessages(aiMessages)
    : [...aiMessages];
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
  );
  let executeTool = createGuardedCompletionToolExecutor({
    executor: resolvedTools.executor,
    tools: resolvedTools.tools,
    middleware: deps.runToolMiddleware,
    context: {
      planId: options.runtimePlan?.id,
      surface: options.runtimePlan?.surface,
      source: "loop-step",
      agent: agentConfig.name,
      runId: options.runId,
      sessionId: options.sessionId,
    },
  });
  const modelToolChoice = toAIToolChoice(agentConfig.toolChoice);
  let modelTools = resolvedTools.tools;
  let activeToolNames: (() => string[]) | undefined;
  let activeCompactionTools: (() => any[]) | undefined;
  if (resolvedTools.disclosure?.mode === "model-controlled") {
    const configuredInitial = [...(resolvedTools.disclosure.initiallyLoaded ?? [])];
    const forcedTool = forcedModelToolName(modelToolChoice);
    if (forcedTool && modelTools.some((tool) => tool?.name === forcedTool)) {
      configuredInitial.push(forcedTool);
    }
    const pool = createModelControlledToolPool({
      tools: modelTools,
      executor: executeTool,
      initiallyLoaded: [...new Set(configuredInitial)],
      maxLoadedTools: resolvedTools.disclosure.maxLoadedTools,
      maxLoadBatch: resolvedTools.disclosure.maxLoadBatch,
      maxSearchResults: resolvedTools.disclosure.maxSearchResults,
    });
    const providerToolNames = Object.keys(resolvedTools.extraAiTools ?? {});
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
    ...(resolvedTools.extraAiTools ?? {}),
  };
  const providerToolNames = new Set(Object.keys(resolvedTools.extraAiTools ?? {}));
  let finalText = "";
  let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  let lastProviderMetadata: Record<string, unknown> | undefined;
  const toolCallsAccum: any[] = [];

  try {
    for (let turn = 0; turn < (agentConfig.maxTurns ?? MAX_TURNS); turn++) {
      const compactionResult = await compactIfNeeded({
        systemPrompt: fullSystemPrompt,
        messages,
        tools: activeCompactionTools?.() ?? modelTools,
        config: {
          contextWindow: m.contextWindow ?? 200_000,
          maxOutputTokens: m.maxTokens ?? 8192,
        },
        summarize: buildSummarizeFn(m, providerOpts),
        mode: "chat",
      });
      if (compactionResult.compacted) {
        const compacted = contextTrust === "enforce"
          ? protectRuntimeToolResultMessages(compactionResult.messages)
          : compactionResult.messages;
        messages.splice(0, messages.length, ...compacted);
      }

      const toolCallNames = new Map<string, string>();
      const toolCallArgsText = new Map<string, string>();
      const resolvedAttempts = new Map<number, typeof initialResolved>();
      const turnResult = await runModelPolicyTurn({
        selection: modelSelection,
        resolveAttempt: async (attempt) => {
          const resolvedAttempt = attempt.index === 0
            ? initialResolved
            : await deps.resolveAgentModel(agentConfigForModelAttempt(agentConfig, attempt.model), reasoning);
          resolvedAttempts.set(attempt.index, resolvedAttempt);
          return {
            model: resolvedAttempt.model.aiModel,
            maxOutputTokens: resolvedAttempt.model.maxTokens,
            providerOptions: resolvedAttempt.providerOptions,
          };
        },
        preserveSingleAttemptError: true,
        system: fullSystemPrompt,
        messages,
        tools: aiTools,
        ...(activeToolNames ? { activeTools: activeToolNames() } : {}),
        ...(modelToolChoice ? { toolChoice: modelToolChoice as any } : {}),
      }, async (event) => {
        if (event.type === "tool-input-start") {
          toolCallNames.set(event.id, event.name);
          await onToolCall?.({
            id: event.id,
            name: event.name,
            state: "preparing",
          });
        } else if (event.type === "tool-input-delta") {
          const acc = (toolCallArgsText.get(event.id) ?? "") + event.delta;
          toolCallArgsText.set(event.id, acc);
          await onToolCall?.({
            id: event.id,
            name: toolCallNames.get(event.id) ?? "",
            state: "preparing",
            argumentsText: acc,
          });
        }
      });

      const turnText = turnResult.text;
      const selectedResolved = resolvedAttempts.get(turnResult.selectedAttempt.index);
      if (selectedResolved) {
        m = selectedResolved.model;
        providerOpts = selectedResolved.providerOptions;
      }
      totalUsage = addUsage(totalUsage, turnResult.usage);
      lastProviderMetadata = turnResult.providerMetadata as Record<string, unknown> | undefined;

      await appendModelResponseMessages(
        messages,
        turnResult,
        turnText,
        turnResult.toolCalls,
        contextTrust,
      );
      finalText += turnText;

      if (turnResult.toolCalls.length === 0) break;

      const dispatchableToolCalls = turnResult.toolCalls.filter(
        (call) => !isInvalidModelToolCall(call),
      );
      for (const call of turnResult.toolCalls.filter(isInvalidModelToolCall)) {
        const event = invalidModelToolCallEvent(call);
        toolCallsAccum.push(event);
        await onToolCall?.(event);
      }
      if (dispatchableToolCalls.length === 0) continue;

      const providerToolResults = indexToolResultsByCallId(turnResult.toolResults as any[] | undefined);

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
        const result = await executeTool(call.toolName, callArgs, {
          callId: call.toolCallId,
          signal: options.signal,
        });
        const isError = result.startsWith("Error:");
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
        messages.push({
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: isError
              ? {
                  type: "error-text" as const,
                  value: contextTrust === "enforce"
                    ? renderRuntimeToolResult(call.toolName, call.toolCallId, result)
                    : result,
                }
              : {
                  type: "text" as const,
                  value: contextTrust === "enforce"
                    ? renderRuntimeToolResult(call.toolName, call.toolCallId, result)
                    : result,
                },
          }],
        });
      }
    }

    return {
      text: finalText,
      output: maybeParseJson(finalText),
      usage: totalUsage,
      model: m.id ?? m.provider,
      resolvedModel: completionResolvedModelInfo(m),
      providerMetadata: lastProviderMetadata,
      toolCalls: toolCallsAccum,
    };
  } finally {
    if (resolvedTools.cleanup) {
      await resolvedTools.cleanup().catch(() => {});
    }
  }
}
