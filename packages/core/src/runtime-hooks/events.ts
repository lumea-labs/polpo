/**
 * Claude Code hook conformance manifest.
 *
 * Reference: https://code.claude.com/docs/en/hooks as published on 2026-10-24.
 * Every behavioral difference between events is data here, never inferred by
 * adapters. Changing a row is a contract change and needs a fixture update.
 */

export const HOOK_REFERENCE_BASELINE = "claude-code-hooks@2026-10-24" as const;

export const HOOK_EVENT_NAMES = [
  "SessionStart",
  "Setup",
  "InstructionsLoaded",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "MessageDisplay",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "SessionEnd",
  "Elicitation",
  "ElicitationResult",
] as const;

export type HookEventName = typeof HOOK_EVENT_NAMES[number];

export const HOOK_HANDLER_TYPES = ["command", "http", "mcp_tool", "prompt", "agent"] as const;
export type HookHandlerType = typeof HOOK_HANDLER_TYPES[number];

/**
 * How the `matcher` of a matcher group selects an occurrence.
 * - `standard`: exact list on letters/digits/_/-/space/,/|, otherwise unanchored regex.
 * - `narrow`: exact list on letters/digits/_/| only (FileChanged, StopFailure).
 * - `none`: the event has no matcher support; a matcher is silently ignored.
 */
export type HookMatcherKind = "standard" | "narrow" | "none";

/** What exit code 2 (or `onFailure: "block"`) does on this event. */
export type HookExit2Effect =
  /** Blocks the pending action; stderr is the reason shown to the model. */
  | "block_action"
  /** Blocks the pending action; stderr is shown to the user, not the model. */
  | "block_action_user"
  /** Keeps the responsible agent working with stderr as feedback. */
  | "continue_agent"
  /** The action already happened; stderr is shown to the model. */
  | "feedback_to_model"
  /** stderr is shown to the user only. */
  | "user_notice"
  /** Exit code and stderr are ignored. */
  | "ignored"
  /** Any non-zero exit fails the action (worktree events). */
  | "fail_action";

export interface HookEventSpec {
  readonly name: HookEventName;
  readonly matcher: HookMatcherKind;
  /** The input field the matcher is evaluated against, when it is a plain field. */
  readonly matcherField?: string;
  /** Handler types accepted in configuration for this event. */
  readonly handlers: readonly HookHandlerType[];
  /** Handler types accepted in configuration but never executed on this event. */
  readonly skippedHandlers?: readonly HookHandlerType[];
  /** Default timeout (seconds) for command/http/mcp_tool when not configured. */
  readonly defaultTimeoutSeconds: number;
  readonly exit2: HookExit2Effect;
  /** `onFailure` has no effect on these events. */
  readonly onFailureIgnored?: boolean;
  /** `if` is evaluated only on tool events. */
  readonly toolEvent?: boolean;
  /** Plain-text stdout on exit 0 becomes model context. */
  readonly plainStdoutIsContext?: boolean;
  /** JSON output is discarded on every exit code (side-effect fields aside). */
  readonly discardsOutput?: boolean;
  /** `systemMessage` / `continue` are discarded on this event. */
  readonly discardsSystemMessage?: boolean;
  readonly discardsContinue?: boolean;
  /** Exit 2 with empty stdout and a missing-file stderr is a non-blocking error. */
  readonly missingFileExit2IsNonBlocking?: boolean;
  /** `hookSpecificOutput` applies only on exit 0. */
  readonly specificOutputOnlyOnExit0?: boolean;
  /** A timed-out hook blocks the action (PreModelSwitch). */
  readonly timeoutBlocks?: boolean;
  /** Events where hooks run detached from the action (observability). */
  readonly observational?: boolean;
}

const ALL: readonly HookHandlerType[] = HOOK_HANDLER_TYPES;
const NO_MODEL: readonly HookHandlerType[] = ["command", "http", "mcp_tool"];

const spec = (s: HookEventSpec): HookEventSpec => Object.freeze(s);

export const HOOK_EVENTS: Readonly<Record<HookEventName, HookEventSpec>> = Object.freeze({
  SessionStart: spec({
    name: "SessionStart", matcher: "standard", matcherField: "source",
    handlers: ["command", "mcp_tool"], defaultTimeoutSeconds: 600,
    exit2: "user_notice", plainStdoutIsContext: true,
  }),
  Setup: spec({
    name: "Setup", matcher: "standard", matcherField: "trigger",
    handlers: ["command", "mcp_tool"], skippedHandlers: ["mcp_tool"], defaultTimeoutSeconds: 600,
    exit2: "ignored", discardsOutput: true,
  }),
  InstructionsLoaded: spec({
    name: "InstructionsLoaded", matcher: "standard", matcherField: "load_reason",
    handlers: NO_MODEL, defaultTimeoutSeconds: 600, exit2: "ignored",
    discardsOutput: true, observational: true,
  }),
  UserPromptSubmit: spec({
    name: "UserPromptSubmit", matcher: "none", handlers: ALL, defaultTimeoutSeconds: 30,
    exit2: "block_action_user", plainStdoutIsContext: true,
  }),
  UserPromptExpansion: spec({
    name: "UserPromptExpansion", matcher: "standard", matcherField: "command_name",
    handlers: ALL, defaultTimeoutSeconds: 600, exit2: "block_action_user", plainStdoutIsContext: true,
  }),
  MessageDisplay: spec({
    name: "MessageDisplay", matcher: "none", handlers: NO_MODEL, defaultTimeoutSeconds: 10,
    exit2: "ignored", discardsSystemMessage: true, discardsContinue: true,
  }),
  PreToolUse: spec({
    name: "PreToolUse", matcher: "standard", matcherField: "tool_name", handlers: ALL,
    defaultTimeoutSeconds: 600, exit2: "block_action", toolEvent: true,
  }),
  PermissionRequest: spec({
    name: "PermissionRequest", matcher: "standard", matcherField: "tool_name",
    handlers: ["command", "http", "mcp_tool", "prompt", "agent"], skippedHandlers: ["agent"],
    defaultTimeoutSeconds: 600, exit2: "ignored", toolEvent: true,
  }),
  PermissionDenied: spec({
    name: "PermissionDenied", matcher: "standard", matcherField: "tool_name", handlers: ALL,
    defaultTimeoutSeconds: 600, exit2: "ignored", toolEvent: true,
  }),
  PostToolUse: spec({
    name: "PostToolUse", matcher: "standard", matcherField: "tool_name", handlers: ALL,
    defaultTimeoutSeconds: 600, exit2: "feedback_to_model", toolEvent: true,
  }),
  PostToolUseFailure: spec({
    name: "PostToolUseFailure", matcher: "standard", matcherField: "tool_name", handlers: ALL,
    defaultTimeoutSeconds: 600, exit2: "feedback_to_model", toolEvent: true,
  }),
  PostToolBatch: spec({
    name: "PostToolBatch", matcher: "none", handlers: ALL, defaultTimeoutSeconds: 600,
    exit2: "block_action",
  }),
  Notification: spec({
    name: "Notification", matcher: "standard", matcherField: "notification_type",
    handlers: NO_MODEL, defaultTimeoutSeconds: 600, exit2: "ignored",
    discardsSystemMessage: true, discardsContinue: true, observational: true,
  }),
  SubagentStart: spec({
    name: "SubagentStart", matcher: "standard", matcherField: "agent_type", handlers: NO_MODEL,
    defaultTimeoutSeconds: 600, exit2: "user_notice",
  }),
  SubagentStop: spec({
    name: "SubagentStop", matcher: "standard", matcherField: "agent_type", handlers: ALL,
    defaultTimeoutSeconds: 600, exit2: "continue_agent", onFailureIgnored: true,
    missingFileExit2IsNonBlocking: true,
  }),
  TaskCreated: spec({
    name: "TaskCreated", matcher: "none", handlers: ALL, defaultTimeoutSeconds: 600,
    exit2: "block_action", discardsContinue: true,
  }),
  TaskCompleted: spec({
    name: "TaskCompleted", matcher: "none", handlers: ALL, defaultTimeoutSeconds: 600,
    exit2: "continue_agent", onFailureIgnored: true, missingFileExit2IsNonBlocking: true,
  }),
  Stop: spec({
    name: "Stop", matcher: "none", handlers: ALL, defaultTimeoutSeconds: 600,
    exit2: "continue_agent", onFailureIgnored: true, missingFileExit2IsNonBlocking: true,
  }),
  StopFailure: spec({
    name: "StopFailure", matcher: "narrow", matcherField: "error", handlers: NO_MODEL,
    defaultTimeoutSeconds: 600, exit2: "ignored", discardsOutput: true, observational: true,
  }),
  TeammateIdle: spec({
    name: "TeammateIdle", matcher: "none", handlers: ALL, defaultTimeoutSeconds: 600,
    exit2: "continue_agent", onFailureIgnored: true,
  }),
  ConfigChange: spec({
    name: "ConfigChange", matcher: "standard", matcherField: "source", handlers: NO_MODEL,
    defaultTimeoutSeconds: 600, exit2: "block_action_user",
    discardsSystemMessage: true, discardsContinue: true,
  }),
  CwdChanged: spec({
    name: "CwdChanged", matcher: "none", handlers: NO_MODEL, defaultTimeoutSeconds: 600,
    exit2: "user_notice", discardsContinue: true, observational: true,
  }),
  DirectoryAdded: spec({
    name: "DirectoryAdded", matcher: "standard", matcherField: "source", handlers: NO_MODEL,
    defaultTimeoutSeconds: 600, exit2: "ignored", discardsContinue: true, observational: true,
  }),
  FileChanged: spec({
    name: "FileChanged", matcher: "narrow", handlers: NO_MODEL, defaultTimeoutSeconds: 600,
    exit2: "user_notice", discardsContinue: true, observational: true,
  }),
  WorktreeCreate: spec({
    name: "WorktreeCreate", matcher: "none", handlers: NO_MODEL, defaultTimeoutSeconds: 600,
    exit2: "fail_action", discardsSystemMessage: true, discardsContinue: true,
  }),
  WorktreeRemove: spec({
    name: "WorktreeRemove", matcher: "none", handlers: NO_MODEL, defaultTimeoutSeconds: 600,
    exit2: "fail_action", discardsOutput: true,
  }),
  PreCompact: spec({
    name: "PreCompact", matcher: "standard", matcherField: "trigger", handlers: NO_MODEL,
    defaultTimeoutSeconds: 600, exit2: "block_action_user",
    discardsSystemMessage: true, discardsContinue: true,
  }),
  PostCompact: spec({
    name: "PostCompact", matcher: "standard", matcherField: "trigger", handlers: NO_MODEL,
    defaultTimeoutSeconds: 600, exit2: "user_notice",
    discardsSystemMessage: true, discardsContinue: true,
  }),
  PreModelSwitch: spec({
    name: "PreModelSwitch", matcher: "standard", handlers: NO_MODEL, defaultTimeoutSeconds: 30,
    exit2: "block_action_user", timeoutBlocks: true,
  }),
  PostModelSwitch: spec({
    name: "PostModelSwitch", matcher: "standard", handlers: NO_MODEL, defaultTimeoutSeconds: 30,
    exit2: "user_notice", plainStdoutIsContext: true,
  }),
  SessionEnd: spec({
    name: "SessionEnd", matcher: "standard", matcherField: "reason", handlers: NO_MODEL,
    defaultTimeoutSeconds: 1.5, exit2: "user_notice", discardsOutput: true,
  }),
  Elicitation: spec({
    name: "Elicitation", matcher: "standard", matcherField: "mcp_server_name", handlers: NO_MODEL,
    defaultTimeoutSeconds: 600, exit2: "block_action_user", specificOutputOnlyOnExit0: true,
    discardsSystemMessage: true, discardsContinue: true,
  }),
  ElicitationResult: spec({
    name: "ElicitationResult", matcher: "standard", matcherField: "mcp_server_name",
    handlers: NO_MODEL, defaultTimeoutSeconds: 600, exit2: "block_action_user",
    specificOutputOnlyOnExit0: true, discardsSystemMessage: true, discardsContinue: true,
  }),
});

/** Default timeouts (seconds) for model-backed handlers. */
export const PROMPT_HOOK_DEFAULT_TIMEOUT_SECONDS = 30;
export const AGENT_HOOK_DEFAULT_TIMEOUT_SECONDS = 60;
/** SessionEnd hooks share a budget that per-hook timeouts may raise, up to 60s. */
export const SESSION_END_MAX_BUDGET_SECONDS = 60;
/** At most this many prompt/agent hooks run at once for one event. */
export const MODEL_HOOK_CONCURRENCY = 12;
/** Consecutive Stop-hook continuations allowed before the next block is overridden. */
export const DEFAULT_STOP_HOOK_BLOCK_CAP = 8;
/** Cap applied to `additionalContext`, `systemMessage`, `initialUserMessage` and plain stdout. */
export const HOOK_OUTPUT_FIELD_CAP = 10_000;
/** Preview kept inline when a capped field spills to a file. */
export const HOOK_OUTPUT_PREVIEW_CHARS = 2_000;
/** Agent hooks run for at most this many turns. */
export const AGENT_HOOK_MAX_TURNS = 50;

const EVENT_SET = new Set<string>(HOOK_EVENT_NAMES);

export function isHookEventName(value: unknown): value is HookEventName {
  return typeof value === "string" && EVENT_SET.has(value);
}

/** Effective timeout in milliseconds for one handler on one event. */
export function hookTimeoutMs(event: HookEventName, type: HookHandlerType, configuredSeconds?: number): number {
  if (configuredSeconds !== undefined) return Math.round(configuredSeconds * 1000);
  if (type === "prompt") return PROMPT_HOOK_DEFAULT_TIMEOUT_SECONDS * 1000;
  if (type === "agent") return AGENT_HOOK_DEFAULT_TIMEOUT_SECONDS * 1000;
  return Math.round(HOOK_EVENTS[event].defaultTimeoutSeconds * 1000);
}

/** What a host supports: the reference baseline, which events it emits and which handler types run. */
export interface HookCapabilities {
  reference: typeof HOOK_REFERENCE_BASELINE;
  /** Every reference event is accepted in configuration. */
  events: readonly HookEventName[];
  /** Events this host fires at a lifecycle boundary. Others are accepted but never fire here. */
  emittedEvents: readonly HookEventName[];
  /** Handler types this host can execute. Configured types it cannot run fail as hook errors. */
  handlerTypes: readonly HookHandlerType[];
  stopHookBlockCap: number;
}

/** Lifecycle boundaries the portable runtime emits today. */
export const PORTABLE_EMITTED_HOOK_EVENTS: readonly HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "PostModelSwitch",
  "FileChanged",
  "SessionEnd",
];

export const PORTABLE_HOOK_CAPABILITIES: HookCapabilities = Object.freeze({
  reference: HOOK_REFERENCE_BASELINE,
  events: HOOK_EVENT_NAMES,
  emittedEvents: PORTABLE_EMITTED_HOOK_EVENTS,
  handlerTypes: ["command", "http"] as const,
  stopHookBlockCap: DEFAULT_STOP_HOOK_BLOCK_CAP,
});
