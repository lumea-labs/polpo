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
  loopContextPrompt,
  maybeParseJson,
  normalizeModelPolicy,
  type ContextBag,
  type ModelSelection,
  type SummarizeFn,
} from "@polpo-ai/core";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";
import { runModelPolicyTurn } from "@polpo-ai/llm";
import type { CompletionRouteDeps } from "../completions.js";
import { appendModelResponseMessages } from "./message-mapping.js";
import {
  emitFileChanged,
  indexToolResultsByCallId,
  providerToolCallEvent,
  toAITools,
  toAIToolChoice,
  type LoopRuntimeToolCall,
} from "./tool-mapping.js";

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

export function modelSelectionForAgent(agentConfig: any, fallback: string): ModelSelection {
  return agentConfig?.model ?? fallback;
}

export function agentConfigForModelPrimary(agentConfig: any): any {
  if (!agentConfig?.model) return agentConfig;
  return {
    ...agentConfig,
    model: normalizeModelPolicy(agentConfig.model).primary,
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
      messages: msgs,
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
): Promise<string> {
  if (deps.buildRuntimePrompt) {
    return deps.buildRuntimePrompt(agentConfig, {
      mode: "loop-step",
      extraSystemParts,
      loopContextPart,
      includeAgentMemory: true,
    });
  }

  const agentSystemPrompt = await deps.buildAgentPrompt(agentConfig);
  const conversationalPreamble = [
    "You are now in interactive conversation mode with the user.",
    "Unlike task execution, you should engage in dialogue: ask clarifying questions,",
    "explain your reasoning, and wait for user input when needed.",
    "You still have access to all your coding tools to help the user.",
  ].join("\n");

  let fullSystemPrompt = `${conversationalPreamble}\n\n${agentSystemPrompt}`;
  if (extraSystemParts.length > 0) {
    fullSystemPrompt += `\n\n## Additional context from caller\n\n${extraSystemParts.join("\n\n")}`;
  }
  if (loopContextPart) {
    fullSystemPrompt += `\n\n${loopContextPart}`;
  }

  const memoryStore = deps.getMemoryStore();
  const agentMemory = await memoryStore?.get(agentMemoryScope(agentConfig.name));
  if (agentMemory) {
    fullSystemPrompt += `\n\n## Your persistent memory\n\n${agentMemory}`;
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
  onToolCall?: (toolCall: LoopRuntimeToolCall) => Promise<void>;
}): Promise<AgentStepRunResult> {
  const { deps, agentConfig, aiMessages, extraSystemParts, context, stepName, onToolCall } = options;
  const reasoning = agentConfig.reasoning ?? deps.getConfig()?.settings?.reasoning;
  const initialResolved = await deps.resolveAgentModel(agentConfigForModelPrimary(agentConfig), reasoning);
  let m = initialResolved.model;
  let providerOpts = initialResolved.providerOptions;
  const modelSelection = modelSelectionForAgent(agentConfig, modelSelectionForResolvedModel(m));
  const resolvedTools = await deps.resolveAgentTools(agentConfig);
  const aiTools = {
    ...toAITools(resolvedTools.tools),
    ...(resolvedTools.extraAiTools ?? {}),
  };
  const providerToolNames = new Set(Object.keys(resolvedTools.extraAiTools ?? {}));
  const modelToolChoice = toAIToolChoice(agentConfig.toolChoice);
  const fullSystemPrompt = await buildRuntimeAgentPrompt(
    deps,
    agentConfig,
    extraSystemParts,
    loopContextPrompt(stepName, context),
  );

  const messages: any[] = [...aiMessages];
  let finalText = "";
  let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  let lastProviderMetadata: Record<string, unknown> | undefined;
  const toolCallsAccum: any[] = [];

  try {
    for (let turn = 0; turn < (agentConfig.maxTurns ?? MAX_TURNS); turn++) {
      const compactionResult = await compactIfNeeded({
        systemPrompt: fullSystemPrompt,
        messages,
        tools: resolvedTools.tools,
        config: {
          contextWindow: m.contextWindow ?? 200_000,
          maxOutputTokens: m.maxTokens ?? 8192,
        },
        summarize: buildSummarizeFn(m, providerOpts),
        mode: "chat",
      });
      if (compactionResult.compacted) {
        messages.splice(0, messages.length, ...compactionResult.messages);
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

      await appendModelResponseMessages(messages, turnResult, turnText, turnResult.toolCalls);
      finalText += turnText;

      if (turnResult.toolCalls.length === 0) break;

      const providerToolResults = indexToolResultsByCallId(turnResult.toolResults as any[] | undefined);

      for (const call of turnResult.toolCalls) {
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
        const result = await resolvedTools.executor(call.toolName, callArgs);
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
              ? { type: "error-text" as const, value: result }
              : { type: "text" as const, value: result },
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
      resolvedTools.cleanup().catch(() => {});
    }
  }
}
