/**
 * chat-via-executeRun driver (migration F1c).
 *
 * When `settings.chatExecution:"run"`, a chat completion is executed through the
 * shared `executeRun` lifecycle + loop-engine (node-provided `runChatViaRun`)
 * instead of the inline `chat-handler` turn loop. This driver:
 *   1. packs the route's already-resolved model/prompt/tools/messages into a
 *      `ChatSessionInjection` (so the engine runs a chat turn-loop at parity),
 *   2. subscribes to the run's live event stream, and
 *   3. maps each event to the SAME OpenAI SSE chunks the inline handler emits —
 *      reusing this package's `sse.ts` / `tool-mapping.ts` helpers so framing,
 *      persistence, and metering are literally the same code.
 *
 * The loop engine defers interactive tool-use events until dispatch, preserving
 * the inline handler's per-call lifecycle order. Provider-executed tools are
 * recorded for session observability but never surfaced as local execution.
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatSessionInjection } from "@polpo-ai/core";
import type { ChatCompletionExecution } from "./chat-handler.js";
import { agentConfigForModelAttempt, completionResolvedModelInfo, MAX_TURNS } from "./agent-step-runner.js";
import {
  completionResponse,
  guardrailErrorEnvelope,
  modelErrorEnvelope,
  modelNotFoundEnvelope,
  sseChunk,
} from "./sse.js";
import {
  persistAssistantMessage,
  emitFileChanged,
  toAITools,
  CLIENT_SIDE_TOOLS,
  CLIENT_SIDE_TOOL_NAMES,
} from "./tool-mapping.js";
import {
  applyCompletionOutputPolicy,
  streamingOutputPolicyMode,
} from "./output-guardrails.js";

/** Best-effort session title from the first user message. */
function firstUserText(aiMessages: any[]): string {
  const u = aiMessages.find((m) => m?.role === "user");
  if (!u) return "chat";
  if (typeof u.content === "string") return u.content.slice(0, 60);
  if (Array.isArray(u.content)) {
    const t = u.content.find((p: any) => p?.type === "text")?.text;
    if (typeof t === "string") return t.slice(0, 60);
  }
  return "chat";
}

/** Pack the resolved chat inputs into the engine injection. */
export function buildChatRunInjection(execution: ChatCompletionExecution): ChatSessionInjection {
  const {
    deps,
    agentConfig,
    m,
    fullSystemPrompt,
    providerOpts,
    modelSelection,
    modelToolChoice,
    effectiveTools,
    effectiveToolExecutor,
    extraAiTools,
    aiMessages,
  } = execution;
  const reasoning = agentConfig?.reasoning ?? deps.getConfig()?.settings?.reasoning;
  return {
    runtimePlan: execution.runtimePlan,
    contextTrust: execution.contextTrust,
    agent: agentConfig,
    title: firstUserText(aiMessages),
    modelSelection,
    model: m as unknown as ChatSessionInjection["model"],
    resolveModelAttempt: async (model) => {
      const resolved = await deps.resolveAgentModel(agentConfigForModelAttempt(agentConfig, model), reasoning);
      return {
        model: resolved.model as unknown as ChatSessionInjection["model"],
        providerOptions: resolved.providerOptions as ChatSessionInjection["providerOptions"],
      };
    },
    systemPrompt: fullSystemPrompt,
    providerOptions: providerOpts as ChatSessionInjection["providerOptions"],
    maxTurns: MAX_TURNS,
    toolChoice: modelToolChoice,
    seedMessages: aiMessages,
    toolSet: { ...toAITools(effectiveTools), ...(extraAiTools ?? {}), ...CLIENT_SIDE_TOOLS },
    executor: effectiveToolExecutor,
    clientSideToolNames: CLIENT_SIDE_TOOL_NAMES,
    providerToolNames: new Set(Object.keys(extraAiTools ?? {})),
    sandbox: execution.body.sandbox,
    compactionTools: effectiveTools,
    compactionMode: "chat",
  };
}

/**
 * Shared accumulator + event→state reducer used by both the streaming and
 * non-streaming drivers. `write` is called for each SSE chunk in streaming
 * mode; a no-op in non-streaming mode.
 */
interface DriverState {
  finalText: string;
  toolCallsAccum: any[];
  totalUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  lastProviderMetadata: Record<string, unknown> | undefined;
  clientReturn: { id: string; name: string; arguments: unknown } | undefined;
  errorEvent: Record<string, unknown> | undefined;
  outputPolicyApplied: boolean;
}

export interface ChatViaRunTurnResult {
  text: string;
  toolCalls: any[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  providerMetadata?: Record<string, unknown>;
  clientToolCall?: { id: string; name: string; arguments: unknown };
  error?: { message: string; type: string; code?: string; param?: unknown };
  runStatus: string;
  runResult: { exitCode: number; stdout: string; stderr: string };
}

function makeOnEvent(
  execution: ChatCompletionExecution,
  state: DriverState,
  write: (data: string) => void,
  writeTextDeltas = true,
) {
  const { completionId, deps, extraAiTools } = execution;
  const providerToolNames = new Set(Object.keys(extraAiTools ?? {}));
  const toolArgsById = new Map<string, Record<string, unknown>>();
  const toolNamesById = new Map<string, string>();
  const toolArgsTextById = new Map<string, string>();
  return (e: Record<string, unknown>) => {
    switch (e.type) {
      case "text-delta": {
        const text = String(e.text ?? "");
        state.finalText += text;
        if (writeTextDeltas) write(sseChunk(completionId, { content: text }));
        break;
      }
      case "reasoning-delta": {
        write(sseChunk(completionId, {}, null, { thinking: String(e.text ?? "") }));
        break;
      }
      case "tool_input_start": {
        toolNamesById.set(String(e.toolId), String(e.tool ?? ""));
        write(sseChunk(completionId, {}, null, { tool_call: { id: e.toolId, name: e.tool, state: "preparing" } }));
        break;
      }
      case "tool_input_delta": {
        const toolId = String(e.toolId);
        const acc = (toolArgsTextById.get(toolId) ?? "") + String(e.delta ?? "");
        toolArgsTextById.set(toolId, acc);
        write(sseChunk(completionId, {}, null, {
          tool_call: {
            id: e.toolId,
            name: toolNamesById.get(toolId) ?? "",
            state: "preparing",
            argumentsText: acc,
          },
        }));
        break;
      }
      case "tool_use": {
        const name = String(e.tool);
        const args = (e.input ?? {}) as Record<string, unknown>;
        toolArgsById.set(String(e.toolId), args);
        if (providerToolNames.has(name)) break; // provider-executed: no calling chunk
        write(sseChunk(completionId, {}, null, { tool_call: { id: e.toolId, name, arguments: args, state: "calling" } }));
        break;
      }
      case "tool_result": {
        const name = String(e.tool);
        const result = String(e.content ?? "");
        const isError = !!e.isError;
        const args = (e.input as Record<string, unknown> | undefined) ?? toolArgsById.get(String(e.toolId)) ?? {};
        const providerExecuted = e.providerExecuted === true || providerToolNames.has(name);
        if (providerExecuted) {
          state.toolCallsAccum.push({
            id: e.toolId,
            name,
            arguments: args,
            result: result || undefined,
            state: isError ? "error" : "completed",
            providerExecuted: true,
          });
          break;
        }
        emitFileChanged(name, args, result, deps.emit);
        state.toolCallsAccum.push({ id: e.toolId, name, arguments: args, result, state: isError ? "error" : "completed" });
        write(sseChunk(completionId, {}, null, { tool_call: { id: e.toolId, name, result, state: isError ? "error" : "completed" } }));
        break;
      }
      case "client_tool_call": {
        state.clientReturn = { id: String(e.toolId), name: String(e.tool), arguments: e.input };
        break;
      }
      case "usage": {
        const u = (e.usage ?? {}) as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
        state.totalUsage.inputTokens += u.inputTokens ?? 0;
        state.totalUsage.outputTokens += u.outputTokens ?? 0;
        state.totalUsage.totalTokens += u.totalTokens ?? 0;
        if (e.providerMetadata) state.lastProviderMetadata = e.providerMetadata as Record<string, unknown>;
        break;
      }
      case "error": {
        state.errorEvent = (e.error as Record<string, unknown> | undefined) ?? e;
        break;
      }
    }
  };
}

/** OpenAI `tool_calls` finish chunk for a client-side tool (parity with chat-handler). */
function clientToolFinishChunk(completionId: string, ret: { id: string; name: string; arguments: unknown }): string {
  return JSON.stringify({
    id: completionId,
    object: "chat.completion.chunk",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{ index: 0, id: ret.id, type: "function", function: { name: ret.name, arguments: JSON.stringify(ret.arguments) } }],
      },
      finish_reason: "tool_calls",
    }],
  });
}

function newState(): DriverState {
  return {
    finalText: "",
    toolCallsAccum: [],
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    lastProviderMetadata: undefined,
    clientReturn: undefined,
    errorEvent: undefined,
    outputPolicyApplied: false,
  };
}

async function applyStateOutputPolicy(
  execution: ChatCompletionExecution,
  state: DriverState,
  mode: "enforce" | "audit",
  signal?: AbortSignal,
): Promise<void> {
  if (state.outputPolicyApplied) return;
  state.finalText = await applyCompletionOutputPolicy({
    outputPolicy: execution.deps.runOutputPolicy,
    text: state.finalText,
    mode,
    runtimePlan: execution.runtimePlan,
    agent: execution.body.agent,
    sessionId: execution.sessionId,
    signal,
  });
  state.outputPolicyApplied = true;
}

function captureRunFailure(
  state: DriverState,
  outcome: { status: string; result: { stderr?: string } },
): void {
  if (outcome.status === "completed" || state.errorEvent) return;
  state.errorEvent = {
    message: outcome.result?.stderr || `Run ended with status ${outcome.status}`,
  };
}

async function finishCommon(
  execution: ChatCompletionExecution,
  state: DriverState,
  assistantMsgId: string | null,
  options?: { emptyFallback?: string },
) {
  const { deps, body, m, sessionStore, sessionId, onResponseFinished } = execution;
  await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, state.finalText, state.toolCallsAccum, options);
  try {
    deps.onCompletionFinished?.({
      usage: state.totalUsage,
      model: m.id ?? m.provider,
      resolvedModel: completionResolvedModelInfo(m),
      agent: body.agent,
      sessionId: sessionId ?? undefined,
      user: body.user,
      providerMetadata: state.lastProviderMetadata,
    });
  } catch { /* never fail on callback */ }
  if (onResponseFinished) onResponseFinished().catch(() => {});
}

/** Streaming chat completion via executeRun. */
export function streamChatViaRun(c: Context, execution: ChatCompletionExecution) {
  const { deps, body, completionId, m, sessionStore, sessionId } = execution;
  const inject = buildChatRunInjection(execution);

  return streamSSE(c, async (stream) => {
    const abortController = new AbortController();
    stream.onAbort(() => abortController.abort());
    const heartbeat = setInterval(() => {
      if (abortController.signal.aborted) { clearInterval(heartbeat); return; }
      stream.write(": ping\n\n").catch(() => clearInterval(heartbeat));
    }, 20_000);

    await stream.writeSSE({ data: sseChunk(completionId, { role: "assistant" }) });

    let assistantMsgId: string | null = null;
    if (sessionStore && sessionId) {
      const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
      assistantMsgId = placeholder.id;
    }

    const state = newState();
    const outputMode = streamingOutputPolicyMode(deps.runOutputPolicy);
    let writeChain: Promise<void> = Promise.resolve();
    const write = (data: string) => { writeChain = writeChain.then(() => stream.writeSSE({ data })).catch(() => {}); };
    const onEvent = makeOnEvent(execution, state, write, outputMode !== "buffer");

    try {
      const outcome = await deps.runChatViaRun!(inject, { onEvent, signal: abortController.signal });
      captureRunFailure(state, outcome);
      await writeChain;

      if (state.errorEvent && !abortController.signal.aborted) {
        const guardrail = guardrailErrorEnvelope(state.errorEvent);
        const notFound = modelNotFoundEnvelope(state.errorEvent, m?.id, body.agent);
        const error = guardrail ?? notFound ?? modelErrorEnvelope(state.errorEvent);
        const text = guardrail || notFound ? "" : `Model request failed: ${error.message}`;
        if (text) {
          state.finalText += text;
          await stream.writeSSE({ data: sseChunk(completionId, { content: text }) });
        }
        await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error }) });
        await stream.writeSSE({ data: "[DONE]" });
      } else if (state.clientReturn) {
        await applyStateOutputPolicy(
          execution,
          state,
          outputMode === "buffer" ? "enforce" : "audit",
          abortController.signal,
        );
        if (outputMode === "buffer" && state.finalText) {
          await stream.writeSSE({ data: sseChunk(completionId, { content: state.finalText }) });
        }
        state.toolCallsAccum.push({ id: state.clientReturn.id, name: state.clientReturn.name, arguments: state.clientReturn.arguments, state: "interrupted" });
        await stream.writeSSE({ data: clientToolFinishChunk(completionId, state.clientReturn) });
        await stream.writeSSE({ data: "[DONE]" });
      } else if (!abortController.signal.aborted) {
        await applyStateOutputPolicy(
          execution,
          state,
          outputMode === "buffer" ? "enforce" : "audit",
          abortController.signal,
        );
        if (outputMode === "buffer" && state.finalText) {
          await stream.writeSSE({ data: sseChunk(completionId, { content: state.finalText }) });
        }
        await stream.writeSSE({ data: sseChunk(completionId, {}, "stop") });
        await stream.writeSSE({ data: "[DONE]" });
      }
    } catch (err) {
      if (!((err instanceof DOMException && err.name === "AbortError") || abortController.signal.aborted)) {
        const guardrail = guardrailErrorEnvelope(err);
        const notFound = modelNotFoundEnvelope(err, m?.id, body.agent);
        if (guardrail) {
          state.finalText = guardrail.message;
          state.outputPolicyApplied = true;
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: guardrail }) });
          await stream.writeSSE({ data: "[DONE]" });
        } else if (notFound) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: notFound }) });
          await stream.writeSSE({ data: "[DONE]" });
        } else {
          const error = modelErrorEnvelope(err);
          const text = `Model request failed: ${error.message}`;
          state.finalText += text;
          await stream.writeSSE({ data: sseChunk(completionId, { content: text }) });
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error }) });
          await stream.writeSSE({ data: "[DONE]" });
        }
      }
    } finally {
      clearInterval(heartbeat);
      await finishCommon(execution, state, assistantMsgId);
    }
  });
}

/** Non-streaming chat completion via executeRun. */
export async function runNonStreamingChatViaRun(c: Context, execution: ChatCompletionExecution) {
  const { deps, body, completionId, m, sessionStore, sessionId } = execution;
  const inject = buildChatRunInjection(execution);

  let assistantMsgId: string | null = null;
  if (sessionStore && sessionId) {
    const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
    assistantMsgId = placeholder.id;
  }

  const state = newState();
  const onEvent = makeOnEvent(execution, state, () => { /* no SSE in non-streaming mode */ });

  try {
    const outcome = await deps.runChatViaRun!(inject, {
      onEvent,
      signal: c.req.raw.signal,
    });
    captureRunFailure(state, outcome);

    if (!state.errorEvent) {
      await applyStateOutputPolicy(execution, state, "enforce");
    }
    if (state.clientReturn) {
      return c.json({
        id: completionId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "polpo",
        choices: [{
          index: 0,
          message: { role: "assistant", content: null, tool_calls: [{ id: state.clientReturn.id, type: "function", function: { name: state.clientReturn.name, arguments: JSON.stringify(state.clientReturn.arguments) } }] },
          finish_reason: "tool_calls",
        }],
      });
    }
    if (state.errorEvent) {
      const guardrail = guardrailErrorEnvelope(state.errorEvent);
      if (guardrail) {
        return c.json(
          { error: guardrail },
          (guardrail.code === "guardrail_approval_required" ? 409 : 403) as any,
        );
      }
      const notFound = modelNotFoundEnvelope(state.errorEvent, m?.id, body.agent);
      if (notFound) return c.json({ error: notFound }, 400 as any);
      const error = modelErrorEnvelope(state.errorEvent);
      state.finalText = state.finalText || `Model request failed: ${error.message}`;
      return c.json({ error }, 400 as any);
    }
    return c.json(completionResponse(completionId, state.finalText, state.totalUsage as any));
  } catch (err) {
    const guardrail = guardrailErrorEnvelope(err);
    if (guardrail) {
      state.finalText = guardrail.message;
      state.outputPolicyApplied = true;
      return c.json(
        { error: guardrail },
        (guardrail.code === "guardrail_approval_required" ? 409 : 403) as any,
      );
    }
    const notFound = modelNotFoundEnvelope(err, m?.id, body.agent);
    if (notFound) return c.json({ error: notFound }, 400 as any);
    const error = modelErrorEnvelope(err);
    state.finalText = state.finalText || `Model request failed: ${error.message}`;
    return c.json({ error }, 400 as any);
  } finally {
    await finishCommon(execution, state, assistantMsgId, { emptyFallback: "[Response interrupted]" });
  }
}

/**
 * Non-HTTP chat turn via executeRun.
 *
 * This is the channel/adapter entrypoint: hosts can route Slack, email, or
 * other inbound messages through the same chat-via-run lifecycle without
 * going through Hono/SSE and without duplicating model/tool execution.
 */
export async function runChatTurnViaRun(
  execution: ChatCompletionExecution,
  hooks: { onRunEvent?: (e: Record<string, unknown>) => void; signal?: AbortSignal } = {},
): Promise<ChatViaRunTurnResult> {
  const { deps, body, m, sessionStore, sessionId } = execution;
  if (!deps.runChatViaRun) {
    throw new Error("runChatViaRun dependency is required");
  }

  const inject = buildChatRunInjection(execution);
  let assistantMsgId: string | null = null;
  if (sessionStore && sessionId) {
    const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
    assistantMsgId = placeholder.id;
  }

  const state = newState();
  const reduceEvent = makeOnEvent(execution, state, () => { /* no SSE in adapter mode */ });
  let runStatus = "failed";
  let runResult = { exitCode: 1, stdout: "", stderr: "" };

  try {
    const outcome = await deps.runChatViaRun(inject, {
      signal: hooks.signal,
      onEvent: (event) => {
        hooks.onRunEvent?.(event);
        reduceEvent(event);
      },
    });
    runStatus = outcome.status;
    runResult = outcome.result;
    captureRunFailure(state, outcome);
    if (!state.errorEvent) {
      await applyStateOutputPolicy(execution, state, "enforce", hooks.signal);
    }
  } catch (err) {
    const guardrail = guardrailErrorEnvelope(err);
    if (guardrail) {
      state.finalText = guardrail.message;
      state.outputPolicyApplied = true;
      throw err;
    }
    state.errorEvent = (err as Record<string, unknown> | undefined) ?? { message: String(err) };
    const message = err instanceof Error ? err.message : String(err);
    runResult = { exitCode: 1, stdout: "", stderr: message };
  } finally {
    await finishCommon(execution, state, assistantMsgId, { emptyFallback: "[Response interrupted]" });
  }

  let error: ChatViaRunTurnResult["error"] | undefined;
  if (state.errorEvent) {
    const guardrail = guardrailErrorEnvelope(state.errorEvent);
    const notFound = modelNotFoundEnvelope(state.errorEvent, m?.id, body.agent);
    error = guardrail ?? notFound ?? modelErrorEnvelope(state.errorEvent);
    if (!guardrail && !notFound && !state.finalText) {
      state.finalText = `Model request failed: ${error.message}`;
    }
  }

  return {
    text: state.finalText,
    toolCalls: state.toolCallsAccum,
    usage: state.totalUsage,
    providerMetadata: state.lastProviderMetadata,
    clientToolCall: state.clientReturn,
    error,
    runStatus,
    runResult,
  };
}
