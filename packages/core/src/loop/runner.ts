import type { AgentConfig } from "../types.js";
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

export interface LoopRunnerOptions {
  agent?: AgentConfig;
  loop: LoopConfig & { name?: string };
  context?: ContextBag;
  input?: unknown;
  hooks?: LoopHookRegistry;
  maxTurns?: number;
  model: (input: LoopModelInput) => Promise<LoopModelResult>;
  executeTool: (toolCall: LoopToolCall, input: LoopModelInput) => Promise<string>;
}

const DEFAULT_MAX_TURNS = 20;

function normalizeLoop(loop: LoopConfig & { name?: string }): LoopRuntimeConfig {
  return {
    ...loop,
    name: loop.name ?? "default",
  };
}

function shouldStopAfterTurn(result: LoopModelResult, turn: number, maxTurns: number): { reason: LoopStopReason; shouldStop: boolean } {
  if ((result.toolCalls ?? []).length === 0) return { reason: "completed", shouldStop: true };
  if (turn + 1 >= maxTurns) return { reason: "max_turns", shouldStop: true };
  return { reason: "completed", shouldStop: false };
}

export class LoopRunner {
  private readonly hooks: LoopHookRegistry;

  constructor(hooks?: LoopHookRegistry) {
    this.hooks = hooks ?? new LoopHookRegistry();
  }

  async run(options: LoopRunnerOptions): Promise<LoopRunResult> {
    const hooks = options.hooks ?? this.hooks;
    const loop = normalizeLoop(options.loop);
    const context = options.context ?? {};
    const maxTurns = options.maxTurns ?? loop.maxTurns ?? DEFAULT_MAX_TURNS;
    let finalText = "";
    let turns = 0;
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

    for (let turn = 0; turn < maxTurns; turn++) {
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

      const stop = shouldStopAfterTurn(modelResult, turn, maxTurns);
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
