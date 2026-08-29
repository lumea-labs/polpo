/**
 * Polpo tool → AI SDK tool mapping for the chat completions endpoint,
 * plus tool-call side effects shared by the chat loop and the loop
 * runtimes: file:changed events, vault credential redaction, and
 * provider-executed tool-call bookkeeping.
 */

import {
  toValidatedToolInputSchema,
} from "@polpo-ai/llm";
import { jsonSchema } from "ai";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  CLIENT_INTERACTION_TOOL_NAMES,
  type ChatSuggestion,
  type ResolvedChatInteractionCapabilities,
} from "@polpo-ai/core/chat-interactions";
import { preparePersistedReasoning } from "@polpo-ai/core/session-store";

export { toPortableToolInputSchema } from "@polpo-ai/llm";

/** A tool call event surfaced by the loop runtimes (SSE + persistence). */
export type LoopRuntimeToolCall = {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  /** Incremental raw JSON fragment emitted while tool input is generated. */
  argumentsDelta?: string;
  /** @deprecated Cumulative snapshots are accepted for backward compatibility only. */
  argumentsText?: string;
  result?: string;
  state: "preparing" | "calling" | "completed" | "error" | "interrupted";
};

/** Tools that write/modify files — emit file:changed after successful execution */
const FILE_WRITE_TOOLS: Record<string, "created" | "modified"> = {
  write_file: "created",
  edit_file: "modified",
};

/** Emit file:changed if a file-writing tool succeeded */
export function emitFileChanged(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  emit: (event: string, data: any) => void,
): void {
  const action = FILE_WRITE_TOOLS[toolName];
  if (!action || result.startsWith("Error:")) return;
  const path = args.path as string | undefined;
  if (!path) return;
  const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";
  emit("file:changed", { path, dir, action, source: "chat" });
}

/**
 * Redact sensitive credential values from vault tool call arguments before persistence.
 * Returns a sanitized copy — original is NOT mutated.
 */
export function redactVaultToolCalls(toolCalls: any[]): any[] {
  // @ts-ignore — ToolCallInfo shape preserved via duck typing
  return toolCalls.map(tc => {
    if ((tc.name !== "set_vault_entry" && tc.name !== "update_vault_credentials") || !tc.arguments) return tc;
    const args = { ...tc.arguments };
    if (args.credentials && typeof args.credentials === "object") {
      // Replace each credential value with a redacted marker, preserve keys for display
      const redacted: Record<string, string> = {};
      for (const key of Object.keys(args.credentials as Record<string, string>)) {
        redacted[key] = "[REDACTED]";
      }
      args.credentials = redacted;
    }
    return { ...tc, arguments: args };
  });
}

export function appendReasoningSummary(current: string, next: string | undefined): string {
  if (!next) return current;
  return current ? `${current}\n\n${next}` : next;
}

/**
 * Persist a completed assistant turn to the chat session — the single
 * projection of a finished LLM turn onto `Session.Message`, shared by the
 * chat handler (streaming + non-streaming) and the project-loop runner
 * instead of being copy-pasted at each finally block.
 *
 * Redacts vault credentials from the tool calls before writing, and falls
 * back to `emptyFallback` (default "") when the model produced no text.
 * No-op when the session isn't tracked (no store / sessionId / messageId).
 */
export async function persistAssistantMessage(
  sessionStore: any,
  sessionId: string | null | undefined,
  messageId: string | null | undefined,
  finalText: string,
  toolCalls: any[],
  opts?: { emptyFallback?: string; suggestions?: ChatSuggestion[]; reasoning?: string },
): Promise<void> {
  if (!sessionStore || !sessionId || !messageId) return;
  const safeToolCalls = redactVaultToolCalls(toolCalls);
  // A textless client/provider tool turn is valid and must not be rewritten as
  // an interrupted response. Use the fallback only when the turn contains
  // neither assistant text nor a persisted tool call.
  const content = finalText.trim() || (safeToolCalls.length > 0 ? "" : (opts?.emptyFallback ?? ""));
  const reasoning = preparePersistedReasoning(opts?.reasoning);
  if (reasoning) {
    await sessionStore.updateMessage(
      sessionId,
      messageId,
      content,
      safeToolCalls,
      opts?.suggestions,
      reasoning,
    );
  } else if (opts?.suggestions) {
    await sessionStore.updateMessage(
      sessionId,
      messageId,
      content,
      safeToolCalls,
      opts.suggestions,
    );
  } else {
    await sessionStore.updateMessage(sessionId, messageId, content, safeToolCalls);
  }
}

export function indexToolResultsByCallId(toolResults: any[] | undefined): Map<string, any> {
  const indexed = new Map<string, any>();
  for (const result of toolResults ?? []) {
    if (result?.toolCallId) indexed.set(result.toolCallId, result);
  }
  return indexed;
}

export function providerToolCallEvent(call: any, toolResults: Map<string, any>): LoopRuntimeToolCall & { providerExecuted: true } {
  const toolResult = toolResults.get(call.toolCallId);
  const output = toolResult?.output ?? toolResult?.result ?? toolResult?.error;
  return {
    id: call.toolCallId,
    name: call.toolName,
    arguments: call.input as Record<string, unknown>,
    result: output === undefined ? undefined : typeof output === "string" ? output : JSON.stringify(output),
    state: toolResult?.type === "tool-error" || toolResult?.error ? "error" : "completed",
    providerExecuted: true,
  };
}

export function recordProviderToolCall(toolCallsAccum: any[], call: any, toolResults: Map<string, any>): void {
  toolCallsAccum.push(providerToolCallEvent(call, toolResults));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isInvalidModelToolCall(call: unknown): boolean {
  return isJsonObject(call) && call.invalid === true;
}

export function invalidModelToolCallEvent(call: any): LoopRuntimeToolCall {
  const message = call?.error instanceof Error
    ? call.error.message
    : typeof call?.error === "string"
      ? call.error
      : "Tool arguments do not match the declared input schema.";
  return {
    id: call?.toolCallId ?? "",
    name: call?.toolName ?? "",
    arguments: isJsonObject(call?.input) ? call.input : {},
    result: `Error: Invalid tool arguments: ${message}`,
    state: "error",
  };
}

/**
 * Convert Polpo tools to AI SDK tool format (without execute functions).
 *
 * AI SDK tools: Record<string, { description, inputSchema }>
 * Tools without execute are "manual" — tool calls are returned but not auto-executed.
 */
export function toAITools(tools: any[]): Record<string, { description?: string; inputSchema: any }> {
  if (!tools.length) return {};
  return Object.fromEntries(
    tools.map(t => [t.name, {
      description: t.description,
      inputSchema: toValidatedToolInputSchema(t.parameters),
    }]),
  );
}

export function toAIToolChoice(choice: unknown): unknown | undefined {
  if (!choice) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (typeof choice !== "object") return undefined;
  const c = choice as { mode?: unknown; tool?: unknown };
  if (c.mode === "auto" || c.mode === "none") return c.mode;
  if (c.mode === "required" && typeof c.tool === "string" && c.tool.trim()) {
    return { type: "tool", toolName: c.tool };
  }
  if (c.mode === "required") return "required";
  return undefined;
}

// ── Client-side tools ────────────────────────────────────────────────────
// These tools have NO server-side execute. When the LLM calls them, the
// server stops the tool loop and returns the tool call to the client via
// standard OpenAI finish_reason: "tool_calls". The client handles them
// (shows UI, collects input) and sends the result back as a tool message.

export const CLIENT_SIDE_TOOLS: Record<string, { description: string; inputSchema: any }> = {
  [ASK_USER_QUESTION_TOOL_NAME]: {
    description: [
      "Ask the user clarifying questions before proceeding.",
      "Use when the request is ambiguous or has multiple valid interpretations.",
      "Each question has pre-populated selectable options the user can pick from.",
      "Do NOT ask for information you can infer from context or memory.",
      "Do NOT ask obvious questions — if there's one clear interpretation, just do it.",
      "Pre-populate options with the most likely choices. Be concise (1-5 words per label).",
      "If you recommend one option, put it first and add '(Recommended)' to its label.",
      "After receiving answers, proceed immediately — don't summarize the answers back.",
      "Max 5 questions per call. Prefer fewer, more focused questions.",
    ].join(" "),
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "List of questions to ask the user",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique question key for matching answers (e.g. 'auth-method')" },
              question: { type: "string", description: "The question text" },
              header: { type: "string", description: "Short label for compact display (max 30 chars)" },
              options: {
                type: "array",
                description: "Pre-populated selectable options",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Option label (1-5 words)" },
                    description: { type: "string", description: "Optional longer description" },
                  },
                  required: ["label"],
                },
              },
              multiple: { type: "boolean", description: "Allow selecting multiple options (default: false)" },
              custom: { type: "boolean", description: "Show a 'Type your own answer' input (default: true)" },
            },
            required: ["id", "question", "options"],
          },
        },
      },
      required: ["questions"],
    }),
  },
};

/** Set of tool names that are client-side (no server execute). */
export const CLIENT_SIDE_TOOL_NAMES = new Set(Object.keys(CLIENT_SIDE_TOOLS));

if (
  CLIENT_SIDE_TOOL_NAMES.size !== CLIENT_INTERACTION_TOOL_NAMES.length
  || CLIENT_INTERACTION_TOOL_NAMES.some(
    (name) => !CLIENT_SIDE_TOOL_NAMES.has(name),
  )
) {
  throw new Error("Client-side tool registry is out of sync with the core interaction contract");
}

/** Select only client-side tools supported by both agent policy and client. */
export function clientSideToolsForCapabilities(
  capabilities: ResolvedChatInteractionCapabilities,
): Record<string, { description: string; inputSchema: any }> {
  return capabilities.askUserQuestion
    ? { ask_user_question: CLIENT_SIDE_TOOLS.ask_user_question! }
    : {};
}
