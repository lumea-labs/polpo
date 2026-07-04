/**
 * OpenAI-format → AI SDK message/content conversion for the chat
 * completions endpoint.
 */

import type { z } from "@hono/zod-openapi";
import type { contentPartSchema, messageSchema } from "./schemas.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Extract plain text from a content field (string or content-part array). */
export function extractText(content: z.infer<typeof messageSchema>["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Resolve file content parts → text references the agent can act on with its tools. */
function resolveFileContentParts(
  content: z.infer<typeof messageSchema>["content"],
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
      text: `[Attached file: ${part.file_id}]`,
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

  // Check if there are any image parts
  const hasImages = content.some((p) => p.type === "image_url");
  if (!hasImages) {
    // Text-only array → flatten to plain string
    return content.map((p) => (p as { type: "text"; text: string }).text).join("\n");
  }

  // Mixed content → convert to AI SDK TextPart | ImagePart array
  return content.map((p) => {
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
): { aiMessages: any[]; extraSystemParts: string[] } {
  const aiMessages: any[] = [];
  const extraSystemParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      extraSystemParts.push(extractText(msg.content));
    } else if (msg.role === "user") {
      // Resolve file content parts → text references (only in the AI SDK message, not persisted)
      const resolvedContent = resolveFileContentParts(msg.content);
      aiMessages.push({ role: "user", content: toAIContent(resolvedContent) });
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
            input,
          });
        }
        aiMessages.push({ role: "assistant", content: parts });
      } else {
        aiMessages.push({ role: "assistant", content: extractText(msg.content) });
      }
    } else if (msg.role === "tool" && msg.tool_call_id) {
      // Client-side tool result — convert to AI SDK tool-result format
      aiMessages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: msg.tool_call_id,
          toolName: msg.name ?? "unknown",
          output: { type: "text" as const, value: extractText(msg.content) },
        }],
      });
    }
  }

  return { aiMessages, extraSystemParts };
}

export async function appendModelResponseMessages(
  messages: any[],
  result: any,
  turnText: string,
  toolCalls: any[],
): Promise<void> {
  try {
    const responseMessages = await result.responseMessages;
    if (Array.isArray(responseMessages) && responseMessages.length > 0) {
      messages.push(...responseMessages);
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
      input: tc.input,
    });
  }
  messages.push({
    role: "assistant",
    content: assistantContent.length === 1 && assistantContent[0].type === "text"
      ? turnText
      : assistantContent,
  });
}
