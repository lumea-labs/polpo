import type { ChatSuggestion } from "@polpo-ai/core/chat-interactions";
import { generateText, Output, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod";

const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARS = 7_000;
const MAX_FINAL_TEXT_CHARS = 4_000;
const MAX_LABEL_CHARS = 64;
const MAX_PROMPT_CHARS = 500;
const DEFAULT_TIMEOUT_MS = 4_000;

const generatedSuggestionsSchema = z.object({
  suggestions: z.array(z.object({
    label: z.string().min(1).max(MAX_LABEL_CHARS),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  }).strict()).max(4),
}).strict();

interface SuggestionGenerationResponse {
  output?: unknown;
  usage?: LanguageModelUsage;
  providerMetadata?: Record<string, unknown>;
}

export type ChatSuggestionGenerate = (
  options: Record<string, unknown>,
) => Promise<SuggestionGenerationResponse>;

export interface GenerateChatSuggestionsInput {
  model: LanguageModel;
  providerOptions?: Record<string, any>;
  messages: Array<{ role?: unknown; content?: unknown }>;
  finalText: string;
  maxItems: number;
  guidance?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  generate?: ChatSuggestionGenerate;
}

export interface ChatSuggestionGenerationResult {
  suggestions: ChatSuggestion[];
  usage?: LanguageModelUsage;
  providerMetadata?: Record<string, unknown>;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return value.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function boundedConversation(
  messages: GenerateChatSuggestionsInput["messages"],
): Array<{ role: "user" | "assistant"; content: string }> {
  const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (const message of messages.slice(-MAX_CONTEXT_MESSAGES).reverse()) {
    if (remaining <= 0) break;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = textFromContent(message.content).trim();
    if (!content) continue;
    const bounded = content.slice(-remaining);
    remaining -= bounded.length;
    selected.push({ role: message.role, content: bounded });
  }
  return selected.reverse();
}

function compactWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stableSuggestionId(label: string, prompt: string): string {
  let hash = 2166136261;
  const value = `${label}\u0000${prompt}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `suggestion_${(hash >>> 0).toString(36)}`;
}

function sanitizeSuggestions(
  value: unknown,
  maxItems: number,
): ChatSuggestion[] {
  const parsed = generatedSuggestionsSchema.safeParse(value);
  if (!parsed.success) return [];
  const suggestions: ChatSuggestion[] = [];
  const seenPrompts = new Set<string>();
  for (const item of parsed.data.suggestions) {
    const label = compactWhitespace(item.label).slice(0, MAX_LABEL_CHARS);
    const prompt = compactWhitespace(item.prompt).slice(0, MAX_PROMPT_CHARS);
    const key = prompt.toLocaleLowerCase();
    if (!label || !prompt || seenPrompts.has(key)) continue;
    seenPrompts.add(key);
    suggestions.push({
      id: stableSuggestionId(label, prompt),
      label,
      prompt,
    });
    if (suggestions.length >= maxItems) break;
  }
  return suggestions;
}

/** Generate optional next-message suggestions without affecting the main turn. */
export async function generateChatSuggestions(
  input: GenerateChatSuggestionsInput,
): Promise<ChatSuggestionGenerationResult> {
  const finalText = input.finalText.trim();
  if (!finalText || input.signal?.aborted) return { suggestions: [] };

  const maxItems = Math.max(2, Math.min(4, Math.trunc(input.maxItems)));
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(new Error("Chat suggestion generation timed out"));
      reject(new Error("Chat suggestion generation timed out"));
    }, timeoutMs);
  });

  try {
    const generate = input.generate
      ?? (generateText as unknown as ChatSuggestionGenerate);
    const response = await Promise.race([
      generate({
        model: input.model,
        system: [
          "Suggest concise, useful next messages the user could send after this assistant response.",
          "Each label is a short action. Each prompt is the exact standalone user message to send.",
          "Do not repeat the assistant response. Do not invent unsupported capabilities.",
          "Return no suggestions when there is no meaningful next step.",
        ].join(" "),
        prompt: JSON.stringify({
          maxItems,
          ...(input.guidance ? { guidance: input.guidance } : {}),
          conversation: boundedConversation(input.messages),
          assistantResponse: finalText.slice(-MAX_FINAL_TEXT_CHARS),
        }),
        output: Output.object({ schema: generatedSuggestionsSchema }),
        temperature: 0.2,
        maxOutputTokens: 384,
        abortSignal: controller.signal,
        ...(input.providerOptions
          ? { providerOptions: input.providerOptions }
          : {}),
      }),
      timeout,
    ]);
    const suggestions = sanitizeSuggestions(response.output, maxItems);
    return {
      suggestions,
      ...(response.usage ? { usage: response.usage } : {}),
      ...(response.providerMetadata
        ? { providerMetadata: response.providerMetadata }
        : {}),
    };
  } catch {
    return { suggestions: [] };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}
