/**
 * Runtime boundary adapter: builds the Claude-compatible common input for one
 * agent invocation and exposes typed operations at the points the runtime
 * calls hooks (tools, prompt, stop, compaction, model switch, sessions).
 */
import { DEFAULT_STOP_HOOK_BLOCK_CAP, HOOK_EVENTS, type HookEventName } from "./events.js";
import { HookEngine, type HookDispatchOptions, type HookInput } from "./engine.js";
import type { HookEventResult, PermissionDecision } from "./aggregate.js";
import type { PermissionRuleContext } from "./permission-rule.js";
import { canonicalToolCall, canonicalToolResponse, polpoToolInput, updatedToolResult } from "./tools.js";

export type HookPermissionMode = "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";

/** Polpo correlation, namespaced so Claude-style scripts ignore it. */
export interface PolpoHookCorrelation {
  project_id?: string;
  environment?: string;
  run_id?: string;
  turn_id?: string;
  loop?: string;
  step?: string;
  surface?: "chat" | "loop" | "channel" | "task" | "schedule" | "runtime";
}

export interface HookRuntimeContext {
  sessionId: string;
  /** Working directory reported to hooks and used as the hooks' cwd. */
  cwd: string;
  /** Project root: `CLAUDE_PROJECT_DIR`, base of `/path` permission rules. */
  projectDir: string;
  transcriptPath?: string;
  scratchpadDir?: string;
  permissionMode?: HookPermissionMode;
  effortLevel?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Present when the invocation runs a named agent or a subagent. */
  agentType?: string;
  agentId?: string;
  promptId?: string;
  polpo?: PolpoHookCorrelation;
  homeDir?: string;
}

export interface HookRuntimeOptions {
  /** Consecutive Stop continuations before the next block is overridden (default 8). */
  stopHookBlockCap?: number;
  /** Extra env for command hooks per event (e.g. CLAUDE_ENV_FILE). */
  envForEvent?: (event: HookEventName) => Record<string, string> | undefined;
}

export interface PreToolUseOutcome {
  /** `allow`/`undefined` → run; `deny` → do not run, `reason` is the tool error the model sees. */
  decision?: PermissionDecision;
  reason?: string;
  /** Polpo-shaped arguments to execute with (after `updatedInput`). */
  input: Record<string, unknown>;
  /** Context to place next to the tool result. */
  context: string[];
  /** `continue: false`: stop the agent after this tool call. */
  stop?: { reason?: string };
  systemMessages: string[];
}

export interface PostToolUseOutcome {
  /** Result the model sees (original, or `updatedToolOutput`) with feedback/context appended. */
  result: string;
  stop?: { reason?: string };
  systemMessages: string[];
}

export interface StopOutcome {
  /** `continue`: feed `feedback` to the same agent and keep working. */
  action: "accept" | "continue" | "halt";
  feedback?: string;
  kind?: "block" | "context";
  reason?: string;
  systemMessages: string[];
}

export class HookRuntime {
  /** `continue: false` from any hook during this invocation: stop at the next boundary. */
  pendingStop?: { reason?: string };
  /** Context for the next model request (PostModelSwitch, PostToolBatch, async hooks). */
  readonly pendingContext: string[] = [];
  /** User-facing hook messages (`systemMessage`) collected during this invocation. */
  readonly systemMessages: string[] = [];
  private consecutiveStopContinuations = 0;
  /** The turn is continuing because a Stop hook kept it going; tool calls don't clear it. */
  private stopHookActive = false;
  private readonly stopCap: number;

  constructor(
    readonly engine: HookEngine,
    private context: HookRuntimeContext,
    private readonly options: HookRuntimeOptions = {},
  ) {
    const cap = options.stopHookBlockCap ?? DEFAULT_STOP_HOOK_BLOCK_CAP;
    if (!Number.isSafeInteger(cap) || cap < 0) throw new Error("stopHookBlockCap must be a non-negative integer");
    this.stopCap = cap;
  }

  /** Update mutable fields (cwd after `cd`, prompt id per turn, permission mode). */
  update(patch: Partial<HookRuntimeContext>): void {
    this.context = { ...this.context, ...patch };
  }

  get cwd(): string {
    return this.context.cwd;
  }

  has(event: HookEventName): boolean {
    return this.engine.has(event);
  }

  /** Dispatch any event with the common input fields merged in. */
  async dispatch(event: HookEventName, fields: Record<string, unknown> = {}, options: HookDispatchOptions = {}): Promise<HookEventResult> {
    return this.engine.dispatch(event, this.input(event, fields), {
      permissionContext: this.permissionContext(),
      ...(this.options.envForEvent?.(event) ? { env: this.options.envForEvent(event) } : {}),
      ...options,
    });
  }

  // ─── Tools ───────────────────────────────────────────────────────────────

  async preToolUse(name: string, args: Record<string, unknown>, toolUseId: string | undefined, options: HookDispatchOptions = {}): Promise<PreToolUseOutcome> {
    const call = canonicalToolCall(name, args, this.context.cwd);
    if (!this.engine.has("PreToolUse")) return { input: args, context: [], systemMessages: [] };
    const result = await this.dispatch("PreToolUse", {
      tool_name: call.toolName,
      tool_input: call.toolInput,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    }, { ...(toolUseId ? { occurrenceId: `PreToolUse:${toolUseId}` } : {}), ...options });
    const decision = result.permissionDecision;
    const input = result.updatedInput && decision !== "deny" && decision !== "defer"
      ? polpoToolInput(name, result.updatedInput)
      : args;
    return {
      ...(decision ? { decision } : {}),
      ...(decision === "deny" || decision === "ask" || decision === "defer"
        ? { reason: result.permissionDecisionReason ?? result.block?.reason ?? `${call.toolName} blocked by PreToolUse hook` }
        : {}),
      input,
      context: result.additionalContext,
      ...(result.stop ? { stop: result.stop } : {}),
      systemMessages: result.systemMessages,
    };
  }

  async postToolUse(
    name: string,
    args: Record<string, unknown>,
    rendered: string,
    toolUseId: string | undefined,
    durationMs: number | undefined,
    options: HookDispatchOptions = {},
  ): Promise<PostToolUseOutcome> {
    const failed = rendered.startsWith("Error:");
    const event: HookEventName = failed ? "PostToolUseFailure" : "PostToolUse";
    if (!this.engine.has(event)) return { result: rendered, systemMessages: [] };
    const call = canonicalToolCall(name, args, this.context.cwd);
    const result = await this.dispatch(event, {
      tool_name: call.toolName,
      tool_input: call.toolInput,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      ...(failed
        ? { error: rendered.replace(/^Error:\s*/, ""), is_interrupt: false }
        : { tool_response: canonicalToolResponse(name, args, rendered, this.context.cwd) }),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    }, { ...(toolUseId ? { occurrenceId: `${event}:${toolUseId}` } : {}), ...options });
    let visible = rendered;
    if (!failed && result.updatedToolOutput) {
      visible = updatedToolResult(name, result.updatedToolOutput.value) ?? rendered;
    }
    const notes = [...result.modelFeedback, ...result.additionalContext];
    return {
      result: notes.length ? `${visible}\n\n${notes.map(systemReminder).join("\n")}` : visible,
      ...(result.stop ? { stop: result.stop } : {}),
      systemMessages: result.systemMessages,
    };
  }

  /** After a full batch of tool calls resolves, before the next model call. */
  async postToolBatch(calls: readonly { name: string; input: Record<string, unknown>; toolUseId?: string; result: string }[], options: HookDispatchOptions = {}): Promise<HookEventResult | undefined> {
    if (!this.engine.has("PostToolBatch") || calls.length === 0) return undefined;
    return this.dispatch("PostToolBatch", {
      tool_calls: calls.map((call) => {
        const canonical = canonicalToolCall(call.name, call.input, this.context.cwd);
        return {
          tool_name: canonical.toolName,
          tool_input: canonical.toolInput,
          ...(call.toolUseId ? { tool_use_id: call.toolUseId } : {}),
          tool_response: call.result,
        };
      }),
    }, options);
  }

  /** A real tool call resets the consecutive Stop-continuation counter (not `stop_hook_active`). */
  noteToolCall(): void {
    this.consecutiveStopContinuations = 0;
  }

  // ─── Stop / SubagentStop ─────────────────────────────────────────────────

  /**
   * Run Stop (or SubagentStop) hooks on a terminal candidate. A block or
   * `additionalContext` continues the same agent; after the consecutive cap
   * the next block is overridden and the turn ends, as in the reference.
   */
  async stop(lastAssistantMessage: string, options: HookDispatchOptions & {
    event?: "Stop" | "SubagentStop";
    backgroundTasks?: unknown[];
    sessionCrons?: unknown[];
    agentTranscriptPath?: string;
    attempt?: number;
  } = {}): Promise<StopOutcome> {
    const event = options.event ?? "Stop";
    if (!this.engine.has(event)) return { action: "accept", systemMessages: [] };
    const result = await this.dispatch(event, {
      stop_hook_active: this.stopHookActive,
      last_assistant_message: lastAssistantMessage,
      background_tasks: options.backgroundTasks ?? [],
      session_crons: options.sessionCrons ?? [],
      ...(event === "SubagentStop" ? {
        agent_id: this.context.agentId ?? "",
        agent_type: this.context.agentType ?? "",
        ...(options.agentTranscriptPath ? { agent_transcript_path: options.agentTranscriptPath } : {}),
      } : {}),
    }, {
      ...(options.attempt !== undefined ? { occurrenceId: `${event}:${this.context.polpo?.run_id ?? this.context.sessionId}:${this.context.polpo?.turn_id ?? ""}:${options.attempt}` } : {}),
      ...options,
    });
    if (result.stop) return { action: "halt", ...(result.stop.reason ? { reason: result.stop.reason } : {}), systemMessages: result.systemMessages };
    if (!result.continuation) return { action: "accept", systemMessages: result.systemMessages };
    if (this.consecutiveStopContinuations >= this.stopCap) {
      return { action: "accept", reason: `Stop hook continuation cap (${this.stopCap}) reached`, systemMessages: result.systemMessages };
    }
    this.consecutiveStopContinuations += 1;
    this.stopHookActive = true;
    return {
      action: "continue",
      feedback: result.continuation.feedback,
      kind: result.continuation.kind,
      systemMessages: result.systemMessages,
    };
  }

  /** Snapshot for durable checkpoints. */
  stopState(): { consecutiveStopContinuations: number; stopHookActive: boolean } {
    return { consecutiveStopContinuations: this.consecutiveStopContinuations, stopHookActive: this.stopHookActive };
  }

  restoreStopState(state: { consecutiveStopContinuations?: number; stopHookActive?: boolean } | undefined): void {
    const value = state?.consecutiveStopContinuations;
    if (Number.isSafeInteger(value) && value! >= 0) this.consecutiveStopContinuations = value!;
    // Checkpoints written before the flag existed: any recorded continuation means active.
    this.stopHookActive = state?.stopHookActive ?? this.consecutiveStopContinuations > 0;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private input(event: HookEventName, fields: Record<string, unknown>): HookInput {
    const context = this.context;
    const spec = HOOK_EVENTS[event];
    const inToolContext = spec.toolEvent || event === "Stop" || event === "SubagentStop" || event === "PostToolBatch";
    return {
      session_id: context.sessionId,
      ...(context.promptId ? { prompt_id: context.promptId } : {}),
      ...(context.transcriptPath ? { transcript_path: context.transcriptPath } : {}),
      cwd: context.cwd,
      ...(context.scratchpadDir ? { scratchpad_dir: context.scratchpadDir } : {}),
      ...(context.permissionMode ? { permission_mode: context.permissionMode } : {}),
      ...(inToolContext && context.effortLevel ? { effort: { level: context.effortLevel } } : {}),
      ...(context.agentId ? { agent_id: context.agentId } : {}),
      ...(context.agentType ? { agent_type: context.agentType } : {}),
      ...fields,
      ...(context.polpo ? { polpo: context.polpo } : {}),
    } as HookInput;
  }

  private permissionContext(): PermissionRuleContext {
    return {
      cwd: this.context.cwd,
      projectDir: this.context.projectDir,
      ...(this.context.homeDir ? { homeDir: this.context.homeDir } : {}),
    };
  }
}

function systemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}
