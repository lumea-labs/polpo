/**
 * Claude Code–compatible hook configuration: the `hooks` object of a Claude
 * settings file, accepted unchanged, wrapped by a named Polpo pack.
 */
import {
  HOOK_EVENTS,
  HOOK_HANDLER_TYPES,
  isHookEventName,
  type HookEventName,
  type HookHandlerType,
} from "./events.js";
import { compileHookMatcher } from "./matcher.js";
import { parsePermissionRule } from "./permission-rule.js";

interface HookHandlerCommon {
  /** Permission-rule filter, evaluated only on tool events. */
  if?: string;
  /** Seconds before canceling. */
  timeout?: number;
  statusMessage?: string;
  /** Honored only for hooks declared by a skill. */
  once?: boolean;
}

export interface CommandHookHandler extends HookHandlerCommon {
  type: "command";
  command: string;
  args?: string[];
  async?: boolean;
  asyncRewake?: boolean;
  shell?: "bash" | "powershell";
  onFailure?: "continue" | "block";
}

export interface HttpHookHandler extends HookHandlerCommon {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  onFailure?: "continue" | "block";
}

export interface McpToolHookHandler extends HookHandlerCommon {
  type: "mcp_tool";
  server: string;
  tool: string;
  input?: Record<string, unknown>;
}

export interface PromptHookHandler extends HookHandlerCommon {
  type: "prompt";
  prompt: string;
  model?: string;
  continueOnBlock?: boolean;
}

export interface AgentHookHandler extends HookHandlerCommon {
  type: "agent";
  prompt: string;
  model?: string;
}

export type HookHandler =
  | CommandHookHandler
  | HttpHookHandler
  | McpToolHookHandler
  | PromptHookHandler
  | AgentHookHandler;

export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}

/** The `hooks` object of a Claude Code settings file. */
export type HooksConfig = Partial<Record<HookEventName, HookMatcherGroup[]>>;

/** A named Polpo deployment of one unchanged Claude `hooks` object. */
export interface HookPack {
  name: string;
  description?: string;
  hooks: HooksConfig;
}

/** Named pack storage (project files, Cloud database). */
export interface HookPackStore {
  list(): Promise<HookPack[]>;
  get(name: string): Promise<HookPack | undefined>;
  put(pack: HookPack): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** Where a hook was declared. Order is precedence/declaration order. */
export type HookSource =
  | "policy"
  | "project"
  | "local"
  | "agent"
  | "skill"
  | "subagent"
  | "session";

export const HOOK_SOURCES: readonly HookSource[] = [
  "policy", "project", "local", "agent", "skill", "subagent", "session",
];

export class HookConfigError extends Error {
  override readonly name = "HookConfigError";
  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
  }
}

const HANDLER_TYPES = new Set<string>(HOOK_HANDLER_TYPES);
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const MAX_PACK_NAME = 128;

/**
 * Validate a `hooks` object. Rejects unknown events, handler types not accepted
 * by the event, malformed fields and invalid matcher regular expressions so a
 * broken policy fails at deploy time instead of silently not firing.
 */
export function validateHooksConfig(input: unknown, path = "hooks"): HooksConfig {
  if (!isRecord(input)) throw new HookConfigError("must be an object keyed by hook event name", path);
  const out: HooksConfig = {};
  for (const [event, groups] of Object.entries(input)) {
    const eventPath = `${path}.${event}`;
    if (!isHookEventName(event)) throw new HookConfigError("is not a supported hook event", eventPath);
    if (!Array.isArray(groups)) throw new HookConfigError("must be an array of matcher groups", eventPath);
    out[event] = groups.map((group, index) => validateMatcherGroup(event, group, `${eventPath}[${index}]`));
  }
  return out;
}

function validateMatcherGroup(event: HookEventName, input: unknown, path: string): HookMatcherGroup {
  if (!isRecord(input)) throw new HookConfigError("must be an object", path);
  if (input.matcher !== undefined) {
    if (typeof input.matcher !== "string") throw new HookConfigError("matcher must be a string", path);
    if (input.matcher.length > 4_096) throw new HookConfigError("matcher is too long", path);
    // Events without matcher support ignore it, exactly as the reference does.
    if (HOOK_EVENTS[event].matcher !== "none") {
      try {
        compileHookMatcher(event, input.matcher);
      } catch (error) {
        throw new HookConfigError(`matcher is not a valid regular expression: ${(error as Error).message}`, path);
      }
    }
  }
  if (!Array.isArray(input.hooks) || input.hooks.length === 0) {
    throw new HookConfigError("hooks must be a non-empty array of handlers", path);
  }
  return {
    ...(input.matcher !== undefined ? { matcher: input.matcher as string } : {}),
    hooks: input.hooks.map((handler, index) => validateHandler(event, handler, `${path}.hooks[${index}]`)),
  };
}

function validateHandler(event: HookEventName, input: unknown, path: string): HookHandler {
  if (!isRecord(input)) throw new HookConfigError("must be an object", path);
  const type = input.type;
  if (typeof type !== "string" || !HANDLER_TYPES.has(type)) {
    throw new HookConfigError(`type must be one of ${HOOK_HANDLER_TYPES.join(", ")}`, path);
  }
  const handlerType = type as HookHandlerType;
  if (!HOOK_EVENTS[event].handlers.includes(handlerType)) {
    throw new HookConfigError(`${event} does not support "${handlerType}" hooks`, path);
  }
  // Unknown fields are ignored, as in Claude Code settings, so a hook written
  // for a newer reference still deploys; only recognized fields are validated.
  const str = (field: string, required: boolean): void => {
    const value = input[field];
    if (value === undefined && !required) return;
    if (typeof value !== "string" || (required && !value.trim())) {
      throw new HookConfigError(`${field} must be a${required ? " non-empty" : ""} string`, path);
    }
  };
  const bool = (field: string): void => {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      throw new HookConfigError(`${field} must be a boolean`, path);
    }
  };
  const stringArray = (field: string): void => {
    const value = input[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw new HookConfigError(`${field} must be an array of strings`, path);
    }
  };
  const onFailure = (): void => {
    if (input.onFailure !== undefined && input.onFailure !== "continue" && input.onFailure !== "block") {
      throw new HookConfigError('onFailure must be "continue" or "block"', path);
    }
  };

  str("if", false);
  str("statusMessage", false);
  bool("once");
  if (input.timeout !== undefined) {
    const timeout = input.timeout;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
      throw new HookConfigError(`timeout must be a positive number of seconds up to ${MAX_TIMEOUT_SECONDS}`, path);
    }
  }
  if (typeof input.if === "string") {
    try {
      parsePermissionRule(input.if);
    } catch (error) {
      throw new HookConfigError(`if is not a valid permission rule: ${(error as Error).message}`, path);
    }
  }

  switch (handlerType) {
    case "command":
      str("command", true);
      stringArray("args");
      bool("async");
      bool("asyncRewake");
      onFailure();
      if (input.shell !== undefined && input.shell !== "bash" && input.shell !== "powershell") {
        throw new HookConfigError('shell must be "bash" or "powershell"', path);
      }
      break;
    case "http": {
      str("url", true);
      let url: URL;
      try {
        url = new URL(input.url as string);
      } catch {
        throw new HookConfigError("url is not a valid URL", path);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new HookConfigError("url must use http or https", path);
      }
      if (url.username || url.password) throw new HookConfigError("url must not embed credentials", path);
      if (input.headers !== undefined && (!isRecord(input.headers) || Object.values(input.headers).some((v) => typeof v !== "string"))) {
        throw new HookConfigError("headers must map names to string values", path);
      }
      stringArray("allowedEnvVars");
      onFailure();
      break;
    }
    case "mcp_tool":
      str("server", true);
      str("tool", true);
      if (input.input !== undefined && !isRecord(input.input)) throw new HookConfigError("input must be an object", path);
      break;
    case "prompt":
      str("prompt", true);
      str("model", false);
      bool("continueOnBlock");
      break;
    case "agent":
      str("prompt", true);
      str("model", false);
      break;
  }
  return structuredClone(input) as unknown as HookHandler;
}

/** Validate a named pack: `{ name, description?, hooks }`. */
export function validateHookPack(input: unknown): HookPack {
  if (!isRecord(input)) throw new HookConfigError("must be an object", "pack");
  if (Array.isArray(input.hooks)) {
    throw new HookConfigError(
      "uses the removed array format; use the Claude Code hooks object: { \"hooks\": { \"PreToolUse\": [{ \"matcher\": \"Bash\", \"hooks\": [...] }] } }",
      "pack.hooks",
    );
  }
  for (const key of Object.keys(input)) {
    if (key !== "name" && key !== "description" && key !== "hooks") {
      throw new HookConfigError(`has unknown field "${key}"`, "pack");
    }
  }
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > MAX_PACK_NAME) {
    throw new HookConfigError(`name must contain 1-${MAX_PACK_NAME} characters`, "pack.name");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new HookConfigError("description must be a string", "pack.description");
  }
  return {
    name: input.name,
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    hooks: validateHooksConfig(input.hooks, "pack.hooks"),
  };
}

/** Extract and validate the `hooks` block of a Claude Code settings file. */
export function hooksFromClaudeSettings(settings: unknown): HooksConfig {
  if (!isRecord(settings)) throw new HookConfigError("must be an object", "settings");
  if (settings.hooks === undefined) return {};
  return validateHooksConfig(settings.hooks, "settings.hooks");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
