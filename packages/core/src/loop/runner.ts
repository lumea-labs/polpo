import type { AgentConfig } from "../types.js";
import { SafeExpressionEvaluator } from "./expression.js";
import type { ContextBag, LoopConfig } from "./types.js";
import {
  LoopHookRegistry,
  type LoopRuntimeConfig,
  type LoopRunStatus,
  type LoopStopReason,
  type LoopToolCall,
  type LoopToolResult,
} from "./hooks.js";

export interface LoopModelInput {
  agent?: AgentConfig;
  loop: LoopRuntimeConfig;
  turn: number;
  context: ContextBag;
  activeTools?: string[];
  toolChoice?: unknown;
}

export interface LoopModelResult {
  text: string;
  toolCalls?: LoopToolCall[];
  usage?: unknown;
}

export interface LoopRunResult {
  status: LoopRunStatus;
  reason: LoopStopReason;
  turns: number;
  text: string;
  context: ContextBag;
  toolResults: LoopToolResult[];
}

/**
 * Snapshot emitted after every completed turn (durable turns).
 *
 * The runner does not own conversation history — the host does (loop-engine's
 * `messages`, the completions runtime's message array). This checkpoint
 * carries the loop-level position; the host closure enriches it with the
 * serialized history before persisting. Temporal semantics: a resumed run
 * replays completed side-effects from recorded results (they live in the
 * history as tool-call/tool-result pairs), it never re-executes them.
 */
export interface LoopTurnCheckpoint {
  loop: LoopRuntimeConfig;
  /** 0-based index of the turn that just completed. */
  turn: number;
  /** Turns completed so far in the logical run (== turn + 1, cumulative across resumes). */
  turns: number;
  context: ContextBag;
  /** Text produced by this turn. */
  text: string;
  toolCalls: LoopToolCall[];
  /** Tool results of this turn — already executed, part of history. */
  toolResults: LoopToolResult[];
}

export interface LoopRunnerOptions {
  agent?: AgentConfig;
  loop: LoopConfig & { name?: string };
  context?: ContextBag;
  input?: unknown;
  hooks?: LoopHookRegistry;
  maxTurns?: number;
  /**
   * Resume support (durable turns): first turn index to execute. Turns
   * before it already ran in a previous process — their side-effects are
   * recorded in the host's history and must not be replayed. The maxTurns
   * budget still counts them (indices are absolute, not relative).
   */
  startTurn?: number;
  model: (input: LoopModelInput) => Promise<LoopModelResult>;
  executeTool: (toolCall: LoopToolCall, input: LoopModelInput) => Promise<string>;
  /**
   * Durable-turns port: invoked once per completed turn, AFTER the turn's
   * tools have executed and the step:after hooks ran — i.e. when the host's
   * history is consistent (and post-compaction, since compaction happens at
   * the start of a model step). Persistence is best-effort by contract:
   * errors are swallowed so a flaky store can never fail a healthy run.
   * Core stays pure — wiring to a store lives in the host (loop-engine/runner).
   */
  onTurnCheckpoint?: (checkpoint: LoopTurnCheckpoint) => void | Promise<void>;
}

const DEFAULT_MAX_TURNS = 20;

function normalizeLoop(loop: LoopConfig & { name?: string }): LoopRuntimeConfig {
  return {
    ...loop,
    name: loop.name ?? "default",
  };
}

function shouldStopAfterTurn(
  loop: LoopRuntimeConfig,
  context: ContextBag,
  result: LoopModelResult,
  turn: number,
  maxTurns: number,
  evaluator: SafeExpressionEvaluator,
): { reason: LoopStopReason; shouldStop: boolean } {
  const reachedMaxTurns = turn + 1 >= maxTurns;
  if (loop.stopWhen) {
    const matched = evaluator.evaluate(loop.stopWhen.expression, context);
    if (matched) return { reason: "completed", shouldStop: true };
    return reachedMaxTurns ? { reason: "max_turns", shouldStop: true } : { reason: "completed", shouldStop: false };
  }
  if ((result.toolCalls ?? []).length === 0) return { reason: "completed", shouldStop: true };
  if (reachedMaxTurns) return { reason: "max_turns", shouldStop: true };
  return { reason: "completed", shouldStop: false };
}

export class LoopRunner {
  private readonly hooks: LoopHookRegistry;
  private readonly evaluator = new SafeExpressionEvaluator();

  constructor(hooks?: LoopHookRegistry) {
    this.hooks = hooks ?? new LoopHookRegistry();
  }

  async run(options: LoopRunnerOptions): Promise<LoopRunResult> {
    const hooks = options.hooks ?? this.hooks;
    const loop = normalizeLoop(options.loop);
    const context = options.context ?? {};
    const maxTurns = options.maxTurns ?? loop.maxTurns ?? DEFAULT_MAX_TURNS;
    const startTurn = options.startTurn ?? 0;
    let finalText = "";
    let turns = startTurn;
    const allToolResults: LoopToolResult[] = [];

    const start = await hooks.runBefore("loop:start", {
      agent: options.agent,
      loop,
      context,
      input: options.input,
    });
    if (start.cancelled) {
      return this.finish(hooks, {
        agent: options.agent,
        loop,
        context,
        status: "cancelled",
        reason: "cancelled",
        turns,
        text: finalText,
        toolResults: allToolResults,
      });
    }

    for (let turn = startTurn; turn < maxTurns; turn++) {
      turns = turn + 1;
      const step = await hooks.runBefore("step:before", {
        agent: options.agent,
        loop,
        turn,
        context,
        activeTools: loop.tools,
      });
      if (step.cancelled) {
        return this.finish(hooks, {
          agent: options.agent,
          loop,
          context,
          status: "cancelled",
          reason: "cancelled",
          turns,
          text: finalText,
          toolResults: allToolResults,
        });
      }

      const modelBefore = await hooks.runBefore("model:before", {
        agent: options.agent,
        loop,
        turn,
        context,
        activeTools: step.data.activeTools,
        toolChoice: step.data.toolChoice,
      });
      if (modelBefore.cancelled) {
        return this.finish(hooks, {
          agent: options.agent,
          loop,
          context,
          status: "cancelled",
          reason: "cancelled",
          turns,
          text: finalText,
          toolResults: allToolResults,
        });
      }

      const modelInput: LoopModelInput = {
        agent: options.agent,
        loop,
        turn,
        context,
        activeTools: modelBefore.data.activeTools,
        toolChoice: modelBefore.data.toolChoice,
      };
      const modelResult = await options.model(modelInput);
      finalText += modelResult.text;

      const toolResults: LoopToolResult[] = [];
      for (const rawCall of modelResult.toolCalls ?? []) {
        const before = await hooks.runBefore("tool:before", {
          agent: options.agent,
          loop,
          turn,
          context,
          toolCall: { ...rawCall, args: { ...rawCall.args } },
        });

        const toolCall = before.data.toolCall;
        const skipped = before.cancelled;
        const result = skipped
          ? before.data.result ?? `Error: Tool call "${toolCall.name}" denied${before.cancelReason ? `: ${before.cancelReason}` : ""}`
          : await options.executeTool(toolCall, modelInput);
        const toolResult: LoopToolResult = {
          toolCall,
          result,
          isError: result.startsWith("Error:"),
          skipped,
        };

        toolResults.push(toolResult);
        allToolResults.push(toolResult);

        await hooks.runAfter("tool:after", {
          agent: options.agent,
          loop,
          turn,
          context,
          toolCall,
          result,
          isError: toolResult.isError,
          skipped,
        });
      }

      await hooks.runAfter("step:after", {
        agent: options.agent,
        loop,
        turn,
        context,
        text: modelResult.text,
        toolCalls: modelResult.toolCalls ?? [],
        toolResults,
        usage: modelResult.usage,
      });

      // Durable turns: the turn is complete (tools executed, hooks ran) —
      // hand the host a checkpoint. Best-effort: a failing sink must never
      // take down a healthy run.
      if (options.onTurnCheckpoint) {
        try {
          await options.onTurnCheckpoint({
            loop,
            turn,
            turns,
            context,
            text: modelResult.text,
            toolCalls: modelResult.toolCalls ?? [],
            toolResults,
          });
        } catch { /* checkpoint persistence is best-effort */ }
      }

      const stop = shouldStopAfterTurn(loop, context, modelResult, turn, maxTurns, this.evaluator);
      const stopResult = await hooks.runBefore("loop:stop", {
        agent: options.agent,
        loop,
        turn,
        context,
        reason: stop.reason,
        shouldStop: stop.shouldStop,
      });
      if (stopResult.cancelled) {
        return this.finish(hooks, {
          agent: options.agent,
          loop,
          context,
          status: "cancelled",
          reason: "cancelled",
          turns,
          text: finalText,
          toolResults: allToolResults,
        });
      }
      if (stopResult.data.shouldStop) {
        return this.finish(hooks, {
          agent: options.agent,
          loop,
          context,
          status: "completed",
          reason: stopResult.data.reason,
          turns,
          text: finalText,
          toolResults: allToolResults,
        });
      }
    }

    return this.finish(hooks, {
      agent: options.agent,
      loop,
      context,
      status: "completed",
      reason: "max_turns",
      turns,
      text: finalText,
      toolResults: allToolResults,
    });
  }

  private async finish(
    hooks: LoopHookRegistry,
    result: LoopRunResult & { agent?: AgentConfig; loop: LoopRuntimeConfig },
  ): Promise<LoopRunResult> {
    await hooks.runAfter("loop:end", {
      agent: result.agent,
      loop: result.loop,
      context: result.context,
      status: result.status,
      reason: result.reason,
      turns: result.turns,
      text: result.text,
    });

    return {
      status: result.status,
      reason: result.reason,
      turns: result.turns,
      text: result.text,
      context: result.context,
      toolResults: result.toolResults,
    };
  }
}
