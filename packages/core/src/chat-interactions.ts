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
  /** Caller-authored actions, shown first in caller order within maxItems. Never model-generated. */
  actions?: readonly ChatActionSuggestionInput[];
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
    ...(request.actions === undefined ? {} : { actions: normalizeChatSuggestionActions(request.actions) }),
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

export interface ChatMessageSuggestion {
  /** Stable identifier within the assistant message that produced it. */
  id: string;
  /** Short user-facing action label. */
  label: string;
  /** Exact text to send as the next user message when selected. */
  prompt: string;
  /** Absent in legacy responses/history. Action-capable requests receive an explicit kind. */
  kind?: "message";
}

export type ChatSuggestionAction =
  | { type: "open_url"; url: string }
  | { type: "postback"; value: string };

export interface ChatActionSuggestionInput {
  kind: "action";
  /** Optional stable caller ID; omitted IDs are assigned by request order. */
  id?: string;
  label: string;
  action: ChatSuggestionAction;
}

export interface ChatActionSuggestion extends ChatActionSuggestionInput {
  id: string;
}

export type ChatSuggestion = ChatMessageSuggestion | ChatActionSuggestion;

function normalizeChatSuggestionActions(value: unknown): ChatActionSuggestion[] {
  if (!Array.isArray(value) || value.length > MAX_CHAT_SUGGESTION_COUNT) {
    throw new TypeError(`suggestions.actions must be an array of at most ${MAX_CHAT_SUGGESTION_COUNT} actions`);
  }
  const ids = new Set<string>();
  const text = (value: unknown, field: string, max: number): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      throw new TypeError(`suggestions.actions ${field} must be a non-empty string of at most ${max} characters`);
    }
    return value.trim();
  };
  const record = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
    const result = asRecord(value, "suggestions.actions item");
    if (value === undefined || (Object.getPrototypeOf(result) !== Object.prototype && Object.getPrototypeOf(result) !== null)
      || Object.keys(result).some(key => !fields.includes(key))) {
      throw new TypeError("suggestions.actions contains unsupported fields");
    }
    return result;
  };
  const items = value.map(candidate => record(candidate, ["kind", "id", "label", "action"]));
  // Reserve caller IDs before assigning any defaults, including IDs supplied
  // later in the array. Only duplicate explicit IDs are invalid requests.
  const explicitIds = items.map(item => item.id === undefined ? undefined : text(item.id, "id", 64));
  for (const id of explicitIds) {
    if (id === undefined) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id) || ids.has(id)) {
      throw new TypeError("suggestions.actions IDs must be valid and unique");
    }
    ids.add(id);
  }
  return items.map((item, index) => {
    if (item.kind !== "action") throw new TypeError("suggestions.actions kind must be action");
    let id = explicitIds[index];
    if (id === undefined) {
      let sequence = index + 1;
      do { id = `action_${sequence++}`; } while (ids.has(id));
      ids.add(id);
    }
    const label = text(item.label, "label", 64);
    const action = asRecord(item.action, "suggestions.actions action");
    if (action.type === "open_url") {
      record(action, ["type", "url"]);
      const url = text(action.url, "url", 2048);
      const parsed = new URL(url);
      if (!/^https:\/\//i.test(url) || url[8] === "/" || url.includes("\\")
        || parsed.protocol !== "https:" || parsed.username || parsed.password || /[\u0000-\u0020\u007f]/.test(url)) {
        throw new TypeError("suggestions.actions URL must be absolute HTTPS without credentials, backslashes or whitespace");
      }
      return { kind: "action", id, label, action: { type: "open_url", url } };
    }
    if (action.type === "postback") {
      record(action, ["type", "value"]);
      text(action.value, "value", 2000);
      return { kind: "action", id, label, action: { type: "postback", value: action.value as string } };
    }
    throw new TypeError("suggestions.actions action must be open_url or postback");
  });
}

export interface ChatSuggestionPlan {
  maxItems: number;
  generatedCount: number;
  actions: ChatActionSuggestion[];
  includeKinds: boolean;
}

/** Allocate one stable output budget. Eligibility remains an agent/client/host decision. */
export function resolveChatSuggestionPlan(
  settings: ChatSuggestionSettings,
  value: boolean | ChatSuggestionRequestOptions | undefined,
): ChatSuggestionPlan {
  const request = normalizeChatSuggestionRequest(value);
  const maxItems = request.maxItems ?? normalizeChatInteractionSettings({ suggestions: settings }).suggestions.maxItems;
  const actions = request.enabled ? normalizeChatSuggestionActions(request.actions ?? []).slice(0, maxItems) : [];
  return { maxItems, actions, generatedCount: request.enabled ? maxItems - actions.length : 0,
    includeKinds: request.actions !== undefined };
}

/** Add only model-produced messages; models never supply the action payload. */
export function combineChatSuggestions(plan: ChatSuggestionPlan, messages: readonly ChatMessageSuggestion[]): ChatSuggestion[] {
  const result: ChatSuggestion[] = [...plan.actions];
  const limit = Math.min(plan.maxItems, plan.actions.length + plan.generatedCount);
  const ids = new Set(result.map(item => item.id));
  for (const item of messages) {
    if (result.length >= limit) break;
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    result.push(plan.includeKinds ? { ...item, kind: "message" } : item);
  }
  return result;
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
  return {
    askUserQuestion:
      input.surface !== "channel"
      && settings.allowUserQuestions
      && input.client?.ask_user_question !== false,
    suggestions:
      settings.suggestions.enabled
      && normalizeChatSuggestionRequest(input.client?.suggestions).enabled,
  };
}
