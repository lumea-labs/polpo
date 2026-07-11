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
 * Parity notes (see migration plan): multi-tool-turn tool_call order differs
 * from the inline handler by construction; `model_not_found` enrichment and
 * provider-executed (extraAiTools) recording are follow-ups. Dark until the
 * flag is set.
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatSessionInjection } from "@polpo-ai/core";
import type { ChatCompletionExecution } from "./chat-handler.js";
import { MAX_TURNS } from "./agent-step-runner.js";
import { completionResponse, modelNotFoundEnvelope, sseChunk } from "./sse.js";
import {
  persistAssistantMessage,
  emitFileChanged,
  toAITools,
  CLIENT_SIDE_TOOLS,
  CLIENT_SIDE_TOOL_NAMES,
} from "./tool-mapping.js";

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
function buildInjection(execution: ChatCompletionExecution): ChatSessionInjection {
  const { agentConfig, m, fullSystemPrompt, providerOpts, modelToolChoice, effectiveTools, effectiveToolExecutor, extraAiTools, aiMessages } = execution;
  return {
    agent: agentConfig,
    title: firstUserText(aiMessages),
    model: m as unknown as ChatSessionInjection["model"],
    systemPrompt: fullSystemPrompt,
    providerOptions: providerOpts as ChatSessionInjection["providerOptions"],
    maxTurns: MAX_TURNS,
    toolChoice: modelToolChoice,
    seedMessages: aiMessages,
    toolSet: { ...toAITools(effectiveTools), ...(extraAiTools ?? {}), ...CLIENT_SIDE_TOOLS },
    executor: effectiveToolExecutor,
    clientSideToolNames: CLIENT_SIDE_TOOL_NAMES,
    providerToolNames: new Set(Object.keys(extraAiTools ?? {})),
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
}

function makeOnEvent(
  execution: ChatCompletionExecution,
  state: DriverState,
  write: (data: string) => void,
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
        write(sseChunk(completionId, { content: text }));
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
        const args = toolArgsById.get(String(e.toolId)) ?? {};
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
        state.errorEvent = e;
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
  return { finalText: "", toolCallsAccum: [], totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, lastProviderMetadata: undefined, clientReturn: undefined, errorEvent: undefined };
}

async function finishCommon(execution: ChatCompletionExecution, state: DriverState, assistantMsgId: string | null) {
  const { deps, body, m, sessionStore, sessionId, onResponseFinished } = execution;
  await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, state.finalText, state.toolCallsAccum);
  try {
    deps.onCompletionFinished?.({
      usage: state.totalUsage,
      model: m.id ?? m.provider,
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
  const inject = buildInjection(execution);

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
    let writeChain: Promise<void> = Promise.resolve();
    const write = (data: string) => { writeChain = writeChain.then(() => stream.writeSSE({ data })).catch(() => {}); };
    const onEvent = makeOnEvent(execution, state, write);

    try {
      await deps.runChatViaRun!(inject, { onEvent, signal: abortController.signal });
      await writeChain;

      if (state.clientReturn) {
        state.toolCallsAccum.push({ id: state.clientReturn.id, name: state.clientReturn.name, arguments: state.clientReturn.arguments, state: "interrupted" });
        await stream.writeSSE({ data: clientToolFinishChunk(completionId, state.clientReturn) });
        await stream.writeSSE({ data: "[DONE]" });
      } else if (!abortController.signal.aborted) {
        const notFound = state.errorEvent ? modelNotFoundEnvelope(state.errorEvent, m?.id, body.agent) : null;
        await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", notFound ? { error: notFound } : undefined) });
        await stream.writeSSE({ data: "[DONE]" });
      }
    } catch (err) {
      if (!((err instanceof DOMException && err.name === "AbortError") || abortController.signal.aborted)) {
        const notFound = modelNotFoundEnvelope(err, m?.id, body.agent);
        if (notFound) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: notFound }) });
          await stream.writeSSE({ data: "[DONE]" });
        } else {
          throw err;
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
  const inject = buildInjection(execution);

  let assistantMsgId: string | null = null;
  if (sessionStore && sessionId) {
    const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
    assistantMsgId = placeholder.id;
  }

  const state = newState();
  const onEvent = makeOnEvent(execution, state, () => { /* no SSE in non-streaming mode */ });

  try {
    await deps.runChatViaRun!(inject, { onEvent, signal: undefined });

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
      const notFound = modelNotFoundEnvelope(state.errorEvent, m?.id, body.agent);
      if (notFound) return c.json({ error: notFound }, 400 as any);
    }
    return c.json(completionResponse(completionId, state.finalText, state.totalUsage as any));
  } finally {
    await finishCommon(execution, state, assistantMsgId);
  }
}
