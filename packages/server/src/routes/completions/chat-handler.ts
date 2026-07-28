/**
 * Standard chat-mode execution for the completions endpoint.
 *
 * Owns the multi-turn tool loop over the shared model-turn primitive in both
 * streaming (SSE) and non-streaming variants: client-side tools,
 * interactive orchestrator tools, provider-executed tools, context
 * compaction, session persistence, and metering callbacks.
 */

import { streamSSE } from "hono/streaming";
import {
  compactIfNeeded,
  type CompactionEvent,
  type ModelSelection,
  type RuntimePlan,
} from "@polpo-ai/core";
import { runModelPolicyTurn } from "@polpo-ai/llm";
import type { LanguageModelUsage } from "ai";
import type { RuntimeSandboxOptions } from "@polpo-ai/core";
import type { CompletionRouteDeps } from "../completions.js";
import {
  agentConfigForModelAttempt,
  buildSummarizeFn,
  completionResolvedModelInfo,
  MAX_TURNS,
  modelSelectionForResolvedModel,
  type ResolvedModelInfo,
} from "./agent-step-runner.js";
import { appendModelResponseMessages } from "./message-mapping.js";
import {
  completionResponse,
  guardrailErrorEnvelope,
  modelErrorEnvelope,
  modelNotFoundEnvelope,
  sseChunk,
} from "./sse.js";
import {
  CLIENT_SIDE_TOOLS,
  CLIENT_SIDE_TOOL_NAMES,
  emitFileChanged,
  indexToolResultsByCallId,
  persistAssistantMessage,
  recordProviderToolCall,
  toAITools,
} from "./tool-mapping.js";
import type { CompletionToolExecutor } from "./tool-guardrails.js";
import {
  applyCompletionOutputPolicy,
  streamingOutputPolicyMode,
} from "./output-guardrails.js";

/** Resolved execution context for a standard (non-loop) chat completion. */
export interface ChatCompletionExecution {
  deps: CompletionRouteDeps;
  body: { stream?: boolean; agent?: string; user?: string; sandbox?: RuntimeSandboxOptions };
  completionId: string;
  /** Resolved agent config (agent-direct mode). Used by chat-via-executeRun
   *  (F1c) to build the RunnerConfig. Undefined in orchestrator mode. */
  agentConfig: any;
  agentMode: boolean;
  fullSystemPrompt: string;
  m: ResolvedModelInfo;
  providerOpts?: Record<string, any>;
  modelSelection?: ModelSelection;
  modelToolChoice?: unknown;
  effectiveTools: any[];
  effectiveToolExecutor: CompletionToolExecutor;
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
  /** Frozen, secret-free runtime decision emitted before provider/tool resolution. */
  runtimePlan?: RuntimePlan;
  /**
   * Resource cleanup hook — set when an agent's tool resolver opens
   * long-lived connections (today: MCP transports). Invoked exactly
   * once after the response finishes, regardless of streaming/non-
   * streaming/error path. Wrapped in try/catch by the caller so a
   * misbehaving cleanup can't leak the request itself.
   */
  onResponseFinished?: () => Promise<void>;
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
    ...CLIENT_SIDE_TOOLS,
  };
}

/** Streaming chat mode — SSE stream of OpenAI-format chunks. */
export function streamChatCompletion(c: any, exec: ChatCompletionExecution): any {
  const {
    deps, body, completionId, agentMode, fullSystemPrompt,
    m: primaryModel, providerOpts: primaryProviderOpts,
    modelToolChoice, effectiveTools, effectiveToolExecutor, extraAiTools,
    isInteractiveFn, aiMessages, sessionStore, sessionId, onResponseFinished,
  } = exec;
  const aiTools = mergeAiTools(exec);
  let m = primaryModel;
  let providerOpts = primaryProviderOpts;
  const modelSelection = exec.modelSelection ?? modelSelectionForResolvedModel(primaryModel);
  const reasoning = exec.agentConfig?.reasoning ?? deps.getConfig()?.settings?.reasoning;
  const outputMode = streamingOutputPolicyMode(deps.runOutputPolicy);

  return streamSSE(c, async (stream) => {
    // Abort controller: cancelled when the client disconnects (closes SSE)
    const abortController = new AbortController();
    stream.onAbort(() => { abortController.abort(); });

    // SSE heartbeat: write a comment (`: ping`) every 20s to prevent
    // proxy idle timeouts (nginx 60s, Cloudflare 100s) during long tool
    // execution pauses. SSE comments are invisible to compliant clients.
    // WritableStream serializes writes, so heartbeats cannot interleave
    // mid-payload with writeSSE calls.
    const heartbeatInterval = setInterval(() => {
      if (abortController.signal.aborted) {
        clearInterval(heartbeatInterval);
        return;
      }
      stream.write(": ping\n\n").catch(() => {
        clearInterval(heartbeatInterval);
      });
    }, 20_000);

    await stream.writeSSE({ data: sseChunk(completionId, { role: "assistant" }) });

    // Reserve a placeholder message in the store BEFORE streaming.
    // This guarantees the assistant message exists even if the client disconnects.
    let assistantMsgId: string | null = null;
    if (sessionStore && sessionId) {
      const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
      assistantMsgId = placeholder.id;
    }

    const messages: any[] = [...aiMessages];
    let finalText = "";
    let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
    const toolCallsAccum: any[] = [];
    let lastProviderMetadata: Record<string, unknown> | undefined;
    let outputPolicyApplied = false;
    const finalizeOutput = async () => {
      if (outputPolicyApplied) return;
      finalText = await applyCompletionOutputPolicy({
        outputPolicy: deps.runOutputPolicy,
        text: finalText,
        mode: outputMode === "buffer" ? "enforce" : "audit",
        runtimePlan: exec.runtimePlan,
        agent: body.agent,
        sessionId,
        signal: abortController.signal,
      });
      outputPolicyApplied = true;
      if (outputMode === "buffer" && finalText) {
        await stream.writeSSE({ data: sseChunk(completionId, { content: finalText }) });
      }
    };

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        // Bail out early if the client already disconnected
        if (abortController.signal.aborted) break;

        // Compact context if approaching the model's context window limit.
        // Under threshold this is just a cheap token estimation — zero LLM calls.
        const compactionResult = await compactIfNeeded({
          systemPrompt: fullSystemPrompt,
          messages,
          tools: effectiveTools,
          config: {
            contextWindow: m.contextWindow ?? 200_000,
            maxOutputTokens: m.maxTokens ?? 8192,
          },
          summarize: buildSummarizeFn(m, providerOpts),
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
        }

        let turnText = "";
        let streamError: string | undefined;
        // Per-tool-call streaming state for this turn: the tool name (learned
        // at tool-input-start) and the raw args JSON accumulated from the
        // token-by-token input deltas, so the UI can render the call as it
        // builds up instead of waiting for the whole turn to finish.
        const toolCallNames = new Map<string, string>();
        const toolCallArgsText = new Map<string, string>();
        const resolvedAttempts = new Map<number, { model: ResolvedModelInfo; providerOptions?: Record<string, any> }>();

        const result = await runModelPolicyTurn({
          selection: modelSelection,
          resolveAttempt: async (attempt) => {
            const resolvedAttempt = attempt.index === 0 || !agentMode || !exec.agentConfig
              ? { model: primaryModel, providerOptions: primaryProviderOpts }
              : await deps.resolveAgentModel(agentConfigForModelAttempt(exec.agentConfig, attempt.model), reasoning);
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
          abortSignal: abortController.signal,
        }, async (event) => {
          if (abortController.signal.aborted) return;
          if (event.type === "reasoning-delta") {
            await stream.writeSSE({ data: sseChunk(completionId, {}, null, { thinking: event.text }) });
          } else if (event.type === "text-delta") {
            turnText += event.text;
            finalText += event.text;
            if (outputMode !== "buffer") {
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
            // Stream the argument tokens as they arrive. Accumulate the raw
            // JSON and forward it so the client can show the tool input
            // building up live. Still "preparing": args aren't final yet.
            const acc = (toolCallArgsText.get(event.id) ?? "") + event.delta;
            toolCallArgsText.set(event.id, acc);
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, {
                tool_call: {
                  id: event.id,
                  name: toolCallNames.get(event.id) ?? "",
                  state: "preparing",
                  argumentsText: acc,
                },
              }),
            });
          } else if (event.type === "finish") {
            // Capture error from finish reason if applicable
            if (event.finishReason === "error") {
              streamError = "Model returned an error";
            }
          }
        });

        // If aborted, stop the loop — skip error/tool processing
        if (abortController.signal.aborted) {
          break;
        }

        if (streamError) {
          finalText += `\n\nError: ${streamError}`;
          if (outputMode !== "buffer") {
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
        totalUsage = {
          inputTokens: (totalUsage.inputTokens ?? 0) + (usage.inputTokens ?? 0),
          outputTokens: (totalUsage.outputTokens ?? 0) + (usage.outputTokens ?? 0),
          totalTokens: (totalUsage.totalTokens ?? 0) + (usage.totalTokens ?? 0),
        } as LanguageModelUsage;
        lastProviderMetadata = result.providerMetadata as Record<string, unknown> | undefined;

        await appendModelResponseMessages(messages, result, turnText, toolCalls);

        if (toolCalls.length === 0) break;

        // ── Client-side tools — return to client as standard tool_calls ──
        const clientSideCall = toolCalls.find((tc: any) => CLIENT_SIDE_TOOL_NAMES.has(tc.toolName));
        if (clientSideCall) {
          // Persist for session history
          toolCallsAccum.push({
            id: clientSideCall.toolCallId,
            name: clientSideCall.toolName,
            arguments: clientSideCall.input,
            state: "interrupted",
          });
          await finalizeOutput();
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
        const interactiveCall = agentMode ? undefined : toolCalls.find((tc: any) => isInteractiveFn?.(tc.toolName));
        if (interactiveCall) {
          // Persist the interactive tool call so it survives session reload
          toolCallsAccum.push({
            id: interactiveCall.toolCallId,
            name: interactiveCall.toolName,
            arguments: interactiveCall.input,
            state: "interrupted",
          });
          await finalizeOutput();

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
          return; // finally block will persist whatever finalText we have
        }

        // Provider tools (extraAiTools) are executed by the SDK / gateway.
        // Their tool results are already preserved in responseMessages,
        // so only record them for observability and skip local dispatch.
        const providerToolNames = new Set(Object.keys(extraAiTools ?? {}));
        const providerToolResults = indexToolResultsByCallId(result.toolResults as any[] | undefined);

        for (const call of toolCalls) {
          // Stop executing tools if client disconnected
          if (abortController.signal.aborted) break;

          const callArgs = call.input as Record<string, unknown>;

          if (providerToolNames.has(call.toolName)) {
            recordProviderToolCall(toolCallsAccum, call, providerToolResults);
            continue;
          }

          // Notify client that a tool is being called
          await stream.writeSSE({
            data: sseChunk(completionId, {}, null, {
              tool_call: { id: call.toolCallId, name: call.toolName, arguments: callArgs, state: "calling" },
            }),
          });

          const result = await effectiveToolExecutor(call.toolName, callArgs, {
            callId: call.toolCallId,
            signal: abortController.signal,
          });
          const isError = result.startsWith("Error:");
          emitFileChanged(call.toolName, callArgs, result, deps.emit);

          // Accumulate for persistence
          toolCallsAccum.push({
            id: call.toolCallId,
            name: call.toolName,
            arguments: callArgs,
            result,
            state: isError ? "error" : "completed",
          });

          // Notify client with tool result (skip if aborted mid-tool)
          if (!abortController.signal.aborted) {
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, {
                tool_call: { id: call.toolCallId, name: call.toolName, result, state: isError ? "error" : "completed" },
              }),
            });
          }

          // Push tool result message in AI SDK format
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

      if (!abortController.signal.aborted) {
        await finalizeOutput();
        await stream.writeSSE({ data: sseChunk(completionId, {}, "stop") });
        await stream.writeSSE({ data: "[DONE]" });
      }
    } catch (err) {
      // Suppress AbortError — expected when client disconnects
      if ((err instanceof DOMException && err.name === "AbortError") || abortController.signal.aborted) {
        // fall through to finally — no SSE error event needed
      } else {
        // Friendly model_not_found surface — gateway returns 404 for
        // renamed/deprecated SKUs (e.g. xai/grok-4-fast after the 4.1
        // rename). Without this catch the error propagates as a 500.
        const guardrailError = guardrailErrorEnvelope(err);
        const notFound = modelNotFoundEnvelope(err, m?.id, body.agent);
        if (guardrailError) {
          finalText = guardrailError.message;
          outputPolicyApplied = true;
          await stream.writeSSE({
            data: sseChunk(completionId, {}, "stop", { error: guardrailError }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        } else if (notFound) {
          await stream.writeSSE({
            data: sseChunk(completionId, {}, "stop", { error: notFound }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        } else {
          const error = modelErrorEnvelope(err);
          const text = `Model request failed: ${error.message}`;
          finalText = outputMode === "buffer" ? text : finalText + text;
          await stream.writeSSE({ data: sseChunk(completionId, { content: text }) });
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error }) });
          await stream.writeSSE({ data: "[DONE]" });
        }
      }
    } finally {
      clearInterval(heartbeatInterval);
      // Always persist the assistant response — even on disconnect.
      // (Vault credentials are redacted inside persistAssistantMessage.)
      await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCallsAccum);
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
        });
      } catch { /* never fail on callback */ }
      // Close per-request resources (MCP transports, etc.). Errors
      // are intentionally swallowed — a stuck cleanup must not block
      // the response from finishing.
      if (onResponseFinished) {
        onResponseFinished().catch(() => {});
      }
    }
  }) as any;
}

/** Non-streaming chat mode — single OpenAI-format JSON response. */
export async function runNonStreamingChatCompletion(c: any, exec: ChatCompletionExecution): Promise<any> {
  const {
    deps, body, completionId, agentMode, fullSystemPrompt,
    m: primaryModel, providerOpts: primaryProviderOpts,
    modelToolChoice, effectiveTools, effectiveToolExecutor, extraAiTools,
    isInteractiveFn, aiMessages, sessionStore, sessionId, onResponseFinished,
  } = exec;
  const aiTools = mergeAiTools(exec);
  let m = primaryModel;
  let providerOpts = primaryProviderOpts;
  const modelSelection = exec.modelSelection ?? modelSelectionForResolvedModel(primaryModel);
  const reasoning = exec.agentConfig?.reasoning ?? deps.getConfig()?.settings?.reasoning;

  // Reserve placeholder so the message is visible even if the request is interrupted
  let assistantMsgId: string | null = null;
  if (sessionStore && sessionId) {
    const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
    assistantMsgId = placeholder.id;
  }

  const messages: any[] = [...aiMessages];
  let finalText = "";
  let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  const toolCallsAccum: any[] = [];
  let lastProviderMetadata: Record<string, unknown> | undefined;
  let outputPolicyApplied = false;
  const finalizeOutput = async () => {
    if (outputPolicyApplied) return;
    finalText = await applyCompletionOutputPolicy({
      outputPolicy: deps.runOutputPolicy,
      text: finalText,
      mode: "enforce",
      runtimePlan: exec.runtimePlan,
      agent: body.agent,
      sessionId,
    });
    outputPolicyApplied = true;
  };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Compact context if approaching the model's context window limit.
      // Under threshold this is just a cheap token estimation — zero LLM calls.
      const compactionResult = await compactIfNeeded({
        systemPrompt: fullSystemPrompt,
        messages,
        tools: effectiveTools,
        config: {
          contextWindow: m.contextWindow ?? 200_000,
          maxOutputTokens: m.maxTokens ?? 8192,
        },
        summarize: buildSummarizeFn(m, providerOpts),
        mode: "chat",
        // Non-streaming: no SSE to write to, compaction is silent
      });
      if (compactionResult.compacted) {
        messages.splice(0, messages.length, ...compactionResult.messages);
      }

      const resolvedAttempts = new Map<number, { model: ResolvedModelInfo; providerOptions?: Record<string, any> }>();
      const turnResult = await runModelPolicyTurn({
        selection: modelSelection,
        resolveAttempt: async (attempt) => {
          const resolvedAttempt = attempt.index === 0 || !agentMode || !exec.agentConfig
            ? { model: primaryModel, providerOptions: primaryProviderOpts }
            : await deps.resolveAgentModel(agentConfigForModelAttempt(exec.agentConfig, attempt.model), reasoning);
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
      });

      const turnText = turnResult.text;
      const selectedResolved = resolvedAttempts.get(turnResult.selectedAttempt.index);
      if (selectedResolved) {
        m = selectedResolved.model;
        providerOpts = selectedResolved.providerOptions;
      }
      const usage = turnResult.usage;
      totalUsage = {
        inputTokens: (totalUsage.inputTokens ?? 0) + (usage.inputTokens ?? 0),
        outputTokens: (totalUsage.outputTokens ?? 0) + (usage.outputTokens ?? 0),
        totalTokens: (totalUsage.totalTokens ?? 0) + (usage.totalTokens ?? 0),
      } as LanguageModelUsage;
      lastProviderMetadata = turnResult.providerMetadata as Record<string, unknown> | undefined;

      await appendModelResponseMessages(messages, turnResult, turnText, turnResult.toolCalls);

      finalText += turnText;

      const toolCalls = turnResult.toolCalls;
      if (toolCalls.length === 0) break;

      // ── Client-side tools — return to client as standard tool_calls ──
      const clientSideCall = toolCalls.find((tc: any) => CLIENT_SIDE_TOOL_NAMES.has(tc.toolName));
      if (clientSideCall) {
        toolCallsAccum.push({
          id: clientSideCall.toolCallId,
          name: clientSideCall.toolName,
          arguments: clientSideCall.input,
          state: "interrupted",
        });
        await finalizeOutput();
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
      const interactiveCall = agentMode ? undefined : toolCalls.find((tc: any) => isInteractiveFn?.(tc.toolName));
      if (interactiveCall) {
        // Persist the interactive tool call so it survives session reload
        toolCallsAccum.push({
          id: interactiveCall.toolCallId,
          name: interactiveCall.toolName,
          arguments: interactiveCall.input,
          state: "interrupted",
        });
        await finalizeOutput();

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

      for (const call of toolCalls) {
        const callArgs = call.input as Record<string, unknown>;

        if (providerToolNames.has(call.toolName)) {
          recordProviderToolCall(toolCallsAccum, call, providerToolResults);
          continue;
        }

        const result = await effectiveToolExecutor(call.toolName, callArgs, {
          callId: call.toolCallId,
          signal: c.req.raw.signal,
        });
        const isError = result.startsWith("Error:");
        emitFileChanged(call.toolName, callArgs, result, deps.emit);

        // Accumulate for persistence
        toolCallsAccum.push({
          id: call.toolCallId,
          name: call.toolName,
          arguments: callArgs,
          result,
          state: isError ? "error" : "completed",
        });

        // Push tool result message in AI SDK format
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

    await finalizeOutput();
    return c.json(completionResponse(completionId, finalText, totalUsage));
  } catch (err) {
    // Friendly model_not_found surface — gateway returns 404 for
    // renamed/deprecated SKUs (e.g. xai/grok-4-fast after the 4.1
    // rename). Without this catch the error propagates as a 500.
    const guardrailError = guardrailErrorEnvelope(err);
    if (guardrailError) {
      finalText = guardrailError.message;
      outputPolicyApplied = true;
      return c.json(
        { error: guardrailError },
        (guardrailError.code === "guardrail_approval_required" ? 409 : 403) as any,
      );
    }
    const notFound = modelNotFoundEnvelope(err, m?.id, body.agent);
    if (notFound) {
      return c.json({ error: notFound }, 400 as any);
    }
    const error = modelErrorEnvelope(err);
    finalText = finalText || `Model request failed: ${error.message}`;
    return c.json({ error }, 400 as any);
  } finally {
    // Always persist the final text + tool calls — even on early return (ask_user) or error.
    // (Vault credentials are redacted inside persistAssistantMessage.)
    await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCallsAccum, {
      emptyFallback: "[Response interrupted]",
    });
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
      });
    } catch { /* never fail on callback */ }
    if (onResponseFinished) {
      onResponseFinished().catch(() => {});
    }
  }
}
