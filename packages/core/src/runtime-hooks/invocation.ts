/**
 * Hook dispatch for one agent invocation, shared by every agentic surface
 * (direct chat, Run-backed chat, Loop agent nodes, tasks).
 */
import type { HookEventResult } from "./aggregate.js";
import type { HookRuntime } from "./runtime.js";
import { canonicalToolCall } from "./tools.js";
import { normalizeToolOutputText } from "../tool-result.js";
import type { TerminationGatePolicy } from "../termination-gate.js";

/** Tool executor contract used by the runtime surfaces (rendered string result). */
export type HookedToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  execution?: { callId?: string; signal?: AbortSignal },
) => Promise<string>;

/** The subset of a model-policy event a hook needs (provider fallback selection). */
export interface HookModelPolicyEvent {
  type: string;
  from?: { model: string };
  to?: { model: string };
}

export type HookInvocationSurface = "chat" | "loop" | "channel" | "task" | "schedule" | "runtime";

/** Hooks resolved for one agent invocation. */
export interface HookInvocationContext {
  runtime: HookRuntime;
  surface: HookInvocationSurface;
  signal?: AbortSignal;
  /** Optional cumulative limits applied while Stop hooks keep the agent working. */
  stopPolicy?: TerminationGatePolicy;
}

/** A prompt rejected by UserPromptSubmit never reaches the model. */
export class RuntimeHookPromptBlockedError extends Error {
  override readonly name = "RuntimeHookPromptBlockedError";
  readonly code = "prompt_blocked_by_hook";
  constructor(reason: string) {
    super(reason || "Prompt blocked by UserPromptSubmit hook");
  }
}

/** A hook returned `continue: false`: processing stops with its reason. */
export class RuntimeHookStopError extends Error {
  override readonly name = "RuntimeHookStopError";
  readonly code = "stopped_by_hook";
  constructor(reason?: string) {
    super(reason || "Stopped by hook");
  }
}

function collect(context: HookInvocationContext, result: HookEventResult | undefined): HookEventResult | undefined {
  if (!result) return result;
  if (result.systemMessages.length) context.runtime.systemMessages.push(...result.systemMessages);
  if (result.stop && !context.runtime.pendingStop) context.runtime.pendingStop = result.stop;
  return result;
}

/**
 * Wrap a tool executor with PreToolUse / PostToolUse / PostToolUseFailure at
 * the point the side effect happens. A denial returns the reason as the tool
 * error the model sees; `updatedInput` replaces the arguments; feedback and
 * additional context are placed next to the tool result.
 */
export function createRuntimeHookedToolExecutor(options: {
  executor: HookedToolExecutor;
  hooks?: HookInvocationContext;
}): HookedToolExecutor {
  const hooks = options.hooks;
  if (!hooks) return options.executor;
  return async (name, originalArgs, execution) => {
    const signal = execution?.signal ?? hooks.signal;
    hooks.runtime.noteToolCall();
    const before = await hooks.runtime.preToolUse(name, originalArgs, execution?.callId, signal ? { signal } : {});
    if (before.systemMessages.length) hooks.runtime.systemMessages.push(...before.systemMessages);
    if (before.stop && !hooks.runtime.pendingStop) hooks.runtime.pendingStop = before.stop;
    if (before.decision === "deny" || before.decision === "ask" || before.decision === "defer") {
      // No interactive permission host: ask/defer are refused like a
      // non-interactive run, with the hook's reason as the tool error.
      return normalizeToolOutputText(withContext(`Error: ${before.reason}`, before.context));
    }
    const args = before.input;
    const startedAt = Date.now();
    const result = await options.executor(name, args, execution);
    const after = await hooks.runtime.postToolUse(name, args, result, execution?.callId, Date.now() - startedAt, signal ? { signal } : {});
    if (after.systemMessages.length) hooks.runtime.systemMessages.push(...after.systemMessages);
    if (after.stop && !hooks.runtime.pendingStop) hooks.runtime.pendingStop = after.stop;
    if (!result.startsWith("Error:")) await runFileChangedHooks(hooks, name, args);
    // Hook-rewritten results and hook context must be as persistable as tool output.
    return normalizeToolOutputText(withContext(after.result, before.context));
  };
}

/**
 * FileChanged for a watched file written by a workspace tool. The portable
 * runtime has no filesystem watcher, so changes made by shell commands or
 * external processes are not observed (capability: tool-attributed).
 */
export async function runFileChangedHooks(hooks: HookInvocationContext | undefined, toolName: string, args: Record<string, unknown>): Promise<void> {
  if (!hooks?.runtime.has("FileChanged")) return;
  const call = canonicalToolCall(toolName, args, hooks.runtime.cwd);
  if (call.toolName !== "Write" && call.toolName !== "Edit") return;
  const filePath = typeof call.toolInput.file_path === "string" ? call.toolInput.file_path : undefined;
  if (!filePath) return;
  const watched = new Set(hooks.runtime.engine.fileChangedWatchList());
  if (!watched.has(filePath.slice(filePath.lastIndexOf("/") + 1))) return;
  await hooks.runtime.dispatch("FileChanged", { file_path: filePath, event: call.toolName === "Write" ? "add" : "change" }).catch(() => undefined);
}

function withContext(result: string, context: readonly string[]): string {
  return context.length ? `${result}\n\n${context.map((text) => `<system-reminder>\n${text}\n</system-reminder>`).join("\n")}` : result;
}

/** SessionStart: returns context for the start of the conversation. */
export async function runSessionStartHooks(
  hooks: HookInvocationContext | undefined,
  source: "startup" | "resume" | "clear" | "compact" | "fork",
  model?: string,
): Promise<string[]> {
  if (!hooks?.runtime.has("SessionStart")) return [];
  const result = collect(hooks, await hooks.runtime.dispatch("SessionStart", { source, ...(model ? { model } : {}) }, hooks.signal ? { signal: hooks.signal } : {}));
  return result?.additionalContext ?? [];
}

/** UserPromptSubmit: throws when the prompt is blocked, returns added context. */
export async function runUserPromptSubmitHooks(
  hooks: HookInvocationContext | undefined,
  prompt: string,
): Promise<string[]> {
  if (!hooks?.runtime.has("UserPromptSubmit")) return [];
  const result = collect(hooks, await hooks.runtime.dispatch("UserPromptSubmit", { prompt }, hooks.signal ? { signal: hooks.signal } : {}))!;
  if (result.block) throw new RuntimeHookPromptBlockedError(result.block.reason);
  if (hooks.runtime.pendingStop) throw new RuntimeHookStopError(hooks.runtime.pendingStop.reason);
  return result.additionalContext;
}

/** SessionEnd at the end of an invocation. Observational; never throws. */
export async function runSessionEndHooks(hooks: HookInvocationContext | undefined, reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other" = "other"): Promise<void> {
  if (!hooks?.runtime.has("SessionEnd")) return;
  await hooks.runtime.dispatch("SessionEnd", { reason }).catch(() => undefined);
}

/** StopFailure instead of Stop when the turn ends on a provider/API error. Observational. */
export async function runStopFailureHooks(hooks: HookInvocationContext | undefined, error: unknown, lastAssistantMessage?: string): Promise<void> {
  if (!hooks?.runtime.has("StopFailure")) return;
  const message = error instanceof Error ? error.message : String(error);
  await hooks.runtime.dispatch("StopFailure", {
    error: stopFailureType(error),
    error_details: message.slice(0, 2_000),
    last_assistant_message: lastAssistantMessage || `API Error: ${message.slice(0, 500)}`,
  }).catch(() => undefined);
}

/** PreCompact: returns false when a hook blocks this compaction. */
export async function runPreCompactHooks(hooks: HookInvocationContext | undefined, trigger: "auto" | "manual" = "auto"): Promise<boolean> {
  if (!hooks?.runtime.has("PreCompact")) return true;
  const result = collect(hooks, await hooks.runtime.dispatch("PreCompact", { trigger, custom_instructions: null }, hooks.signal ? { signal: hooks.signal } : {}));
  return !result?.block;
}

export async function runPostCompactHooks(hooks: HookInvocationContext | undefined, summary: string | undefined, trigger: "auto" | "manual" = "auto"): Promise<void> {
  if (!hooks?.runtime.has("PostCompact")) return;
  await hooks.runtime.dispatch("PostCompact", { trigger, compact_summary: summary ?? "" }).catch(() => undefined);
}

/**
 * PostToolBatch after every tool call of a model step resolved. Returns the
 * reason when a hook stops the agentic loop before the next model call.
 */
export async function runPostToolBatchHooks(
  hooks: HookInvocationContext | undefined,
  calls: readonly { name: string; input: Record<string, unknown>; toolUseId?: string; result: string }[],
): Promise<{ stop?: string; context: string[] }> {
  if (!hooks) return { context: [] };
  const result = collect(hooks, await hooks.runtime.postToolBatch(calls, hooks.signal ? { signal: hooks.signal } : {}));
  const halt = result?.block?.reason ?? hooks.runtime.pendingStop?.reason ?? (hooks.runtime.pendingStop ? "Stopped by hook" : undefined);
  return { ...(halt !== undefined ? { stop: halt } : {}), context: result?.additionalContext ?? [] };
}

/**
 * Automatic provider fallback changes the model on its own: PostModelSwitch
 * with source "auto". Its context is delivered with the next request.
 */
export async function dispatchCompletionModelPolicyHook(
  hooks: HookInvocationContext | undefined,
  event: HookModelPolicyEvent,
): Promise<void> {
  if (event.type !== "model-fallback-selected" || !event.to || !hooks?.runtime.has("PostModelSwitch")) return;
  const result = collect(hooks, await hooks.runtime.dispatch("PostModelSwitch", {
    from_model: event.from?.model ?? "",
    to_model: event.to.model,
    requested_model: null,
    source: "auto",
  }, {
    matcherSubject: canonicalModelName(event.to.model),
    ...(hooks.signal ? { signal: hooks.signal } : {}),
  }));
  if (result?.additionalContext.length) hooks.runtime.pendingContext.push(...result.additionalContext);
}

/** Drain context queued for the next model request, as a system-reminder user message. */
export function takePendingHookContext(hooks: HookInvocationContext | undefined): { role: "user"; content: string } | undefined {
  const pending = hooks?.runtime.pendingContext.splice(0);
  if (!pending?.length) return undefined;
  return { role: "user", content: pending.map((text) => `<system-reminder>\n${text}\n</system-reminder>`).join("\n") };
}

/** Hook context as a system-reminder user message, placed before the next model call. */
export function hookContextMessage(context: readonly string[]): { role: "user"; content: string } {
  return { role: "user", content: context.map((text) => `<system-reminder>\n${text}\n</system-reminder>`).join("\n") };
}

/** Context from session/prompt hooks, appended to the system prompt. */
export function hookContextSection(event: string, context: readonly string[]): string {
  return context.length ? `\n\n<system-reminder>\n${event} hook additional context:\n${context.join("\n\n")}\n</system-reminder>` : "";
}

/** Canonical model name: provider prefix, date suffix and `[1m]` stripped. */
export function canonicalModelName(model: string): string {
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return bare.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}

function stopFailureType(error: unknown): string {
  const status = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 429 || /\brate[ _-]?limit/i.test(message)) return "rate_limit";
  if (status === 529 || /\boverloaded\b/i.test(message)) return "overloaded";
  if (status === 401 || /\b(?:authentication|unauthori[sz]ed|invalid api key)\b/i.test(message)) return "authentication_failed";
  if (status === 402 || /\b(?:billing|insufficient (?:credits|funds|quota))\b/i.test(message)) return "billing_error";
  if (status === 404 || /\bmodel[ _]not[ _]found\b/i.test(message)) return "model_not_found";
  if (/\bmax(?:imum)?[ _]output[ _]tokens\b|\blength limit\b/i.test(message)) return "max_output_tokens";
  if (status !== undefined && status >= 500) return "server_error";
  if (status !== undefined && status >= 400) return "invalid_request";
  return "unknown";
}

/** The latest user prompt text in a model message list (UserPromptSubmit `prompt`). */
export function latestUserPrompt(messages: readonly { role?: string; content?: unknown }[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part): part is { type: "text"; text: string } => Boolean(part) && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map((part) => part.text)
        .join("\n");
    }
    return "";
  }
  return "";
}
