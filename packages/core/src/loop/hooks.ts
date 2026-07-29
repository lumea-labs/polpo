import { HookRegistry, type HookContext, type HookPhase, type BeforeHookResult } from "../hooks.js";
import type { AgentConfig } from "../types.js";
import type { ContextBag, LoopConfig, LoopLifecycleHook } from "./types.js";

export type LoopHook = LoopLifecycleHook;

export type LoopHookPhase = HookPhase;

export interface LoopRuntimeConfig extends LoopConfig {
  name: string;
}

export interface LoopToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Runtime-only rejection carried with this exact call occurrence. */
  inputValidationError?: string;
}

export interface LoopHookPayloads {
  "loop:start": {
    agent?: AgentConfig;
    loop: LoopRuntimeConfig;
    context: ContextBag;
    input?: unknown;
  };
  "step:before": {
    agent?: AgentConfig;
    loop: LoopRuntimeConfig;
    turn: number;
    context: ContextBag;
    activeTools?: string[];
    toolChoice?: unknown;
  };
  "model:before": {
    agent?: AgentConfig;
    loop: LoopRuntimeConfig;
    turn: number;
    context: ContextBag;
    activeTools?: string[];
    toolChoice?: unknown;
  };
  "tool:before": {
    agent?: AgentConfig;
    loop: LoopRuntimeConfig;
    turn: number;
    context: ContextBag;
    toolCall: LoopToolCall;
    result?: string;
  };
  "tool:after": {
    agent?: AgentConfig;
    loop: LoopRuntimeConfig;
    turn: number;
    context: ContextBag;
    toolCall: LoopToolCall;
    result: string;
    isError: boolean;
    skipped: boolean;
  };
  "step:after": {
    agent?: AgentConfig;
    loop: LoopRuntimeConfig;
    turn: number;
    context: ContextBag;
    text: string;
    toolCalls: LoopToolCall[];
    toolResults: LoopToolResult[];
    usage?: unknown;
  };
  "loop:stop": {
    agent?: AgentConfig;
    loop: LoopRuntimeConfig;
    turn: number;
    context: ContextBag;
    reason: LoopStopReason;
    shouldStop: boolean;
  };
  "loop:transition": {
    agent?: AgentConfig;
    from: string;
    to: string;
    context: ContextBag;
  };
  "loop:end": {
    agent?: AgentConfig;
    loop: LoopRuntimeConfig;
    context: ContextBag;
    status: LoopRunStatus;
    reason: LoopStopReason;
    turns: number;
    text: string;
  };
}

export type LoopStopReason = "completed" | "max_turns" | "cancelled";
export type LoopRunStatus = "completed" | "cancelled";

export interface LoopToolResult {
  toolCall: LoopToolCall;
  result: string;
  isError: boolean;
  skipped: boolean;
}

/**
 * Loop hook machinery — a typed instantiation of the shared HookRegistry
 * (hooks.ts). The registry class, context, and result semantics are the
 * platform ones; only the payload catalog (LoopHookPayloads) differs.
 */
export type LoopHookContext<T = unknown> = HookContext<T, LoopHook>;

export type LoopHookHandler<T = unknown> = (ctx: LoopHookContext<T>) => void | Promise<void>;

export interface LoopHookRegistration<K extends LoopHook = LoopHook> {
  hook: K;
  phase: LoopHookPhase;
  handler: LoopHookHandler<LoopHookPayloads[K]>;
  priority?: number;
  name?: string;
}

export type LoopBeforeHookResult<T> = BeforeHookResult<T>;

export class LoopHookRegistry extends HookRegistry<LoopHookPayloads> {}
