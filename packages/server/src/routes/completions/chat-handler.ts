/**
 * Standard chat-mode execution for the completions endpoint.
 *
 * Owns the multi-turn tool loop over the shared model-turn primitive in both
 * streaming (SSE) and non-streaming variants: client-side tools,
 * interactive orchestrator tools, provider-executed tools, context
 * compaction, session persistence, and metering callbacks.
 */

import { TerminationGate, TerminationGateError } from "@polpo-ai/core/runtime-hooks";
import { streamSSE } from "hono/streaming";
import {
  compactIfNeeded,
  renderRuntimeToolResult,
  type CompactionEvent,
  type ModelSelection,
  type RuntimeContextTrustMode,
  type ResolvedExecutionRoute,
  type RuntimePlan,
  type RuntimeContextResolution,
} from "@polpo-ai/core";
import type {
  ChatSuggestion,
  NormalizedChatInteractionSettings,
  ResolvedChatInteractionCapabilities,
} from "@polpo-ai/core/chat-interactions";
import type { SessionClientToolDefinition } from "@polpo-ai/core/session-store";
import {
  classifyRuntimeError,
  runModelPolicyTurn,
} from "@polpo-ai/llm";
import { Output, type LanguageModelUsage } from "ai";
import type { CompletionRouteDeps } from "../completions.js";
import type { CompletionRequestBody } from "./schemas.js";
import {
  agentConfigForModelAttempt,
  buildSummarizeFn,
  completionResolvedModelInfo,
  MAX_TURNS,
  modelSelectionForResolvedModel,
  type ResolvedModelInfo,
} from "./agent-step-runner.js";
import { CompletionModelInvocationLedger } from "./model-invocations.js";
import { appendModelResponseMessages } from "./message-mapping.js";
import {
  completionResponse,
  guardrailErrorEnvelope,
  modelErrorEnvelope,
  modelNotFoundEnvelope,
  sseChunk,
  ssePolpoChunk,
  structuredOutputErrorEnvelope,
} from "./sse.js";
import {
  CLIENT_SIDE_TOOLS,
  CLIENT_SIDE_TOOL_NAMES,
  emitFileChanged,
  indexToolResultsByCallId,
  invalidModelToolCallEvent,
  isInvalidModelToolCall,
  appendReasoningSummary,
  persistAssistantMessage,
  notifyCanonicalTurnCommitted,
  type CanonicalTurnPersistenceContext,
  recordProviderToolCall,
  toAITools,
} from "./tool-mapping.js";
import { suggestionsForCompletion } from "./chat-interaction-runtime.js";
import type {
  CompletionToolExecutor,
  CompletionToolProgressState,
} from "./tool-guardrails.js";
import {
  CompletionRuntimeError,
  completionRuntimeErrorEnvelope,
} from "./runtime-error.js";
import {
  applyCompletionOutputPolicy,
  streamingOutputPolicyMode,
} from "./output-guardrails.js";
import {
  finalizeResponseFormatText,
  isStructuredResponseFormat,
  serializeModelOutput,
} from "./structured-output.js";
import { selectRequestClientToolCall } from "./client-tools.js";
import {
  executeCompletionToolBatch,
  executeCompletionToolCall,
} from "./tool-execution-batch.js";
import type { CompletionRuntimeHookContext } from "./runtime-hooks.js";
import {
  dispatchCompletionModelPolicyHook,
  dispatchCompletionRuntimeHook,
  runCompletionRuntimeHookOperation,
  runtimeHookDecisionError,
  runtimeHookModifiedString,
  runtimeHookStopFeedback,
} from "./runtime-hooks.js";

/** Resolved execution context for a standard (non-loop) chat completion. */
export interface ChatCompletionExecution {
  deps: CompletionRouteDeps;
  body: {
    messages?: CompletionRequestBody["messages"];
    stream?: boolean;
    agent?: string;
    user?: string;
    sandbox?: CompletionRequestBody["sandbox"];
    parallel_tool_calls?: CompletionRequestBody["parallel_tool_calls"];
    response_format?: CompletionRequestBody["response_format"];
    polpo?: CompletionRequestBody["polpo"];
  };
  completionId: string;
  /** Resolved agent config (agent-direct mode). Used by chat-via-executeRun
   *  (F1c) to build the RunnerConfig. Undefined in orchestrator mode. */
  agentConfig: any;
  toolInvocation?: import("@polpo-ai/core").ToolInvocationContext;
  agentMode: boolean;
  fullSystemPrompt: string;
  m: ResolvedModelInfo;
  providerOpts?: Record<string, any>;
  modelSelection?: ModelSelection;
  modelToolChoice?: unknown;
  /** Parsed provider-neutral output contract derived from response_format. */
  modelOutput?: Output.Output<unknown, unknown, unknown>;
  effectiveTools: any[];
  effectiveToolExecutor: CompletionToolExecutor;
  /** Normalized conversational behavior owned by the selected agent. */
  interactionSettings: NormalizedChatInteractionSettings;
  /** Effective client interaction support after agent and surface policy. */
  interactionCapabilities?: ResolvedChatInteractionCapabilities;
  clientSideTools?: Record<string, any>;
  clientSideToolNames?: Set<string>;
  /** Server-owned catalog retained across delayed direct-chat continuation. */
  requestClientTools?: readonly SessionClientToolDefinition[];
  /** Dynamic model-facing pool for progressive disclosure. */
  activeToolNames?: () => string[];
  /** Dynamic Polpo tool definitions used for compaction estimation. */
  activeCompactionTools?: () => any[];
  /**
   * Provider-executed tools the host wants merged into the AI SDK tool
   * palette as-is. Polpo never invokes these locally — the SDK / model
   * provider handles them (Vercel Gateway today).
   * Keys here MUST be skipped by the manual tool-call dispatcher.
   */
  extraAiTools?: Record<string, any>;
  isInteractiveFn?: (name: string) => boolean;
  aiMessages: any[];
  sessionStore: any;
  sessionId: string | null;
  /** The request joined an existing durable Session rather than creating one. */
  sessionResumed?: boolean;
  /** Atomic admission result for a delayed client-tool continuation. */
  continuationState?: {
    status: "prepared" | "replay";
    toolCallId: string;
  };
  /** Logical request turn shared by user, tool continuation, and assistant messages. */
  turnId?: string;
  /** Present only when automatic/suggest learning is enabled for this surface. */
  canonicalTurn?: CanonicalTurnPersistenceContext;
  /** Frozen, secret-free runtime decision emitted before provider/tool resolution. */
  runtimePlan?: RuntimePlan;
  /** Explicit, host-resolved context-trust mode for this conversation turn. */
  contextTrust?: RuntimeContextTrustMode;
  /** Structured snapshot used to assemble fullSystemPrompt for this turn. */
  runtimeContext?: RuntimeContextResolution;
  /** Validated direct-or-loop decision for audit and downstream propagation. */
  executionRoute?: ResolvedExecutionRoute;
  /** Host-resolved immutable hook snapshot shared with inline and Run-backed chat. */
  runtimeHooks?: CompletionRuntimeHookContext;
  /** Shared with the guarded executor so every chat transport stops on livelock. */
  toolProgressState?: CompletionToolProgressState;
  /**
   * Resource cleanup hook — set when an agent's tool resolver opens
   * long-lived connections (today: MCP transports). Invoked exactly
   * once after the response finishes, regardless of streaming/non-
   * streaming/error path. Wrapped in try/catch by the caller so a
   * misbehaving cleanup can't leak the request itself.
   */
  onResponseFinished?: () => Promise<void>;
}

function assertChatToolProgress(exec: ChatCompletionExecution): void {
  const stalled = exec.toolProgressState?.stalled;
  if (!stalled) return;
  throw new CompletionRuntimeError(stalled.message, stalled.code, 409);
}

/**
 * Merge the effective tool palette for the LLM.
 *
 * Convert Polpo tools to AI SDK format (no execute — manual execution).
 * Client-side tools (ask_user_question, etc.) stop the server loop and
 * return to the client as standard tool_calls.
 * `extraAiTools` are provider-executed (e.g. Vercel Gateway native
 * tools) — already in AI SDK shape, must NOT be Polpo-converted.
 */
function mergeAiTools(exec: ChatCompletionExecution): Record<string, any> {
  return {
    ...toAITools(exec.effectiveTools),
    ...(exec.extraAiTools ?? {}),
    ...(exec.clientSideTools ?? CLIENT_SIDE_TOOLS),
  };
}

function clientSideToolNames(exec: ChatCompletionExecution): Set<string> {
  return exec.clientSideToolNames ?? CLIENT_SIDE_TOOL_NAMES;
}

function addChatUsage(a: LanguageModelUsage, b: LanguageModelUsage): LanguageModelUsage {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
  } as LanguageModelUsage;
}

async function runChatTerminalOutputPhase(options: {
  exec: ChatCompletionExecution;
  modelSelection: ModelSelection;
  primaryModel: ResolvedModelInfo;
  primaryProviderOpts?: Record<string, any>;
  reasoning?: string;
  systemPrompt?: string;
  messages: any[];
  signal?: AbortSignal;
  gate?: TerminationGate;
  onUsage?: (usage: LanguageModelUsage) => void;
  invocations?: CompletionModelInvocationLedger;
}) {
  const {
    exec, modelSelection, primaryModel, primaryProviderOpts,
    reasoning, messages, signal, systemPrompt,
  } = options;
  if (!exec.modelOutput) {
    throw new Error("Structured response format is missing its model output contract");
  }

  const terminalMessages = (isRecovery: boolean) => [
    ...messages,
    {
      role: "user" as const,
      content: isRecovery
        ? "The previous terminal response did not satisfy the required output schema. Operational work is already complete. Return only the terminal result required by the configured schema, using the canonical conversation and tool results. Do not call tools or repeat side effects."
        : "Operational work is complete. Return only the terminal result required by the configured schema, using the canonical conversation and tool results. Do not call tools or repeat side effects.",
    },
  ];

  let originalDiagnostic: ReturnType<typeof classifyRuntimeError> | undefined;
  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    options.gate?.assertAvailable();
    signal?.throwIfAborted();
    const isRecovery = attemptIndex === 1;
    if (isRecovery) {
      const { raw: _raw, ...original } = originalDiagnostic!;
      exec.deps.emit("runtime:structured-output-recovery", {
        phase: "started",
        source: "chat",
        agent: exec.body.agent,
        sessionId: exec.sessionId,
        original,
      });
    }
    const resolvedAttempts = new Map<number, {
      model: ResolvedModelInfo;
      providerOptions?: Record<string, any>;
    }>();
    try {
      const result = await runCompletionRuntimeHookOperation({
        hooks: exec.runtimeHooks,
        before: "model:before",
        after: "model:after",
        error: "model:error",
        data: { phase: "terminal", recovery: isRecovery, model: primaryModel.id ?? primaryModel.provider },
        resultData: (modelResult: any) => ({
          finishReason: modelResult.finishReason,
          toolCallCount: modelResult.toolCalls?.length ?? 0,
        }),
        operation: () => runModelPolicyTurn({
        selection: modelSelection,
        resolveAttempt: async (attempt) => {
          const resolvedAttempt = attempt.index === 0 || !exec.agentMode || !exec.agentConfig
            ? { model: primaryModel, providerOptions: primaryProviderOpts }
            : await exec.deps.resolveAgentModel(
                agentConfigForModelAttempt(exec.agentConfig, attempt.model),
                reasoning,
              );
          resolvedAttempts.set(attempt.index, resolvedAttempt);
          return {
            model: resolvedAttempt.model.aiModel,
            maxOutputTokens: options.gate ? Math.min(resolvedAttempt.model.maxTokens, options.gate.remainingTokens) : resolvedAttempt.model.maxTokens,
            providerOptions: resolvedAttempt.providerOptions,
            capabilities: resolvedAttempt.model.capabilities,
          };
        },
        preserveSingleAttemptError: true,
        onPolicyEvent: (event) => {
          options.invocations?.observePolicyEvent("terminal", event);
          return dispatchCompletionModelPolicyHook(exec.runtimeHooks, event);
        },
        allowCommittedFallback: true,
        maxRecoverableStreamRetries: 0,
        system: systemPrompt ?? exec.fullSystemPrompt,
        messages: terminalMessages(isRecovery),
        output: exec.modelOutput,
        ...(signal ? { abortSignal: signal } : {}),
        }),
      });
      options.gate?.recordUsage(result.usage);
      options.onUsage?.(result.usage);
      options.invocations?.record("terminal", result);
      if (result.toolCalls.length > 0 || result.output === undefined) {
        throw new Error(
          result.toolCalls.length > 0
            ? "Terminal structured-output phase returned a tool call"
            : "Terminal structured-output phase completed without structured output",
        );
      }
      for (const warning of result.warnings ?? []) {
        exec.deps.emit("runtime:model-warning", {
          source: "chat-terminal-output",
          agent: exec.body.agent,
          sessionId: exec.sessionId,
          warning,
        });
      }
      if (isRecovery) {
        exec.deps.emit("runtime:structured-output-recovery", {
          phase: "succeeded",
          source: "chat",
          agent: exec.body.agent,
          sessionId: exec.sessionId,
        });
      }
      return {
        result,
        resolved: resolvedAttempts.get(result.selectedAttempt.index),
      };
    } catch (error) {
      if (error instanceof TerminationGateError || signal?.aborted) throw error;
      const diagnostic = classifyRuntimeError(error);
      if (!isRecovery) {
        originalDiagnostic = diagnostic;
        continue;
      }
      const { raw: _originalRaw, ...original } = originalDiagnostic!;
      const { raw: _recoveryRaw, ...recovery } = diagnostic;
      exec.deps.emit("runtime:structured-output-recovery", {
        phase: "failed",
        source: "chat",
        agent: exec.body.agent,
        sessionId: exec.sessionId,
        original,
        recovery,
      });
      throw error;
    }
  }
  throw new Error("Terminal structured-output phase failed");
}

async function runChatStopFeedbackPhase(options: {
  exec: ChatCompletionExecution;
  modelSelection: ModelSelection;
  primaryModel: ResolvedModelInfo;
  primaryProviderOpts?: Record<string, any>;
  reasoning?: string;
  systemPrompt?: string;
  messages: any[];
  feedback: string;
  signal?: AbortSignal;
  invocations?: CompletionModelInvocationLedger;
}) {
  const { exec, modelSelection, primaryModel, primaryProviderOpts, reasoning, systemPrompt, messages, feedback, signal } = options;
  const resolvedAttempts = new Map<number, { model: ResolvedModelInfo; providerOptions?: Record<string, any> }>();
  const result = await runCompletionRuntimeHookOperation({
    hooks: exec.runtimeHooks,
    before: "model:before",
    after: "model:after",
    error: "model:error",
    data: { phase: "stop-feedback", retry: 1, model: primaryModel.id ?? primaryModel.provider },
    resultData: (modelResult: any) => ({
      finishReason: modelResult.finishReason,
      toolCallCount: modelResult.toolCalls?.length ?? 0,
    }),
    operation: () => runModelPolicyTurn({
      selection: modelSelection,
      resolveAttempt: async (attempt) => {
        const resolvedAttempt = attempt.index === 0 || !exec.agentMode || !exec.agentConfig
          ? { model: primaryModel, providerOptions: primaryProviderOpts }
          : await exec.deps.resolveAgentModel(agentConfigForModelAttempt(exec.agentConfig, attempt.model), reasoning);
        resolvedAttempts.set(attempt.index, resolvedAttempt);
        return {
          model: resolvedAttempt.model.aiModel,
          maxOutputTokens: resolvedAttempt.model.maxTokens,
          providerOptions: resolvedAttempt.providerOptions,
          capabilities: resolvedAttempt.model.capabilities,
        };
      },
      preserveSingleAttemptError: true,
      onPolicyEvent: (event) => {
        options.invocations?.observePolicyEvent("stop-feedback", event);
        return dispatchCompletionModelPolicyHook(exec.runtimeHooks, event);
      },
      system: systemPrompt ?? exec.fullSystemPrompt,
      messages: [
        ...messages,
        {
          role: "user" as const,
          content: `A trusted runtime hook rejected ending the turn and returned this feedback:\n\n${feedback}\n\nContinue once and return the corrected final response. Do not repeat completed side effects.`,
        },
      ],
      tools: {},
      toolChoice: "none",
      ...(signal ? { abortSignal: signal } : {}),
    }),
  });
  options.invocations?.record("stop-feedback", result);
  if (result.toolCalls.length > 0) throw new Error("Stop-feedback recovery returned a tool call");
  return { result, resolved: resolvedAttempts.get(result.selectedAttempt.index) };
}

/** Streaming chat mode — SSE stream of OpenAI-format chunks. */
export function streamChatCompletion(c: any, exec: ChatCompletionExecution): any {
  return streamSSE(c, async (stream) => {
    const abortController = new AbortController();
    stream.onAbort(() => { abortController.abort(); });
    const heartbeatInterval = setInterval(() => {
      if (abortController.signal.aborted) {
        clearInterval(heartbeatInterval);
        return;
      }
      stream.write(": ping\n\n").catch(() => clearInterval(heartbeatInterval));
    }, 20_000);
    try {
      await executeStreamingChatCompletion(stream, exec, abortController.signal);
    } finally {
      clearInterval(heartbeatInterval);
    }
  }) as any;
}

export interface CompletionSseWriter {
  write(data: string): Promise<unknown>;
  writeSSE(message: { data: string; event?: string; id?: string }): Promise<unknown>;
}

/** Transport-independent producer used by attached and durable followers. */
export async function executeStreamingChatCompletion(
  stream: CompletionSseWriter,
  exec: ChatCompletionExecution,
  signal: AbortSignal,
): Promise<void> {
  const callerSignal = signal;
  const {
    deps, body, completionId, agentMode, fullSystemPrompt: initialSystemPrompt,
    m: primaryModel, providerOpts: primaryProviderOpts,
    modelToolChoice, effectiveTools, effectiveToolExecutor, extraAiTools,
    isInteractiveFn, aiMessages, sessionStore, sessionId, onResponseFinished,
  } = exec;
  let fullSystemPrompt = initialSystemPrompt;
  const aiTools = mergeAiTools(exec);
  let m = primaryModel;
  let providerOpts = primaryProviderOpts;
  const modelSelection = exec.modelSelection ?? modelSelectionForResolvedModel(primaryModel);
  const reasoning = exec.agentConfig?.reasoning ?? deps.getConfig()?.settings?.reasoning;
  const outputMode = exec.runtimeHooks?.dispatcher?.getTerminationGatePolicy?.(exec.runtimeHooks) ? "buffer" : streamingOutputPolicyMode(deps.runOutputPolicy);
  const gatePolicy = exec.runtimeHooks?.dispatcher?.getTerminationGatePolicy?.(exec.runtimeHooks);
  const gate = gatePolicy ? new TerminationGate(gatePolicy) : undefined;
  if (gate) signal = AbortSignal.any([callerSignal, AbortSignal.timeout(gate.remainingMs)]);
  if (gate && exec.runtimeHooks) exec = { ...exec, runtimeHooks: { ...exec.runtimeHooks, signal } };
  let gateAccepted = false;
  let nextTurn = 0;
  const maxTurns = exec.agentConfig?.maxTurns ?? MAX_TURNS;
  const structuredResponse = isStructuredResponseFormat(body.response_format);

    await stream.writeSSE({ data: sseChunk(completionId, { role: "assistant" }) });

    // Reserve a placeholder message in the store BEFORE streaming.
    // This guarantees the assistant message exists even if the client disconnects.
    let assistantMsgId: string | null = null;
    if (sessionStore && sessionId) {
      const placeholder = exec.turnId
        ? await sessionStore.addMessage(sessionId, "assistant", "", {
            turnId: exec.turnId,
          })
        : await sessionStore.addMessage(sessionId, "assistant", "");
      assistantMsgId = placeholder.id;
    }

    const messages: any[] = [...aiMessages];
    let finalText = "";
    let finalReasoning = "";
    let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
    const toolCallsAccum: any[] = [];
    let lastProviderMetadata: Record<string, unknown> | undefined;
    const invocations = new CompletionModelInvocationLedger();
    let outputPolicyApplied = false;
    let suggestions: ChatSuggestion[] = [];
    let persistenceAttempted = false;
    let clientToolCallId: string | undefined;
    let completedStructuredOutput = false;
    const persistResponse = async (canonicalTurnSucceeded = false) => {
      persistenceAttempted = true;
      const committedTurn = await persistAssistantMessage(
        sessionStore, sessionId, assistantMsgId, finalText, toolCallsAccum,
        {
          ...(suggestions.length > 0 ? { suggestions } : {}),
          reasoning: finalReasoning,
          requestClientTools: exec.requestClientTools,
          clientToolCallId,
          ...(canonicalTurnSucceeded && exec.canonicalTurn
            ? { canonicalTurn: exec.canonicalTurn }
            : {}),
        },
      );
      notifyCanonicalTurnCommitted(deps.onCanonicalTurnCommitted, committedTurn);
    };
    const finalizeOutput = async (validateStructured = true) => {
      if (outputPolicyApplied) return;
      finalText = await applyCompletionOutputPolicy({
        outputPolicy: deps.runOutputPolicy,
        text: finalText,
        mode: outputMode === "buffer" ? "enforce" : "audit",
        runtimePlan: exec.runtimePlan,
        agent: body.agent,
        sessionId,
        signal,
      });
      if (validateStructured) {
        finalText = await finalizeResponseFormatText(body.response_format, finalText);
      }
      signal.throwIfAborted();
      outputPolicyApplied = true;
      if (!finalText) return;
      if (outputMode === "buffer" || structuredResponse) {
        await stream.writeSSE({ data: sseChunk(completionId, { content: finalText }) });
      }
    };

    const completeTerminalOutput = async () => {
      const terminal = await runChatTerminalOutputPhase({
        exec,
        modelSelection,
        primaryModel,
        primaryProviderOpts,
        reasoning,
        systemPrompt: fullSystemPrompt,
        messages,
        gate,
        onUsage: (usage) => { totalUsage = addChatUsage(totalUsage, usage); },
        invocations,
        signal,
      });
      if (terminal.resolved) {
        m = terminal.resolved.model;
        providerOpts = terminal.resolved.providerOptions;
      }
      if (gate) await appendModelResponseMessages(messages, terminal.result, terminal.result.text, [], exec.contextTrust);
      finalReasoning = appendReasoningSummary(finalReasoning, terminal.result.reasoning);
      lastProviderMetadata = terminal.result.providerMetadata as Record<string, unknown> | undefined;
      finalText = await serializeModelOutput(
        body.response_format,
        terminal.result.output,
        terminal.result.text,
      );
      completedStructuredOutput = true;
    };

    let runtimeAgentStarted = false;
    try {
      await dispatchCompletionRuntimeHook(exec.runtimeHooks, "run:start", { streaming: true });
      await dispatchCompletionRuntimeHook(
        exec.runtimeHooks,
        exec.sessionResumed ? "session:resume" : "session:start",
        { streaming: true },
      );
      const spawnDecision = await dispatchCompletionRuntimeHook(exec.runtimeHooks, "agent:spawn", {
        source: "direct-chat",
        streaming: true,
      });
      const spawnError = runtimeHookDecisionError(spawnDecision);
      if (spawnError) throw spawnError;
      runtimeAgentStarted = true;
      const inputDecision = await dispatchCompletionRuntimeHook(exec.runtimeHooks, "input:before", {
        messageCount: messages.length,
        streaming: true,
      });
      const inputError = runtimeHookDecisionError(inputDecision);
      if (inputError) throw inputError;
      const inputContext = runtimeHookModifiedString(inputDecision, "context");
      if (inputContext) fullSystemPrompt += `\n\n## Runtime hook context\n\n${inputContext}`;
    gateLoop: while (true) {
      if (
        structuredResponse
        && Object.keys(aiTools).length === 0
      ) {
        nextTurn += 1;
        await completeTerminalOutput();
      }

      for (; !completedStructuredOutput && nextTurn < maxTurns;) {
        const turn = nextTurn++;
        gate?.assertAvailable();
        signal.throwIfAborted();
        // Bail out early if the client already disconnected
        if (signal.aborted) break;

        // Compact context if approaching the model's context window limit.
        // Under threshold this is just a cheap token estimation — zero LLM calls.
        await dispatchCompletionRuntimeHook(exec.runtimeHooks, "context:compact:before", {
          messageCount: messages.length,
          model: m.id ?? m.provider,
        });
        const compactionResult = await compactIfNeeded({
          systemPrompt: fullSystemPrompt,
          messages,
          tools: exec.activeCompactionTools?.() ?? effectiveTools,
          config: {
            contextWindow: m.contextWindow ?? 200_000,
            maxOutputTokens: m.maxTokens ?? 8192,
          },
          summarize: buildSummarizeFn(m, providerOpts, { gate, signal, invocations, onUsage: (usage) => { totalUsage = addChatUsage(totalUsage, usage); } }),
          mode: "chat",
          onCompaction: async (event: CompactionEvent) => {
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, {
                compaction: {
                  phase: event.phase,
                  tokensBefore: event.tokensBefore,
                  tokensAfter: event.tokensAfter,
                  tokensReclaimed: event.tokensReclaimed,
                  messagesBefore: event.messagesBefore,
                  messagesAfter: event.messagesAfter,
                },
              }),
            });
          },
        });
        if (compactionResult.compacted) {
          messages.splice(0, messages.length, ...compactionResult.messages);
          await dispatchCompletionRuntimeHook(exec.runtimeHooks, "context:compact:after", {
            messageCount: messages.length,
            compacted: true,
          });
        }

        let turnText = "";
        let streamError: string | undefined;
        // Per-tool-call streaming state for this turn: the tool name (learned
        // at tool-input-start) and the raw args JSON accumulated from the
        // token-by-token input deltas, so the UI can render the call as it
        // builds up instead of waiting for the whole turn to finish.
        const toolCallNames = new Map<string, string>();
        const resolvedAttempts = new Map<number, { model: ResolvedModelInfo; providerOptions?: Record<string, any> }>();

        const result = await runCompletionRuntimeHookOperation({
          hooks: exec.runtimeHooks,
          before: "model:before",
          after: "model:after",
          error: "model:error",
          data: { phase: "operational", turn, model: m.id ?? m.provider },
          resultData: (modelResult: any) => ({
            finishReason: modelResult.finishReason,
            toolCallCount: modelResult.toolCalls?.length ?? 0,
          }),
          operation: () => runModelPolicyTurn({
          selection: modelSelection,
          resolveAttempt: async (attempt) => {
            const resolvedAttempt = attempt.index === 0 || !agentMode || !exec.agentConfig
              ? { model: primaryModel, providerOptions: primaryProviderOpts }
              : await deps.resolveAgentModel(agentConfigForModelAttempt(exec.agentConfig, attempt.model), reasoning);
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
            return dispatchCompletionModelPolicyHook(exec.runtimeHooks, event);
          },
          system: fullSystemPrompt,
          messages,
          tools: aiTools,
          ...(exec.activeToolNames ? { activeTools: exec.activeToolNames() } : {}),
          ...(modelToolChoice ? { toolChoice: modelToolChoice as any } : {}),
          ...(body.parallel_tool_calls !== undefined
            ? { parallelToolCalls: body.parallel_tool_calls }
            : {}),
          abortSignal: signal,
        }, async (event) => {
          if (signal.aborted) return;
          if (event.type === "warning") {
            deps.emit("runtime:model-warning", {
              source: "chat",
              agent: body.agent,
              sessionId,
              warning: event.warning,
            });
          } else if (event.type === "reasoning-delta") {
            await stream.writeSSE({ data: sseChunk(completionId, {}, null, { thinking: event.text }) });
          } else if (event.type === "text-delta") {
            turnText += event.text;
            if (!structuredResponse) finalText += event.text;
            if (outputMode !== "buffer" && !structuredResponse) {
              await stream.writeSSE({ data: sseChunk(completionId, { content: event.text }) });
            }
          } else if (event.type === "tool-input-start") {
            // Emit early "preparing" signal — the LLM has started generating a tool call
            // but arguments are not yet complete. Lets the UI show immediate feedback.
            toolCallNames.set(event.id, event.name);
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, {
                tool_call: { id: event.id, name: event.name, state: "preparing" },
              }),
            });
          } else if (event.type === "tool-input-delta") {
            // Forward only the new fragment. Cumulative snapshots grow
            // quadratically for large tool inputs and can overflow durable
            // event persistence; clients reconstruct the preview locally.
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, {
                tool_call: {
                  id: event.id,
                  name: toolCallNames.get(event.id) ?? "",
                  state: "preparing",
                  argumentsDelta: event.delta,
                },
              }),
            });
          } else if (event.type === "tool-input-aborted") {
            toolCallNames.delete(event.id);
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, {
                tool_call: {
                  id: event.id,
                  name: event.name,
                  state: "interrupted",
                  result: `Error: ${event.error.message ?? "Model stream interrupted during tool input"}`,
                },
              }),
            });
          } else if (event.type === "finish") {
            // Capture error from finish reason if applicable
            if (event.finishReason === "error") {
              streamError = "Model returned an error";
            }
          }
          }),
        });
        // The provider billed this call even if the client aborted or the
        // stream finished with an error, so meter it before bailing out.
        invocations.record("operational", result);
        finalReasoning = appendReasoningSummary(finalReasoning, result.reasoning);

        // If aborted, stop the loop — skip error/tool processing
        if (signal.aborted) {
          break;
        }

        if (streamError) {
          finalText += `\n\nError: ${streamError}`;
          if (outputMode !== "buffer" && !structuredResponse) {
            await stream.writeSSE({ data: sseChunk(completionId, { content: `\n\nError: ${streamError}` }) });
          }
          break;
        }

        const toolCalls = result.toolCalls;
        const usage = result.usage;
        const selectedResolved = resolvedAttempts.get(result.selectedAttempt.index);
        if (selectedResolved) {
          m = selectedResolved.model;
          providerOpts = selectedResolved.providerOptions;
        }
        totalUsage = addChatUsage(totalUsage, usage);
        gate?.recordUsage(usage);
        lastProviderMetadata = result.providerMetadata as Record<string, unknown> | undefined;

        await appendModelResponseMessages(
          messages,
          result,
          turnText,
          toolCalls,
          exec.contextTrust ?? "off",
        );

        if (toolCalls.length === 0) {
          if (structuredResponse) await completeTerminalOutput();
          break;
        }

        const dispatchableToolCalls = toolCalls.filter(
          (call) => !isInvalidModelToolCall(call),
        );
        for (const call of toolCalls.filter(isInvalidModelToolCall)) {
          const event = invalidModelToolCallEvent(call);
          toolCallsAccum.push(event);
          await stream.writeSSE({
            data: sseChunk(completionId, {}, null, {
              tool_call: event,
            }),
          });
        }
        if (dispatchableToolCalls.length === 0) continue;

        // ── Client-side tools — return to client as standard tool_calls ──
        const clientSideCall = selectRequestClientToolCall(
          dispatchableToolCalls,
          clientSideToolNames(exec),
        );
        if (clientSideCall) {
          await finalizeOutput(false);
          signal.throwIfAborted();
          clientToolCallId = clientSideCall.toolCallId;
          // Persist for session history only after output policy accepts the
          // turn. A rejected or cancelled handoff must not leave a pending tool.
          toolCallsAccum.push({
            id: clientSideCall.toolCallId,
            name: clientSideCall.toolName,
            arguments: clientSideCall.input,
            state: "interrupted",
          });
          await persistResponse();
          // Send as standard OpenAI tool_calls finish reason
          await stream.writeSSE({
            data: JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              choices: [{
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [{
                    index: 0,
                    id: clientSideCall.toolCallId,
                    type: "function",
                    function: {
                      name: clientSideCall.toolName,
                      arguments: JSON.stringify(clientSideCall.input),
                    },
                  }],
                },
                finish_reason: "tool_calls",
              }],
            }),
          });
          await stream.writeSSE({ data: "[DONE]" });
          return;
        }

        // Check for interactive tools — only in orchestrator mode (agents don't have interactive tools)
        const interactiveCall = agentMode ? undefined : dispatchableToolCalls.find((tc: any) => isInteractiveFn?.(tc.toolName));
        if (interactiveCall) {
          await finalizeOutput(false);
          signal.throwIfAborted();
          // Persist before publishing the interaction. The user may respond as
          // soon as the frame arrives and that continuation must see this call.
          toolCallsAccum.push({
            id: interactiveCall.toolCallId,
            name: interactiveCall.toolName,
            arguments: interactiveCall.input,
            state: "interrupted",
          });
          await persistResponse();

          if (interactiveCall.toolName === "ask_user") {
            const questions = (interactiveCall.input as any)?.questions as any[] ?? [];
            await stream.writeSSE({
              data: sseChunk(completionId, {}, "ask_user", { ask_user: { questions } }),
            });
          } else if (interactiveCall.toolName === "create_mission") {
            const args = interactiveCall.input as Record<string, unknown>;
            let missionData: unknown;
            try { missionData = JSON.parse(args.data as string); } catch { missionData = args.data; }
            await stream.writeSSE({
              data: sseChunk(completionId, {}, "mission_preview", {
                mission_preview: {
                  name: args.name as string,
                  data: missionData,
                  prompt: args.prompt as string | undefined,
                },
              }),
            });
          } else if (interactiveCall.toolName === "set_vault_entry") {
            const args = interactiveCall.input as Record<string, unknown>;
            await stream.writeSSE({
              data: sseChunk(completionId, {}, "vault_preview", {
                vault_preview: {
                  agent: args.agent as string,
                  service: args.service as string,
                  type: args.type as string,
                  label: args.label as string | undefined,
                  credentials: args.credentials as Record<string, string>,
                },
              }),
            });
          } else if (interactiveCall.toolName === "open_file") {
            const args = interactiveCall.input as Record<string, unknown>;
            await stream.writeSSE({
              data: sseChunk(completionId, {}, "open_file", {
                open_file: {
                  path: args.path as string,
                },
              }),
            });
          } else if (interactiveCall.toolName === "navigate_to") {
            const args = interactiveCall.input as Record<string, unknown>;
            await stream.writeSSE({
              data: sseChunk(completionId, {}, "navigate_to", {
                navigate_to: {
                  target: args.target as string,
                  id: args.id as string | undefined,
                  name: args.name as string | undefined,
                  path: args.path as string | undefined,
                  highlight: args.highlight as string | undefined,
                },
              }),
            });
          } else if (interactiveCall.toolName === "open_tab") {
            const args = interactiveCall.input as Record<string, unknown>;
            await stream.writeSSE({
              data: sseChunk(completionId, {}, "open_tab", {
                open_tab: {
                  url: args.url as string,
                  label: args.label as string | undefined,
                },
              }),
            });
          }
          await stream.writeSSE({ data: "[DONE]" });
          return; // the interaction and current text are already durable
        }

        // Provider tools (extraAiTools) are executed by the SDK / gateway.
        // Their tool results are already preserved in responseMessages,
        // so only record them for observability and skip local dispatch.
        const providerToolNames = new Set(Object.keys(extraAiTools ?? {}));
        const providerToolResults = indexToolResultsByCallId(result.toolResults as any[] | undefined);

        const appendLocalResult = async (
          call: { toolCallId: string; toolName: string },
          callArgs: Record<string, unknown>,
          toolResult: string,
          isError: boolean,
        ) => {
          emitFileChanged(call.toolName, callArgs, toolResult, deps.emit);
          toolCallsAccum.push({
            id: call.toolCallId,
            name: call.toolName,
            arguments: callArgs,
            result: toolResult,
            state: isError ? "error" : "completed",
          });
          if (!signal.aborted) {
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, {
                tool_call: {
                  id: call.toolCallId,
                  name: call.toolName,
                  result: toolResult,
                  state: isError ? "error" : "completed",
                },
              }),
            });
          }
          const modelResult = exec.contextTrust === "enforce"
            ? renderRuntimeToolResult(call.toolName, call.toolCallId, toolResult)
            : toolResult;
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

        if (body.parallel_tool_calls === true) {
          const localCalls = dispatchableToolCalls
            .filter((call) => !providerToolNames.has(call.toolName))
            .map((call) => ({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input as Record<string, unknown>,
            }));
          const localResults = await executeCompletionToolBatch({
            calls: localCalls,
            executor: effectiveToolExecutor,
            signal,
            onCalling: async (call) => {
              await stream.writeSSE({
                data: sseChunk(completionId, {}, null, {
                  tool_call: {
                    id: call.toolCallId,
                    name: call.toolName,
                    arguments: call.input,
                    state: "calling",
                  },
                }),
              });
            },
          });
          let localResultIndex = 0;
          for (const call of dispatchableToolCalls) {
            if (providerToolNames.has(call.toolName)) {
              recordProviderToolCall(toolCallsAccum, call, providerToolResults);
              continue;
            }
            const local = localResults[localResultIndex++]!;
            await appendLocalResult(call, local.input, local.result, local.isError);
          }
          await dispatchCompletionRuntimeHook(exec.runtimeHooks, "tool:batch:after", {
            count: localResults.length,
            tools: localCalls.map((call) => call.toolName),
          });
          assertChatToolProgress(exec);
        } else {
          for (const call of dispatchableToolCalls) {
            if (signal.aborted) break;
            const callArgs = call.input as Record<string, unknown>;
            if (providerToolNames.has(call.toolName)) {
              recordProviderToolCall(toolCallsAccum, call, providerToolResults);
              continue;
            }
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, {
                tool_call: { id: call.toolCallId, name: call.toolName, arguments: callArgs, state: "calling" },
              }),
            });
            const local = await executeCompletionToolCall({
              call: {
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: callArgs,
              },
              executor: effectiveToolExecutor,
              signal,
            });
            await appendLocalResult(call, callArgs, local.result, local.isError);
            assertChatToolProgress(exec);
          }
        }
      }

      if (structuredResponse && !completedStructuredOutput && !signal.aborted) {
        await completeTerminalOutput();
      }

      if (gate) {
        signal.throwIfAborted();
        const attempt = gate.beginAttempt();
        deps.emit("runtime:termination-gate", { runId: completionId, sessionId, attempt, phase: "validating" });
        const decision = await dispatchCompletionRuntimeHook(exec.runtimeHooks, "turn:stop", {
          terminationAttempt: attempt, correctionCycle: gate.snapshot().cycles,
          textLength: finalText.length, toolCallCount: toolCallsAccum.length,
          candidate: { text: finalText, ...(structuredResponse ? { output: JSON.parse(finalText) } : {}) },
        });
        signal.throwIfAborted();
        const feedback = gate.decide(decision, maxTurns - nextTurn);
        if (feedback !== undefined) {
          messages.push({ role: "user", content: feedback });
          finalText = "";
          completedStructuredOutput = false;
          deps.emit("runtime:termination-gate", { runId: completionId, sessionId, attempt, phase: "continuing" });
          continue gateLoop;
        }
        gateAccepted = true;
        deps.emit("runtime:termination-gate", { runId: completionId, sessionId, attempt, phase: "accepted" });
      }
      break gateLoop;
    }

      if (!signal.aborted) {
        const stopDecision = gate ? { action: "allow" as const } : await dispatchCompletionRuntimeHook(exec.runtimeHooks, "turn:stop", {
          textLength: finalText.length,
          toolCallCount: toolCallsAccum.length,
        });
        const stopError = runtimeHookDecisionError(stopDecision);
        if (stopError && stopDecision.action !== "stop") throw stopError;
        const stopFeedback = runtimeHookStopFeedback(stopDecision);
        if (stopFeedback && !structuredResponse) {
          const retry = await runChatStopFeedbackPhase({
            exec,
            modelSelection,
            primaryModel,
            primaryProviderOpts,
            reasoning,
            systemPrompt: fullSystemPrompt,
            messages,
            feedback: stopFeedback,
            signal,
            invocations,
          });
          if (retry.resolved) {
            m = retry.resolved.model;
            providerOpts = retry.resolved.providerOptions;
          }
          totalUsage = addChatUsage(totalUsage, retry.result.usage);
          finalReasoning = appendReasoningSummary(finalReasoning, retry.result.reasoning);
          lastProviderMetadata = retry.result.providerMetadata as Record<string, unknown> | undefined;
          const correction = retry.result.text;
          if (correction) {
            const separator = finalText ? "\n\n" : "";
            finalText += `${separator}${correction}`;
            if (outputMode !== "buffer") {
              await stream.writeSSE({ data: sseChunk(completionId, { content: `${separator}${correction}` }) });
            }
          }
          const retryStop = await dispatchCompletionRuntimeHook(exec.runtimeHooks, "turn:stop", {
            textLength: finalText.length,
            toolCallCount: toolCallsAccum.length,
            stopFeedbackRetry: 1,
          });
          const retryStopError = runtimeHookDecisionError(retryStop);
          if (retryStopError && retryStop.action !== "stop") throw retryStopError;
        }
        await finalizeOutput();
        suggestions = await suggestionsForCompletion(exec, finalText, signal);
        if (signal.aborted) return;
        // Once terminal events are visible, an immediate history read must
        // already contain the same final text and suggestion list.
        await persistResponse(true);
        if (suggestions.length > 0) {
          await stream.writeSSE({
            data: ssePolpoChunk(completionId, { suggestions, ...(assistantMsgId ? { suggestionsSource: { assistantMessageId: assistantMsgId } } : {}) }),
          });
        }
        await stream.writeSSE({ data: sseChunk(completionId, {}, "stop") });
        await stream.writeSSE({ data: "[DONE]" });
      }
    } catch (err) {
    if (gate && !gateAccepted) {
      finalText = "";
      deps.emit("runtime:termination-gate", { runId: completionId, sessionId, attempt: gate.snapshot().attempts, phase: callerSignal.aborted ? "cancelled" : "failed", code: err instanceof TerminationGateError ? err.code : "execution_failed" });
    }
    if (gate && signal.aborted && !callerSignal.aborted) err = new TerminationGateError("termination_gate_time_exhausted", "Termination gate time limit exhausted");
      await dispatchCompletionRuntimeHook(exec.runtimeHooks, "turn:error", {
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
      // Suppress AbortError — expected when client disconnects
      if ((err instanceof DOMException && err.name === "AbortError") || callerSignal.aborted) {
        // fall through to finally — no SSE error event needed
      } else {
        // Friendly model_not_found surface — gateway returns 404 for
        // renamed/deprecated SKUs (e.g. xai/grok-4-fast after the 4.1
        // rename). Without this catch the error propagates as a 500.
        const structuredOutputError = structuredOutputErrorEnvelope(err, structuredResponse);
        const guardrailError = guardrailErrorEnvelope(err);
        const runtimeError = completionRuntimeErrorEnvelope(err);
        const notFound = modelNotFoundEnvelope(err, m?.id, body.agent);
        if (err instanceof TerminationGateError) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: { code: err.code, message: err.message, type: "runtime_error" } }) });
          await stream.writeSSE({ data: "[DONE]" });
        } else if (structuredOutputError) {
          await stream.writeSSE({
            data: sseChunk(completionId, {}, "stop", { error: structuredOutputError }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        } else if (guardrailError) {
          finalText = guardrailError.message;
          outputPolicyApplied = true;
          await stream.writeSSE({
            data: sseChunk(completionId, {}, "stop", { error: guardrailError }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        } else if (runtimeError) {
          await stream.writeSSE({
            data: sseChunk(completionId, {}, "stop", { error: runtimeError.error }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        } else if (notFound) {
          await stream.writeSSE({
            data: sseChunk(completionId, {}, "stop", { error: notFound }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        } else {
          const error = modelErrorEnvelope(err);
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error }) });
          await stream.writeSSE({ data: "[DONE]" });
        }
      }
    } finally {
      // Always persist the assistant response — even on disconnect.
      // (Vault credentials are redacted inside persistAssistantMessage.)
      // Do not retry a failed final commit after exposing its error frame.
      try {
        if (!persistenceAttempted) await persistResponse();
      } finally {
        if (runtimeAgentStarted) {
          await dispatchCompletionRuntimeHook(exec.runtimeHooks, "agent:end", {
            source: "direct-chat",
            streaming: true,
            aborted: signal.aborted,
          }).catch(() => {});
        }
        await dispatchCompletionRuntimeHook(exec.runtimeHooks, "session:end", {
          streaming: true,
          aborted: signal.aborted,
        }).catch(() => {});
        await dispatchCompletionRuntimeHook(exec.runtimeHooks, "run:end", {
          streaming: true,
          aborted: signal.aborted,
        }).catch(() => {});
        // Notify consumer (e.g. metering) — fire-and-forget
        try {
          deps.onCompletionFinished?.({
            usage: totalUsage,
            model: m.id ?? m.provider,
            resolvedModel: completionResolvedModelInfo(m),
            agent: body.agent,
            sessionId: sessionId ?? undefined,
            user: body.user,
            providerMetadata: lastProviderMetadata,
            invocations: invocations.list(),
          });
        } catch { /* never fail on callback */ }
        // Close per-request resources (MCP transports, etc.). Errors
        // are intentionally swallowed — a stuck cleanup must not block
        // the response from finishing.
        if (onResponseFinished) {
          try {
            onResponseFinished().catch(() => {});
          } catch { /* never fail on cleanup callback */ }
        }
      }
    }
}

/** Non-streaming chat mode — single OpenAI-format JSON response. */
export async function runNonStreamingChatCompletion(c: any, exec: ChatCompletionExecution): Promise<any> {
  const callerSignal: AbortSignal = c.req.raw.signal;
  let signal = callerSignal;
  const {
    deps, body, completionId, agentMode, fullSystemPrompt: initialSystemPrompt,
    m: primaryModel, providerOpts: primaryProviderOpts,
    modelToolChoice, effectiveTools, effectiveToolExecutor, extraAiTools,
    isInteractiveFn, aiMessages, sessionStore, sessionId, onResponseFinished,
  } = exec;
  let fullSystemPrompt = initialSystemPrompt;
  const aiTools = mergeAiTools(exec);
  let m = primaryModel;
  let providerOpts = primaryProviderOpts;
  const modelSelection = exec.modelSelection ?? modelSelectionForResolvedModel(primaryModel);
  const reasoning = exec.agentConfig?.reasoning ?? deps.getConfig()?.settings?.reasoning;
  const gatePolicy = exec.runtimeHooks?.dispatcher?.getTerminationGatePolicy?.(exec.runtimeHooks);
  const gate = gatePolicy ? new TerminationGate(gatePolicy) : undefined;
  if (gate) signal = AbortSignal.any([callerSignal, AbortSignal.timeout(gate.remainingMs)]);
  if (gate && exec.runtimeHooks) exec = { ...exec, runtimeHooks: { ...exec.runtimeHooks, signal } };
  let gateAccepted = false;
  let nextTurn = 0;
  const maxTurns = exec.agentConfig?.maxTurns ?? MAX_TURNS;
  const structuredResponse = isStructuredResponseFormat(body.response_format);

  // Reserve placeholder so the message is visible even if the request is interrupted
  let assistantMsgId: string | null = null;
  if (sessionStore && sessionId) {
    const placeholder = exec.turnId
      ? await sessionStore.addMessage(sessionId, "assistant", "", {
          turnId: exec.turnId,
        })
      : await sessionStore.addMessage(sessionId, "assistant", "");
    assistantMsgId = placeholder.id;
  }

  const messages: any[] = [...aiMessages];
  let finalText = "";
  let finalReasoning = "";
  let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  const toolCallsAccum: any[] = [];
  let lastProviderMetadata: Record<string, unknown> | undefined;
  const invocations = new CompletionModelInvocationLedger();
  let outputPolicyApplied = false;
  let suggestions: ChatSuggestion[] = [];
  let canonicalTurnSucceeded = false;
  let clientToolCallId: string | undefined;
  let completedStructuredOutput = false;
  const finalizeOutput = async (validateStructured = true) => {
    if (outputPolicyApplied) return;
    finalText = await applyCompletionOutputPolicy({
      outputPolicy: deps.runOutputPolicy,
      text: finalText,
      mode: "enforce",
      runtimePlan: exec.runtimePlan,
      agent: body.agent,
      sessionId,
      signal: signal,
    });
    if (validateStructured) {
      finalText = await finalizeResponseFormatText(body.response_format, finalText);
    }
    signal.throwIfAborted();
    outputPolicyApplied = true;
  };
  const completeTerminalOutput = async () => {
    const terminal = await runChatTerminalOutputPhase({
      exec,
      modelSelection,
      primaryModel,
      primaryProviderOpts,
      reasoning,
      systemPrompt: fullSystemPrompt,
      messages,
      gate,
      onUsage: (usage) => { totalUsage = addChatUsage(totalUsage, usage); },
      invocations,
      signal: signal,
    });
    if (terminal.resolved) {
      m = terminal.resolved.model;
      providerOpts = terminal.resolved.providerOptions;
    }
    if (gate) await appendModelResponseMessages(messages, terminal.result, terminal.result.text, [], exec.contextTrust);
    finalReasoning = appendReasoningSummary(finalReasoning, terminal.result.reasoning);
    lastProviderMetadata = terminal.result.providerMetadata as Record<string, unknown> | undefined;
    finalText = await serializeModelOutput(
      body.response_format,
      terminal.result.output,
      terminal.result.text,
    );
    completedStructuredOutput = true;
  };

  let runtimeAgentStarted = false;
  try {
    await dispatchCompletionRuntimeHook(exec.runtimeHooks, "run:start", { streaming: false });
    await dispatchCompletionRuntimeHook(
      exec.runtimeHooks,
      exec.sessionResumed ? "session:resume" : "session:start",
      { streaming: false },
    );
    const spawnDecision = await dispatchCompletionRuntimeHook(exec.runtimeHooks, "agent:spawn", {
      source: "direct-chat",
      streaming: false,
    });
    const spawnError = runtimeHookDecisionError(spawnDecision);
    if (spawnError) throw spawnError;
    runtimeAgentStarted = true;
    const inputDecision = await dispatchCompletionRuntimeHook(exec.runtimeHooks, "input:before", {
      messageCount: messages.length,
      streaming: false,
    });
    const inputError = runtimeHookDecisionError(inputDecision);
    if (inputError) throw inputError;
    const inputContext = runtimeHookModifiedString(inputDecision, "context");
    if (inputContext) fullSystemPrompt += `\n\n## Runtime hook context\n\n${inputContext}`;
    gateLoop: while (true) {
      if (
        structuredResponse
        && Object.keys(aiTools).length === 0
      ) {
        nextTurn += 1;
          await completeTerminalOutput();
      }

      for (; !completedStructuredOutput && nextTurn < maxTurns;) {
          const turn = nextTurn++;
          gate?.assertAvailable();
          signal.throwIfAborted();
        // Compact context if approaching the model's context window limit.
        // Under threshold this is just a cheap token estimation — zero LLM calls.
        await dispatchCompletionRuntimeHook(exec.runtimeHooks, "context:compact:before", {
          messageCount: messages.length,
          model: m.id ?? m.provider,
        });
        const compactionResult = await compactIfNeeded({
          systemPrompt: fullSystemPrompt,
          messages,
          tools: exec.activeCompactionTools?.() ?? effectiveTools,
          config: {
            contextWindow: m.contextWindow ?? 200_000,
            maxOutputTokens: m.maxTokens ?? 8192,
          },
          summarize: buildSummarizeFn(m, providerOpts, { gate, signal, invocations, onUsage: (usage) => { totalUsage = addChatUsage(totalUsage, usage); } }),
          mode: "chat",
          // Non-streaming: no SSE to write to, compaction is silent
        });
        if (compactionResult.compacted) {
          messages.splice(0, messages.length, ...compactionResult.messages);
          await dispatchCompletionRuntimeHook(exec.runtimeHooks, "context:compact:after", {
            messageCount: messages.length,
            compacted: true,
          });
        }

        const resolvedAttempts = new Map<number, { model: ResolvedModelInfo; providerOptions?: Record<string, any> }>();
        const turnResult = await runCompletionRuntimeHookOperation({
          hooks: exec.runtimeHooks,
          before: "model:before",
          after: "model:after",
          error: "model:error",
          data: { phase: "operational", turn, model: m.id ?? m.provider },
          resultData: (modelResult: any) => ({
            finishReason: modelResult.finishReason,
            toolCallCount: modelResult.toolCalls?.length ?? 0,
          }),
          operation: () => runModelPolicyTurn({
          selection: modelSelection,
          resolveAttempt: async (attempt) => {
            const resolvedAttempt = attempt.index === 0 || !agentMode || !exec.agentConfig
              ? { model: primaryModel, providerOptions: primaryProviderOpts }
              : await deps.resolveAgentModel(agentConfigForModelAttempt(exec.agentConfig, attempt.model), reasoning);
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
            return dispatchCompletionModelPolicyHook(exec.runtimeHooks, event);
          },
          system: fullSystemPrompt,
          messages,
          tools: aiTools,
          ...(exec.activeToolNames ? { activeTools: exec.activeToolNames() } : {}),
          ...(modelToolChoice ? { toolChoice: modelToolChoice as any } : {}),
          ...(body.parallel_tool_calls !== undefined
            ? { parallelToolCalls: body.parallel_tool_calls }
            : {}),
          abortSignal: signal,
          }),
        });
        invocations.record("operational", turnResult);
        signal.throwIfAborted();
        finalReasoning = appendReasoningSummary(finalReasoning, turnResult.reasoning);

        const turnText = turnResult.text;
        const selectedResolved = resolvedAttempts.get(turnResult.selectedAttempt.index);
        if (selectedResolved) {
          m = selectedResolved.model;
          providerOpts = selectedResolved.providerOptions;
        }
        const usage = turnResult.usage;
        totalUsage = addChatUsage(totalUsage, usage);
          gate?.recordUsage(usage);
        lastProviderMetadata = turnResult.providerMetadata as Record<string, unknown> | undefined;

        await appendModelResponseMessages(
          messages,
          turnResult,
          turnText,
          turnResult.toolCalls,
          exec.contextTrust ?? "off",
        );

        if (!structuredResponse) finalText += turnText;

        const toolCalls = turnResult.toolCalls;
        if (toolCalls.length === 0) {
          if (structuredResponse) await completeTerminalOutput();
          break;
        }

        const dispatchableToolCalls = toolCalls.filter(
          (call) => !isInvalidModelToolCall(call),
        );
        for (const call of toolCalls.filter(isInvalidModelToolCall)) {
          toolCallsAccum.push(invalidModelToolCallEvent(call));
        }
        if (dispatchableToolCalls.length === 0) continue;

        // ── Client-side tools — return to client as standard tool_calls ──
        const clientSideCall = selectRequestClientToolCall(
          dispatchableToolCalls,
          clientSideToolNames(exec),
        );
        if (clientSideCall) {
          await finalizeOutput(false);
          signal.throwIfAborted();
          clientToolCallId = clientSideCall.toolCallId;
          toolCallsAccum.push({
            id: clientSideCall.toolCallId,
            name: clientSideCall.toolName,
            arguments: clientSideCall.input,
            state: "interrupted",
          });
          return c.json({
            id: completionId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "polpo",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: finalText || null,
                tool_calls: [{
                  id: clientSideCall.toolCallId,
                  type: "function",
                  function: {
                    name: clientSideCall.toolName,
                    arguments: JSON.stringify(clientSideCall.input),
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
            usage: {
              prompt_tokens: totalUsage.inputTokens ?? 0,
              completion_tokens: totalUsage.outputTokens ?? 0,
              total_tokens: totalUsage.totalTokens ?? 0,
            },
          });
        }

        // Check for interactive tools — only in orchestrator mode (agents don't have interactive tools)
        const interactiveCall = agentMode ? undefined : dispatchableToolCalls.find((tc: any) => isInteractiveFn?.(tc.toolName));
        if (interactiveCall) {
          await finalizeOutput(false);
          signal.throwIfAborted();
          // Persisted by finally before this async function resolves.
          toolCallsAccum.push({
            id: interactiveCall.toolCallId,
            name: interactiveCall.toolName,
            arguments: interactiveCall.input,
            state: "interrupted",
          });

          const baseResponse = {
            id: completionId,
            object: "chat.completion" as const,
            created: Math.floor(Date.now() / 1000),
            model: "polpo" as const,
            usage: {
              prompt_tokens: totalUsage.inputTokens ?? 0,
              completion_tokens: totalUsage.outputTokens ?? 0,
              total_tokens: totalUsage.totalTokens ?? 0,
            },
          };

          if (interactiveCall.toolName === "ask_user") {
            const questions = (interactiveCall.input as any)?.questions as any[] ?? [];
            return c.json({
              ...baseResponse,
              choices: [{
                index: 0,
                message: { role: "assistant" as const, content: finalText },
                finish_reason: "ask_user" as const,
                ask_user: { questions },
              }],
            });
          }

          if (interactiveCall.toolName === "create_mission") {
            const args = interactiveCall.input as Record<string, unknown>;
            let missionData: unknown;
            try { missionData = JSON.parse(args.data as string); } catch { missionData = args.data; }
            return c.json({
              ...baseResponse,
              choices: [{
                index: 0,
                message: { role: "assistant" as const, content: finalText },
                finish_reason: "mission_preview" as const,
                mission_preview: {
                  name: args.name as string,
                  data: missionData,
                  prompt: args.prompt as string | undefined,
                },
              }],
            });
          }

          if (interactiveCall.toolName === "set_vault_entry") {
            const args = interactiveCall.input as Record<string, unknown>;
            return c.json({
              ...baseResponse,
              choices: [{
                index: 0,
                message: { role: "assistant" as const, content: finalText },
                finish_reason: "vault_preview" as const,
                vault_preview: {
                  agent: args.agent as string,
                  service: args.service as string,
                  type: args.type as string,
                  label: args.label as string | undefined,
                  credentials: args.credentials as Record<string, string>,
                },
              }],
            });
          }

          if (interactiveCall.toolName === "open_file") {
            const args = interactiveCall.input as Record<string, unknown>;
            return c.json({
              ...baseResponse,
              choices: [{
                index: 0,
                message: { role: "assistant" as const, content: finalText },
                finish_reason: "open_file" as const,
                open_file: {
                  path: args.path as string,
                },
              }],
            });
          }

          if (interactiveCall.toolName === "navigate_to") {
            const args = interactiveCall.input as Record<string, unknown>;
            return c.json({
              ...baseResponse,
              choices: [{
                index: 0,
                message: { role: "assistant" as const, content: finalText },
                finish_reason: "navigate_to" as const,
                navigate_to: {
                  target: args.target as string,
                  id: args.id as string | undefined,
                  name: args.name as string | undefined,
                  path: args.path as string | undefined,
                  highlight: args.highlight as string | undefined,
                },
              }],
            });
          }

          if (interactiveCall.toolName === "open_tab") {
            const args = interactiveCall.input as Record<string, unknown>;
            return c.json({
              ...baseResponse,
              choices: [{
                index: 0,
                message: { role: "assistant" as const, content: finalText },
                finish_reason: "open_tab" as const,
                open_tab: {
                  url: args.url as string,
                  label: args.label as string | undefined,
                },
              }],
            });
          }
          // Note: finally block persists finalText + toolCallsAccum
        }

        // Provider tools (extraAiTools) are executed by the SDK / gateway.
        // Their tool results are already preserved in responseMessages,
        // so only record them for observability and skip local dispatch.
        const providerToolNames = new Set(Object.keys(extraAiTools ?? {}));
        const providerToolResults = indexToolResultsByCallId(turnResult.toolResults as any[] | undefined);

        const appendLocalResult = (
          call: { toolCallId: string; toolName: string },
          callArgs: Record<string, unknown>,
          toolResult: string,
          isError: boolean,
        ) => {
          emitFileChanged(call.toolName, callArgs, toolResult, deps.emit);
          toolCallsAccum.push({
            id: call.toolCallId,
            name: call.toolName,
            arguments: callArgs,
            result: toolResult,
            state: isError ? "error" : "completed",
          });
          const modelResult = exec.contextTrust === "enforce"
            ? renderRuntimeToolResult(call.toolName, call.toolCallId, toolResult)
            : toolResult;
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

        if (body.parallel_tool_calls === true) {
          const localCalls = dispatchableToolCalls
            .filter((call) => !providerToolNames.has(call.toolName))
            .map((call) => ({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input as Record<string, unknown>,
            }));
          const localResults = await executeCompletionToolBatch({
            calls: localCalls,
            executor: effectiveToolExecutor,
            signal: signal,
          });
          let localResultIndex = 0;
          for (const call of dispatchableToolCalls) {
            if (providerToolNames.has(call.toolName)) {
              recordProviderToolCall(toolCallsAccum, call, providerToolResults);
              continue;
            }
            const local = localResults[localResultIndex++]!;
            appendLocalResult(call, local.input, local.result, local.isError);
          }
          await dispatchCompletionRuntimeHook(exec.runtimeHooks, "tool:batch:after", {
            count: localResults.length,
            tools: localCalls.map((call) => call.toolName),
          });
          assertChatToolProgress(exec);
        } else {
          for (const call of dispatchableToolCalls) {
            const callArgs = call.input as Record<string, unknown>;
            if (providerToolNames.has(call.toolName)) {
              recordProviderToolCall(toolCallsAccum, call, providerToolResults);
              continue;
            }
            const local = await executeCompletionToolCall({
              call: {
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: callArgs,
              },
              executor: effectiveToolExecutor,
              signal: signal,
            });
            appendLocalResult(call, callArgs, local.result, local.isError);
            assertChatToolProgress(exec);
          }
        }
      }

      if (structuredResponse && !completedStructuredOutput && !signal.aborted) {
        await completeTerminalOutput();
      }

      if (gate) {
        signal.throwIfAborted();
        const attempt = gate.beginAttempt();
        deps.emit("runtime:termination-gate", { runId: completionId, sessionId, attempt, phase: "validating" });
        const decision = await dispatchCompletionRuntimeHook(exec.runtimeHooks, "turn:stop", {
          terminationAttempt: attempt, correctionCycle: gate.snapshot().cycles,
          textLength: finalText.length, toolCallCount: toolCallsAccum.length,
          candidate: { text: finalText, ...(structuredResponse ? { output: JSON.parse(finalText) } : {}) },
        });
        signal.throwIfAborted();
        const feedback = gate.decide(decision, maxTurns - nextTurn);
        if (feedback !== undefined) {
          messages.push({ role: "user", content: feedback });
          finalText = "";
          completedStructuredOutput = false;
          deps.emit("runtime:termination-gate", { runId: completionId, sessionId, attempt, phase: "continuing" });
          continue gateLoop;
        }
        gateAccepted = true;
        deps.emit("runtime:termination-gate", { runId: completionId, sessionId, attempt, phase: "accepted" });
      }
      break gateLoop;
    }

    const stopDecision = gate ? { action: "allow" as const } : await dispatchCompletionRuntimeHook(exec.runtimeHooks, "turn:stop", {
      textLength: finalText.length,
      toolCallCount: toolCallsAccum.length,
    });
    const stopError = runtimeHookDecisionError(stopDecision);
    if (stopError && stopDecision.action !== "stop") throw stopError;
    const stopFeedback = runtimeHookStopFeedback(stopDecision);
    if (stopFeedback && !structuredResponse) {
      const retry = await runChatStopFeedbackPhase({
        exec,
        modelSelection,
        primaryModel,
        primaryProviderOpts,
        reasoning,
        systemPrompt: fullSystemPrompt,
        messages,
        feedback: stopFeedback,
        signal: signal,
        invocations,
      });
      if (retry.resolved) {
        m = retry.resolved.model;
        providerOpts = retry.resolved.providerOptions;
      }
      totalUsage = addChatUsage(totalUsage, retry.result.usage);
      finalReasoning = appendReasoningSummary(finalReasoning, retry.result.reasoning);
      lastProviderMetadata = retry.result.providerMetadata as Record<string, unknown> | undefined;
      if (retry.result.text) finalText += `${finalText ? "\n\n" : ""}${retry.result.text}`;
      const retryStop = await dispatchCompletionRuntimeHook(exec.runtimeHooks, "turn:stop", {
        textLength: finalText.length,
        toolCallCount: toolCallsAccum.length,
        stopFeedbackRetry: 1,
      });
      const retryStopError = runtimeHookDecisionError(retryStop);
      if (retryStopError && retryStop.action !== "stop") throw retryStopError;
    }
    await finalizeOutput();
    suggestions = await suggestionsForCompletion(exec, finalText, signal);
    canonicalTurnSucceeded = !signal.aborted;
    return c.json(completionResponse(
      completionId,
      finalText,
      totalUsage,
      suggestions.length > 0 ? { polpo: { suggestions, ...(assistantMsgId ? { suggestionsSource: { assistantMessageId: assistantMsgId } } : {}) } } : undefined,
    ));
  } catch (err) {
    if (gate && !gateAccepted) {
      finalText = "";
      deps.emit("runtime:termination-gate", { runId: completionId, sessionId, attempt: gate.snapshot().attempts, phase: callerSignal.aborted ? "cancelled" : "failed", code: err instanceof TerminationGateError ? err.code : "execution_failed" });
    }
    if (gate && signal.aborted && !callerSignal.aborted) err = new TerminationGateError("termination_gate_time_exhausted", "Termination gate time limit exhausted");
    await dispatchCompletionRuntimeHook(exec.runtimeHooks, "turn:error", {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    // Friendly model_not_found surface — gateway returns 404 for
    // renamed/deprecated SKUs (e.g. xai/grok-4-fast after the 4.1
    // rename). Without this catch the error propagates as a 500.
    const structuredOutputError = structuredOutputErrorEnvelope(err, structuredResponse);
    if (err instanceof TerminationGateError) return c.json({ error: { code: err.code, message: err.message, type: "runtime_error" } }, 409);
    if (structuredOutputError) {
      return c.json({ error: structuredOutputError }, 400 as any);
    }
    const guardrailError = guardrailErrorEnvelope(err);
    if (guardrailError) {
      finalText = guardrailError.message;
      outputPolicyApplied = true;
      return c.json(
        { error: guardrailError },
        (guardrailError.code === "guardrail_approval_required" ? 409 : 403) as any,
      );
    }
    const runtimeError = completionRuntimeErrorEnvelope(err);
    if (runtimeError) {
      return c.json({ error: runtimeError.error }, runtimeError.status as any);
    }
    const notFound = modelNotFoundEnvelope(err, m?.id, body.agent);
    if (notFound) {
      return c.json({ error: notFound }, 400 as any);
    }
    const error = modelErrorEnvelope(err);
    return c.json({ error }, 400 as any);
  } finally {
    if (runtimeAgentStarted) {
      await dispatchCompletionRuntimeHook(exec.runtimeHooks, "agent:end", {
        source: "direct-chat",
        streaming: false,
        aborted: signal.aborted,
      }).catch(() => {});
    }
    await dispatchCompletionRuntimeHook(exec.runtimeHooks, "session:end", {
      streaming: false,
      aborted: signal.aborted,
    }).catch(() => {});
    await dispatchCompletionRuntimeHook(exec.runtimeHooks, "run:end", {
      streaming: false,
      aborted: signal.aborted,
    }).catch(() => {});
    try {
      // Always persist the final text + tool calls — even on early return
      // (ask_user) or error. Vault credentials are redacted inside the helper.
      const committedTurn = await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCallsAccum, {
        emptyFallback: "[Response interrupted]",
        ...(suggestions.length > 0 ? { suggestions } : {}),
        reasoning: finalReasoning,
        requestClientTools: exec.requestClientTools,
        clientToolCallId,
        ...(canonicalTurnSucceeded && exec.canonicalTurn
          ? { canonicalTurn: exec.canonicalTurn }
          : {}),
      });
      notifyCanonicalTurnCommitted(deps.onCanonicalTurnCommitted, committedTurn);
    } finally {
      // Usage and per-request resources must be finalized even if transcript
      // persistence is temporarily unavailable.
      try {
        deps.onCompletionFinished?.({
          usage: totalUsage,
          model: m.id ?? m.provider,
          resolvedModel: completionResolvedModelInfo(m),
          agent: body.agent,
          sessionId: sessionId ?? undefined,
          user: body.user,
          providerMetadata: lastProviderMetadata,
          invocations: invocations.list(),
        });
      } catch { /* never fail on callback */ }
      if (onResponseFinished) {
        try {
          onResponseFinished().catch(() => {});
        } catch { /* never fail on cleanup callback */ }
      }
    }
  }
}
