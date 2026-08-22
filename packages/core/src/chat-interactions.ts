/** Provider-neutral chat interaction policy and public extension contracts. */

import type { AllowedToolsSettings } from "./tool-policy.js";

export const DEFAULT_CHAT_SUGGESTION_COUNT = 3;
export const MIN_CHAT_SUGGESTION_COUNT = 2;
export const MAX_CHAT_SUGGESTION_COUNT = 4;
export const MAX_CHAT_SUGGESTION_GUIDANCE_CHARS = 500;

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
  /** Maximum suggestions returned per response. Allowed range: 2-4. */
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
  suggestions?: boolean;
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
      && input.client?.suggestions === true,
  };
}
