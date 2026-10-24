/**
 * Event-level composition of handler outcomes into one result, following the
 * reference "Decision control", "Exit code 2 behavior per event", prompt-hook
 * "Response schema" and each event's own section.
 */
import { HOOK_EVENTS, HOOK_OUTPUT_FIELD_CAP, HOOK_OUTPUT_PREVIEW_CHARS, type HookEventName } from "./events.js";
import type { HookHandler } from "./config.js";
import { isAllowedTerminalSequence, type HookJsonOutput, type HookRunOutcome } from "./output.js";

export type PermissionDecision = "allow" | "deny" | "ask" | "defer";

export interface HookNotice {
  event: HookEventName;
  /** `<event>:<subject>` label, e.g. `PreToolUse:Bash`. */
  label: string;
  hook: string;
  message: string;
}

/** Composed result of one event occurrence. Callers read the fields their boundary supports. */
export interface HookEventResult {
  event: HookEventName;
  /** `continue: false` from any hook: stop processing entirely. */
  stop?: { reason?: string };
  /** The pending action is blocked (exit 2, `decision: "block"`, deny, onFailure block). */
  block?: { reason: string; audience: "model" | "user" };
  /** Stop/SubagentStop/TaskCompleted/TeammateIdle: keep the responsible agent working. */
  continuation?: { feedback: string; kind: "block" | "context" };
  /** Feedback shown to the model next to an already-completed action (PostToolUse/Failure exit 2, block). */
  modelFeedback: string[];
  additionalContext: string[];
  systemMessages: string[];
  terminalSequences: string[];
  notices: HookNotice[];
  // PreToolUse / PreModelSwitch
  permissionDecision?: PermissionDecision;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  // PermissionRequest
  permissionRequest?: {
    behavior: "allow" | "deny";
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: unknown[];
    message?: string;
    interrupt?: boolean;
  };
  /** PermissionDenied */
  retry?: boolean;
  // PostToolUse
  updatedToolOutput?: { value: unknown; mcp: boolean };
  classifierContext: string[];
  // SessionStart / UserPromptSubmit
  sessionTitle?: string;
  initialUserMessage?: string;
  watchPaths?: string[];
  reloadSkills?: boolean;
  suppressOriginalPrompt?: boolean;
  // MessageDisplay
  displayContent?: string;
  // WorktreeCreate
  worktreePath?: string;
  /** WorktreeCreate/WorktreeRemove: a hook failed the action. */
  actionFailed?: string;
  // Elicitation / ElicitationResult
  elicitation?: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
}

export interface ComposeEntry {
  hookLabel: string;
  handler: HookHandler;
  outcome: HookRunOutcome;
  /** onFailure semantics already decided by the engine: the failure blocks. */
  failureBlocks: boolean;
  /** Plain text the reason is prefixed with when shown to the model on tool events. */
  subject?: string;
}

export interface ComposeOptions {
  /** Write over-cap text to a file and return its path; truncate inline when absent. */
  spill?: (text: string) => string | undefined;
  /** TaskCompleted fired because a teammate stopped (vs a TaskUpdate call). */
  taskCompletedByTeammate?: boolean;
}

const CONTEXT_EVENTS = new Set<HookEventName>([
  "SessionStart", "SubagentStart", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse",
  "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Stop", "SubagentStop", "PostModelSwitch",
]);

const DECISION_RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, defer: 2, deny: 3 };

export function emptyHookEventResult(event: HookEventName): HookEventResult {
  return {
    event,
    modelFeedback: [],
    additionalContext: [],
    systemMessages: [],
    terminalSequences: [],
    notices: [],
    classifierContext: [],
  };
}

/** Compose handler outcomes, in declaration order, into the event result. */
export function composeHookEvent(event: HookEventName, entries: readonly ComposeEntry[], options: ComposeOptions = {}): HookEventResult {
  const spec = HOOK_EVENTS[event];
  const result = emptyHookEventResult(event);
  const cap = (text: string) => capHookText(text, options.spill);
  let decisionRank = -1;
  let elicitationDeclined = false;

  const setDecision = (decision: PermissionDecision, reason: string | undefined, updatedInput?: Record<string, unknown>) => {
    if (DECISION_RANK[decision] <= decisionRank) return;
    decisionRank = DECISION_RANK[decision];
    result.permissionDecision = decision;
    if (reason !== undefined) result.permissionDecisionReason = reason;
    else delete result.permissionDecisionReason;
    if (updatedInput) result.updatedInput = updatedInput;
  };
  const block = (reason: string, audience: "model" | "user") => {
    if (!result.block) result.block = { reason, audience };
  };
  const continueAgent = (feedback: string, kind: "block" | "context") => {
    if (!feedback.trim()) return;
    result.continuation = result.continuation
      ? { feedback: `${result.continuation.feedback}\n\n${feedback}`, kind: result.continuation.kind === "block" || kind === "block" ? "block" : "context" }
      : { feedback, kind };
  };

  for (const entry of entries) {
    const { outcome } = entry;
    const notice = (message: string) => result.notices.push({ event, label: labelFor(event, entry.subject), hook: entry.hookLabel, message });
    if (outcome.status === "skipped") continue;

    // Side-effect field that fires even on events that discard output.
    if (outcome.output?.terminalSequence && isAllowedTerminalSequence(outcome.output.terminalSequence)) {
      result.terminalSequences.push(outcome.output.terminalSequence);
    }
    if (spec.discardsOutput) {
      if (outcome.status !== "success") notice(outcome.message ?? "Hook error");
      if (event === "WorktreeRemove" && (outcome.status === "blocking" || outcome.failed)) {
        result.actionFailed ??= outcome.message || "WorktreeRemove hook failed";
      }
      continue;
    }

    // Worktree creation: any failure fails creation; success needs a path.
    if (event === "WorktreeCreate") {
      if (outcome.status !== "success" || outcome.failed) {
        result.actionFailed ??= outcome.message || "WorktreeCreate hook failed";
        continue;
      }
      const path = entry.handler.type === "command"
        ? lastNonEmptyLine(stripAnsi(outcome.plainText ?? ""))
        : stringField(outcome.output?.hookSpecificOutput, "worktreePath");
      if (path) result.worktreePath ??= path;
      else result.actionFailed ??= "WorktreeCreate hook returned no worktree path";
      continue;
    }

    // Prompt / agent verdicts.
    if (outcome.verdict) {
      applyVerdict(event, entry, outcome.verdict, result, setDecision, block, continueAgent, options);
      continue;
    }

    if (outcome.status === "non_blocking_error") {
      if (entry.failureBlocks) applyBlocking(event, entry, failureMessage(entry), result, setDecision, block, continueAgent);
      else notice(outcome.message ?? "Hook error");
      // A non-blocking error never applies fields (invalid output, timeout, crash).
      continue;
    }

    if (outcome.status === "blocking" || (outcome.status === "success" && entry.failureBlocks)) {
      const message = outcome.status === "blocking"
        ? blockingMessage(event, entry, outcome)
        : failureMessage(entry);
      applyBlocking(event, entry, message, result, setDecision, block, continueAgent);
      // Exit 2 still reads JSON fields; they cannot override the block.
      if (outcome.output) applyFields(event, entry, outcome.output, result, { setDecision, block, continueAgent, cap, blocked: true, notice });
      if (outcome.status === "blocking" && spec.exit2 === "user_notice" && outcome.message) notice(outcome.message);
      continue;
    }

    // Success.
    if (outcome.plainText !== undefined && spec.plainStdoutIsContext && outcome.plainText.trim()) {
      result.additionalContext.push(cap(escapeSystemReminder(outcome.plainText.trim())));
    }
    if (outcome.output) applyFields(event, entry, outcome.output, result, { setDecision, block, continueAgent, cap, blocked: false, notice });
  }

  if (event === "Elicitation" || event === "ElicitationResult") {
    elicitationDeclined = result.elicitation?.action === "decline";
    if (result.block && !elicitationDeclined) result.elicitation = { action: "decline" };
  }
  return result;
}

interface FieldContext {
  setDecision: (decision: PermissionDecision, reason: string | undefined, updatedInput?: Record<string, unknown>) => void;
  block: (reason: string, audience: "model" | "user") => void;
  continueAgent: (feedback: string, kind: "block" | "context") => void;
  cap: (text: string) => string;
  blocked: boolean;
  notice: (message: string) => void;
}

function applyFields(event: HookEventName, entry: ComposeEntry, output: HookJsonOutput, result: HookEventResult, ctx: FieldContext): void {
  const spec = HOOK_EVENTS[event];
  const specific = (output.hookSpecificOutput ?? {}) as Record<string, unknown>;

  if (output.continue === false && !spec.discardsContinue) {
    if (event !== "TaskCompleted" || !entry.subject || entry.subject !== "TaskUpdate") {
      result.stop ??= { ...(output.stopReason ? { reason: output.stopReason } : {}) };
    }
  }
  if (output.systemMessage && !spec.discardsSystemMessage) result.systemMessages.push(ctx.cap(output.systemMessage));

  if (typeof specific.additionalContext === "string" && specific.additionalContext.trim() && CONTEXT_EVENTS.has(event)) {
    const deferred = event === "PreToolUse" && specific.permissionDecision === "defer";
    if (!deferred) {
      const context = ctx.cap(escapeSystemReminder(specific.additionalContext));
      if (event === "Stop" || event === "SubagentStop") ctx.continueAgent(context, "context");
      else result.additionalContext.push(context);
    }
  }

  const decisionBlock = output.decision === "block";
  const reason = typeof output.reason === "string" ? output.reason : undefined;

  switch (event) {
    case "PreToolUse": {
      let decision = typeof specific.permissionDecision === "string" ? specific.permissionDecision as PermissionDecision : undefined;
      let decisionReason = typeof specific.permissionDecisionReason === "string" ? specific.permissionDecisionReason : undefined;
      // Deprecated top-level fields: approve → allow, block → deny.
      if (!decision && output.decision === "approve") decision = "allow";
      if (!decision && output.decision === "block") { decision = "deny"; decisionReason ??= reason; }
      const updated = isRecord(specific.updatedInput) ? specific.updatedInput : undefined;
      if (ctx.blocked) return;
      if (decision) ctx.setDecision(decision, decisionReason, decision === "defer" ? undefined : updated);
      else if (updated && !result.updatedInput) result.updatedInput = updated;
      return;
    }
    case "PreModelSwitch": {
      if (ctx.blocked) return;
      const decision = typeof specific.permissionDecision === "string" ? specific.permissionDecision as PermissionDecision : undefined;
      if (decisionBlock) ctx.setDecision("deny", reason ?? "Blocked by PreModelSwitch hook");
      else if (decision) ctx.setDecision(decision, typeof specific.permissionDecisionReason === "string" ? specific.permissionDecisionReason : undefined);
      return;
    }
    case "PermissionRequest": {
      const decision = specific.decision;
      if (!isRecord(decision) || ctx.blocked) return;
      const behavior = decision.behavior as "allow" | "deny";
      if (result.permissionRequest?.behavior === "deny") return;
      result.permissionRequest = {
        behavior,
        ...(behavior === "allow" && isRecord(decision.updatedInput) ? { updatedInput: decision.updatedInput } : {}),
        ...(behavior === "allow" && Array.isArray(decision.updatedPermissions) ? { updatedPermissions: decision.updatedPermissions } : {}),
        ...(behavior === "deny" && typeof decision.message === "string" ? { message: decision.message } : {}),
        ...(behavior === "deny" && decision.interrupt === true ? { interrupt: true } : {}),
      };
      return;
    }
    case "PermissionDenied":
      if (specific.retry === true) result.retry = true;
      return;
    case "PostToolUse":
      if (decisionBlock && reason) result.modelFeedback.push(ctx.cap(reason));
      if (typeof specific.classifierContext === "string") result.classifierContext.push(specific.classifierContext);
      if (specific.updatedToolOutput !== undefined) result.updatedToolOutput = { value: specific.updatedToolOutput, mcp: false };
      else if (specific.updatedMCPToolOutput !== undefined && !result.updatedToolOutput) {
        result.updatedToolOutput = { value: specific.updatedMCPToolOutput, mcp: true };
      }
      return;
    case "PostToolUseFailure":
      if (decisionBlock && reason) result.modelFeedback.push(ctx.cap(reason));
      return;
    case "PostToolBatch":
      if (decisionBlock) ctx.block(reason ?? "Blocked by PostToolBatch hook", "user");
      return;
    case "Stop":
    case "SubagentStop":
      if (decisionBlock) {
        if (reason?.trim()) ctx.continueAgent(ctx.cap(reason), "block");
        else ctx.notice('decision "block" requires a reason');
      }
      return;
    case "UserPromptSubmit":
      if (typeof specific.sessionTitle === "string") result.sessionTitle = specific.sessionTitle;
      if (specific.suppressOriginalPrompt === true) result.suppressOriginalPrompt = true;
      if (decisionBlock) ctx.block(reason ?? "Prompt blocked by UserPromptSubmit hook", "user");
      return;
    case "UserPromptExpansion":
      if (decisionBlock) ctx.block(reason ?? "Expansion blocked by UserPromptExpansion hook", "user");
      return;
    case "TaskCreated":
      if (decisionBlock) ctx.block(reason ?? "Task creation blocked by TaskCreated hook", "model");
      return;
    case "ConfigChange":
    case "PreCompact":
      if (decisionBlock) ctx.block(reason ?? `Blocked by ${event} hook`, "user");
      return;
    case "SessionStart":
      if (typeof specific.initialUserMessage === "string") result.initialUserMessage ??= ctx.cap(specific.initialUserMessage);
      if (typeof specific.sessionTitle === "string") result.sessionTitle ??= specific.sessionTitle;
      if (Array.isArray(specific.watchPaths)) result.watchPaths = [...(result.watchPaths ?? []), ...(specific.watchPaths as string[])];
      if (specific.reloadSkills === true) result.reloadSkills = true;
      return;
    case "CwdChanged":
    case "FileChanged":
      if (Array.isArray(specific.watchPaths)) result.watchPaths = specific.watchPaths as string[];
      return;
    case "MessageDisplay":
      if (typeof specific.displayContent === "string") result.displayContent = specific.displayContent;
      return;
    case "Elicitation":
    case "ElicitationResult": {
      if (decisionBlock) {
        result.elicitation = { action: "decline" };
        return;
      }
      const action = specific.action as "accept" | "decline" | "cancel" | undefined;
      if (!action) return;
      if (result.elicitation?.action === "decline") return;
      result.elicitation = {
        action,
        ...(action === "accept" && isRecord(specific.content) ? { content: specific.content } : {}),
      };
      return;
    }
    default:
      return;
  }
}

function applyBlocking(
  event: HookEventName,
  entry: ComposeEntry,
  message: string,
  result: HookEventResult,
  setDecision: FieldContext["setDecision"],
  block: FieldContext["block"],
  continueAgent: FieldContext["continueAgent"],
): void {
  const spec = HOOK_EVENTS[event];
  if (event === "PermissionRequest") {
    // Only reached through onFailure: "block", which denies the request.
    if (entry.failureBlocks) result.permissionRequest = { behavior: "deny", message };
    return;
  }
  if (event === "PreModelSwitch" || event === "PreToolUse") {
    setDecision("deny", message);
    block(message, event === "PreToolUse" ? "model" : "user");
    return;
  }
  if (event === "Elicitation" || event === "ElicitationResult") {
    result.elicitation = { action: "decline" };
    return;
  }
  switch (spec.exit2) {
    case "block_action":
      block(message, "model");
      return;
    case "block_action_user":
      block(message, "user");
      return;
    case "continue_agent":
      continueAgent(message, "block");
      return;
    case "feedback_to_model":
      if (message) result.modelFeedback.push(message);
      return;
    case "fail_action":
      result.actionFailed ??= message;
      return;
    case "user_notice":
    case "ignored":
      return;
  }
}

function applyVerdict(
  event: HookEventName,
  entry: ComposeEntry,
  verdict: { ok: boolean; reason?: string; impossible?: boolean },
  result: HookEventResult,
  setDecision: FieldContext["setDecision"],
  block: FieldContext["block"],
  continueAgent: FieldContext["continueAgent"],
  options: ComposeOptions,
): void {
  if (verdict.ok) return;
  const reason = verdict.reason?.trim() ?? "";
  const agent = entry.handler.type === "agent";
  const continueOnBlock = agent || (entry.handler.type === "prompt" && entry.handler.continueOnBlock === true);
  switch (event) {
    case "Stop":
    case "SubagentStop":
      if (verdict.impossible && !agent) return;
      continueAgent(reason, "block");
      return;
    case "PreToolUse":
      setDecision("deny", reason);
      if (continueOnBlock) block(reason, "model");
      else result.stop ??= { reason };
      return;
    case "PostToolUse":
      if (continueOnBlock) result.modelFeedback.push(reason);
      else result.stop ??= { reason };
      return;
    case "PostToolBatch":
    case "UserPromptSubmit":
    case "UserPromptExpansion":
      block(reason, "user");
      result.stop ??= { reason };
      return;
    case "PostToolUseFailure":
      result.modelFeedback.push(reason);
      return;
    case "TaskCreated":
      block(reason, "model");
      return;
    case "TaskCompleted":
      if (options.taskCompletedByTeammate) {
        if (continueOnBlock) continueAgent(reason, "block");
        else result.stop ??= { reason };
      } else {
        continueAgent(reason, "block");
      }
      return;
    case "TeammateIdle":
      if (continueOnBlock) continueAgent(reason, "block");
      else result.stop ??= { reason };
      return;
    default:
      // PermissionRequest / PermissionDenied: ok:false has no effect.
      return;
  }
}

function blockingMessage(event: HookEventName, entry: ComposeEntry, outcome: HookRunOutcome): string {
  const stderr = outcome.message ?? "";
  const output = outcome.output;
  // A JSON blocking decision's reason replaces stderr.
  const jsonReason = output?.decision === "block" && typeof output.reason === "string"
    ? output.reason
    : typeof output?.hookSpecificOutput?.permissionDecisionReason === "string" && output.hookSpecificOutput.permissionDecision === "deny"
      ? output.hookSpecificOutput.permissionDecisionReason as string
      : undefined;
  const reason = jsonReason ?? stderr;
  if (HOOK_EVENTS[event].toolEvent) return `${labelFor(event, entry.subject)} hook error: [${entry.hookLabel}]: ${reason}`;
  return reason;
}

function failureMessage(entry: ComposeEntry): string {
  const what = entry.outcome.timedOut ? "timed out" : "failed";
  const detail = entry.outcome.message ? `\n${entry.outcome.message}` : "";
  return `[${entry.hookLabel}]: ${what}; blocking because onFailure is "block"${detail}`;
}

function labelFor(event: HookEventName, subject: string | undefined): string {
  return subject ? `${event}:${subject}` : event;
}

/** Cap a hook string at 10,000 characters; spill the full text when a writer is available. */
export function capHookText(text: string, spill?: (text: string) => string | undefined): string {
  if (text.length <= HOOK_OUTPUT_FIELD_CAP) return text;
  const preview = text.slice(0, HOOK_OUTPUT_PREVIEW_CHARS);
  const path = spill?.(text);
  return path
    ? `Hook output exceeded ${HOOK_OUTPUT_FIELD_CAP} characters and was saved to ${path}. Preview:\n${preview}`
    : `Hook output exceeded ${HOOK_OUTPUT_FIELD_CAP} characters and was truncated. Preview:\n${preview}`;
}

/** `<system-reminder>` / `</system-reminder>` tags in hook context are neutralized. */
export function escapeSystemReminder(text: string): string {
  return text.replace(/<(\/?system-reminder)/gi, "&lt;$1");
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1];
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

function stringField(value: unknown, field: string): string | undefined {
  return isRecord(value) && typeof value[field] === "string" ? value[field] as string : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
