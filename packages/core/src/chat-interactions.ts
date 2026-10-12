/** Provider-neutral chat interaction policy and public extension contracts. */

import type { AllowedToolsSettings } from "./tool-policy.js";

export const DEFAULT_CHAT_SUGGESTION_COUNT = 3;
export const MIN_CHAT_SUGGESTION_COUNT = 2;
export const MAX_CHAT_SUGGESTION_COUNT = 5;
export const MAX_CHAT_SUGGESTION_GUIDANCE_CHARS = 500;
export const MAX_CHAT_SUGGESTION_CONTEXT_CHARS = 8_192;
export const MAX_CHAT_SUGGESTION_CONTEXT_DEPTH = 8;

export type ChatSuggestionContextValue = string | number | boolean | null
  | ChatSuggestionContextValue[] | { [key: string]: ChatSuggestionContextValue };

/** Request-scoped hints supplied by the application; never authorization policy. */
export interface ChatSuggestionRequestOptions {
  /** An options object opts in unless explicitly disabled. Agent policy still applies. */
  enabled?: boolean;
  /** Override the agent's count for this turn (2-5). */
  maxItems?: number;
  /** Phase guidance, used in addition to the agent's static guidance (500 characters). */
  guidance?: string;
  /** JSON snapshot of application state, at most 8192 serialized characters / 8 levels. */
  context?: Record<string, ChatSuggestionContextValue>;
}

/** Validate bounded JSON before it reaches an auxiliary model or durable request. */
export function normalizeChatSuggestionRequest(value: unknown): ChatSuggestionRequestOptions & { enabled: boolean } {
  if (value === undefined || typeof value === "boolean") return { enabled: value === true };
  const request = asRecord(value, "suggestions");
  const settings = normalizeChatInteractionSettings({ suggestions: request }).suggestions;
  let context: Record<string, ChatSuggestionContextValue> | undefined;
  if (request.context !== undefined) {
    asRecord(request.context, "suggestions.context");
    const seen = new Set<object>();
    let nodes = 0;
    const check = (item: unknown, depth: number): void => {
      if (++nodes > 1024 || depth > MAX_CHAT_SUGGESTION_CONTEXT_DEPTH) {
        throw new TypeError("suggestions.context exceeds the depth or size limit");
      }
      if (item === null || typeof item === "boolean") return;
      if (typeof item === "string" && item.length <= MAX_CHAT_SUGGESTION_CONTEXT_CHARS) return;
      if (typeof item === "number" && Number.isFinite(item)) return;
      if (!item || typeof item !== "object" || seen.has(item)) {
        throw new TypeError("suggestions.context must contain finite, acyclic JSON values");
      }
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new TypeError("suggestions.context must contain plain JSON objects");
      }
      seen.add(item);
      for (const nested of Object.values(item)) check(nested, depth + 1);
      seen.delete(item);
    };
    check(request.context, 0);
    const serialized = JSON.stringify(request.context);
    if (serialized.length > MAX_CHAT_SUGGESTION_CONTEXT_CHARS) {
      throw new TypeError(`suggestions.context must be at most ${MAX_CHAT_SUGGESTION_CONTEXT_CHARS} serialized characters`);
    }
    context = JSON.parse(serialized);
  }
  return {
    enabled: request.enabled !== false,
    ...(request.maxItems === undefined ? {} : { maxItems: settings.maxItems }),
    ...(settings.guidance ? { guidance: settings.guidance } : {}),
    ...(context === undefined ? {} : { context }),
  };
}

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question" as const;

/** Client-rendered tools that may suspend a direct chat turn. */
export const CLIENT_INTERACTION_TOOL_NAMES = [
  ASK_USER_QUESTION_TOOL_NAME,
] as const;

export function isClientInteractionToolName(
  value: unknown,
): value is (typeof CLIENT_INTERACTION_TOOL_NAMES)[number] {
  return typeof value === "string"
    && (CLIENT_INTERACTION_TOOL_NAMES as readonly string[]).includes(value);
}

export interface ChatSuggestion {
  /** Stable identifier within the assistant message that produced it. */
  id: string;
  /** Short user-facing action label. */
  label: string;
  /** Exact text to send as the next user message when selected. */
  prompt: string;
}

export interface ChatSuggestionSettings {
  /** Generate suggested next messages after successful text responses. */
  enabled?: boolean;
  /** Maximum suggestions returned per response. Allowed range: 2-5. */
  maxItems?: number;
  /** Optional agent-specific guidance for suggestion generation. */
  guidance?: string;
}

export interface ChatInteractionSettings extends AllowedToolsSettings {
  /** Allow compatible clients to receive the ask_user_question tool. Default: true. */
  allowUserQuestions?: boolean;
  /** Suggested-next-message policy. Disabled by default. */
  suggestions?: ChatSuggestionSettings;
}

export interface NormalizedChatInteractionSettings {
  allowedTools?: readonly string[];
  allowUserQuestions: boolean;
  suggestions: {
    enabled: boolean;
    maxItems: number;
    guidance?: string;
  };
}

export interface ChatInteractionClientCapabilities {
  ask_user_question?: boolean;
  suggestions?: boolean | ChatSuggestionRequestOptions;
}

export interface ResolvedChatInteractionCapabilities {
  askUserQuestion: boolean;
  suggestions: boolean;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

/** Validate and normalize chat settings at configuration boundaries. */
export function normalizeChatInteractionSettings(
  value: unknown,
): NormalizedChatInteractionSettings {
  const settings = asRecord(value, "chat");
  const suggestions = asRecord(settings.suggestions, "chat.suggestions");
  const allowUserQuestions = optionalBoolean(
    settings.allowUserQuestions,
    "chat.allowUserQuestions",
  ) ?? true;
  let allowedTools: readonly string[] | undefined;
  if (settings.allowedTools !== undefined) {
    if (!Array.isArray(settings.allowedTools)) {
      throw new TypeError("chat.allowedTools must be an array");
    }
    const seen = new Set<string>();
    allowedTools = Object.freeze(settings.allowedTools.map((entry, index) => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new TypeError(`chat.allowedTools[${index}] must be a non-empty string`);
      }
      const normalized = entry.trim();
      const key = normalized.toLocaleLowerCase("en-US");
      if (seen.has(key)) {
        throw new TypeError(`chat.allowedTools contains duplicate tool pattern "${normalized}"`);
      }
      seen.add(key);
      return normalized;
    }));
  }
  const enabled = optionalBoolean(
    suggestions.enabled,
    "chat.suggestions.enabled",
  ) ?? false;
  const maxItems = suggestions.maxItems ?? DEFAULT_CHAT_SUGGESTION_COUNT;
  if (
    !Number.isInteger(maxItems)
    || (maxItems as number) < MIN_CHAT_SUGGESTION_COUNT
    || (maxItems as number) > MAX_CHAT_SUGGESTION_COUNT
  ) {
    throw new TypeError(
      `chat.suggestions.maxItems must be an integer between ${MIN_CHAT_SUGGESTION_COUNT} and ${MAX_CHAT_SUGGESTION_COUNT}`,
    );
  }

  let guidance: string | undefined;
  if (suggestions.guidance !== undefined) {
    if (typeof suggestions.guidance !== "string") {
      throw new TypeError("chat.suggestions.guidance must be a string");
    }
    guidance = suggestions.guidance.trim() || undefined;
    if (guidance && guidance.length > MAX_CHAT_SUGGESTION_GUIDANCE_CHARS) {
      throw new TypeError(
        `chat.suggestions.guidance must be at most ${MAX_CHAT_SUGGESTION_GUIDANCE_CHARS} characters`,
      );
    }
  }

  return {
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    allowUserQuestions,
    suggestions: {
      enabled,
      maxItems: maxItems as number,
      ...(guidance ? { guidance } : {}),
    },
  };
}

/** Resolve agent policy against the current client and invocation surface. */
export function resolveChatInteractionCapabilities(input: {
  surface?: string;
  settings?: ChatInteractionSettings;
  client?: ChatInteractionClientCapabilities;
}): ResolvedChatInteractionCapabilities {
  const settings = normalizeChatInteractionSettings(input.settings);
  if (input.surface === "channel") {
    return { askUserQuestion: false, suggestions: false };
  }
  return {
    askUserQuestion:
      settings.allowUserQuestions
      && input.client?.ask_user_question !== false,
    suggestions:
      settings.suggestions.enabled
      && normalizeChatSuggestionRequest(input.client?.suggestions).enabled,
  };
}
