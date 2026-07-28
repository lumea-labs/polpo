/**
 * OpenAI-format → AI SDK message/content conversion for the chat
 * completions endpoint.
 */

import type { z } from "@hono/zod-openapi";
import {
  createRuntimeContextSegment,
  protectRuntimeToolResultMessages,
  renderRuntimeContextSegment,
  renderRuntimeToolResult,
  type RuntimeContextSegment,
  type RuntimeContextTrustMode,
} from "@polpo-ai/core";
import type { contentPartSchema, messageSchema } from "./schemas.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Extract plain text from a content field (string or content-part array). */
export function extractText(content: z.infer<typeof messageSchema>["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } =>
      p.type === "text" && typeof p.text === "string" && p.text.trim() !== "",
    )
    .map((p) => p.text)
    .join("\n");
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function hasModelContent(content: unknown): boolean {
  if (hasText(content)) return true;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (part?.type === "text") return hasText(part.text);
    return part?.type === "image" || part?.type === "image_url" || part?.type === "file" || part?.type === "tool-call";
  });
}

function objectInputOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeToolCallHistory(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;

    const record = message as { content?: unknown };
    if (!Array.isArray(record.content)) return message;

    let changed = false;
    const content = record.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const partRecord = part as { type?: unknown; input?: unknown };
      if (partRecord.type !== "tool-call") return part;
      if (partRecord.input && typeof partRecord.input === "object" && !Array.isArray(partRecord.input)) return part;

      changed = true;
      return { ...(part as Record<string, unknown>), input: {} };
    });

    return changed ? { ...(message as Record<string, unknown>), content } : message;
  });
}

/** Resolve file content parts → text references the agent can act on with its tools. */
function resolveFileContentParts(
  content: z.infer<typeof messageSchema>["content"],
  contextTrust: RuntimeContextTrustMode,
): z.infer<typeof messageSchema>["content"] {
  if (typeof content === "string" || !content.some((p) => p.type === "file")) return content;

  const resolved: z.infer<typeof contentPartSchema>[] = [];
  for (const part of content) {
    if (part.type !== "file") {
      resolved.push(part);
      continue;
    }
    // file_id is a workspace-relative path — just pass it as a text reference.
    // The agent has read_file / list_files tools to access the actual content.
    resolved.push({
      type: "text",
      text: contextTrust === "enforce"
        ? renderRuntimeContextSegment(createRuntimeContextSegment({
            kind: "attachment.reference",
            sourceId: part.file_id,
            trust: "user",
            content: `Attached workspace file: ${part.file_id}`,
          }))
        : `[Attached file: ${part.file_id}]`,
    });
  }
  return resolved;
}

/**
 * Convert OpenAI-format content to AI SDK UserContent.
 *
 * AI SDK ImagePart: { type: "image", image: DataContent | URL, mediaType?: string }
 * AI SDK TextPart:  { type: "text", text: string }
 */
function toAIContent(content: z.infer<typeof messageSchema>["content"]): string | ({ type: "text"; text: string } | { type: "image"; image: string; mediaType?: string })[] {
  if (typeof content === "string") return content;

  const nonEmpty = content.filter((part) =>
    part.type !== "text" || (typeof part.text === "string" && part.text.trim() !== ""),
  );

  // Check if there are any image parts
  const hasImages = nonEmpty.some((p) => p.type === "image_url");
  if (!hasImages) {
    // Text-only array → flatten to plain string
    return nonEmpty
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  // Mixed content → convert to AI SDK TextPart | ImagePart array
  return nonEmpty.map((p) => {
    if (p.type === "text") {
      return { type: "text" as const, text: p.text };
    }
    if (p.type === "image_url") {
      const url = p.image_url.url;
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return { type: "image" as const, image: match[2], mediaType: match[1] };
      }
      return { type: "image" as const, image: url, mediaType: "image/png" };
    }
    // file parts should have been resolved by resolveFileContentParts already
    return { type: "text" as const, text: "" };
  }).filter((p) => p.type !== "text" || p.text !== "");
}

/**
 * Convert OpenAI-format messages from the request into AI SDK ModelMessage format.
 *
 * - System messages → extracted as extra context (appended to system prompt)
 * - User messages → { role: "user", content } with AI SDK content parts
 * - Assistant messages → { role: "assistant", content: string }
 */
export function convertMessages(
  messages: z.infer<typeof messageSchema>[],
  contextTrust: RuntimeContextTrustMode = "off",
): {
  aiMessages: any[];
  extraSystemParts: string[];
  runtimeContext: RuntimeContextSegment[];
} {
  const aiMessages: any[] = [];
  const extraSystemParts: string[] = [];
  const runtimeContext: RuntimeContextSegment[] = [];

  for (const [index, msg] of messages.entries()) {
    if (msg.role === "system") {
      const text = extractText(msg.content);
      if (hasText(text)) {
        extraSystemParts.push(text);
        runtimeContext.push(createRuntimeContextSegment({
          kind: "caller.system",
          sourceId: `message-${index}`,
          trust: "developer",
          content: text,
        }));
      }
    } else if (msg.role === "user") {
      // Resolve file content parts → text references (only in the AI SDK message, not persisted)
      const resolvedContent = resolveFileContentParts(msg.content, contextTrust);
      const content = toAIContent(resolvedContent);
      if (hasModelContent(content)) aiMessages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      // If the assistant message includes tool_calls (client-side tool), reconstruct as AI SDK format
      const tc = (msg as any).tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }> | undefined;
      if (tc?.length) {
        const parts: any[] = [];
        const text = extractText(msg.content);
        if (text) parts.push({ type: "text", text });
        for (const call of tc) {
          let input: unknown = {};
          try { input = JSON.parse(call.function.arguments); } catch { /* best effort */ }
          parts.push({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.function.name,
            input: objectInputOrEmpty(input),
          });
        }
        if (parts.length > 0) aiMessages.push({ role: "assistant", content: parts });
      } else {
        const text = extractText(msg.content);
        if (hasText(text)) aiMessages.push({ role: "assistant", content: text });
      }
    } else if (msg.role === "tool" && msg.tool_call_id) {
      const text = extractText(msg.content);
      // Client-side tool result — convert to AI SDK tool-result format
      aiMessages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: msg.tool_call_id,
          toolName: msg.name ?? "unknown",
          output: {
            type: "text" as const,
            value: contextTrust === "enforce"
              ? renderRuntimeToolResult(
                  msg.name ?? "unknown",
                  msg.tool_call_id,
                  hasText(text) ? text : "(empty tool result)",
                )
              : hasText(text) ? text : "(empty tool result)",
          },
        }],
      });
    }
  }

  return { aiMessages, extraSystemParts, runtimeContext };
}

export async function appendModelResponseMessages(
  messages: any[],
  result: any,
  turnText: string,
  toolCalls: any[],
  contextTrust: RuntimeContextTrustMode = "off",
): Promise<void> {
  try {
    const responseMessages = await result.responseMessages;
    if (Array.isArray(responseMessages) && responseMessages.length > 0) {
      const normalized = normalizeToolCallHistory(responseMessages);
      messages.push(...(contextTrust === "enforce"
        ? protectRuntimeToolResultMessages(normalized)
        : normalized));
      return;
    }
  } catch {
    // Older/partial AI SDK results can still be represented manually below.
  }

  const assistantContent: any[] = [];
  if (turnText) assistantContent.push({ type: "text", text: turnText });
  for (const tc of toolCalls) {
    assistantContent.push({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: objectInputOrEmpty(tc.input),
    });
  }
  messages.push({
    role: "assistant",
    content: assistantContent.length === 1 && assistantContent[0].type === "text"
      ? turnText
      : assistantContent,
  });
}
