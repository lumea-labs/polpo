import type { AgentConfig } from "../types.js";
import type { ContextBag, LoopConfig, LoopLifecycleHook } from "./types.js";

export type LoopHook = LoopLifecycleHook;

export type LoopHookPhase = "before" | "after";

export interface LoopRuntimeConfig extends LoopConfig {
  name: string;
}

export interface LoopToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
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

export interface LoopHookContext<T = unknown> {
  readonly hook: LoopHook;
  readonly phase: LoopHookPhase;
  data: T;
  cancel(reason?: string): void;
  readonly cancelled: boolean;
  readonly cancelReason?: string;
  readonly timestamp: string;
}

export type LoopHookHandler<T = unknown> = (ctx: LoopHookContext<T>) => void | Promise<void>;

export interface LoopHookRegistration<K extends LoopHook = LoopHook> {
  hook: K;
  phase: LoopHookPhase;
  handler: LoopHookHandler<LoopHookPayloads[K]>;
  priority?: number;
  name?: string;
}

export interface LoopBeforeHookResult<T> {
  cancelled: boolean;
  cancelReason?: string;
  data: T;
}

interface StoredLoopRegistration {
  hook: LoopHook;
  phase: LoopHookPhase;
  handler: LoopHookHandler<any>;
  priority: number;
  name?: string;
}

export class LoopHookRegistry {
  private registrations: StoredLoopRegistration[] = [];

  register<K extends LoopHook>(reg: LoopHookRegistration<K>): () => void {
    const stored: StoredLoopRegistration = {
      hook: reg.hook,
      phase: reg.phase,
      handler: reg.handler as LoopHookHandler<any>,
      priority: reg.priority ?? 100,
      name: reg.name,
    };

    this.registrations.push(stored);
    this.registrations.sort((a, b) => a.priority - b.priority);

    return () => {
      const idx = this.registrations.indexOf(stored);
      if (idx >= 0) this.registrations.splice(idx, 1);
    };
  }

  async runBefore<K extends LoopHook>(
    hook: K,
    data: LoopHookPayloads[K],
  ): Promise<LoopBeforeHookResult<LoopHookPayloads[K]>> {
    const handlers = this.registrations.filter(r => r.hook === hook && r.phase === "before");
    if (handlers.length === 0) return { cancelled: false, data };

    let cancelled = false;
    let cancelReason: string | undefined;
    const ctx: LoopHookContext<LoopHookPayloads[K]> = {
      hook,
      phase: "before",
      data,
      cancel(reason?: string) {
        cancelled = true;
        cancelReason = reason;
      },
      get cancelled() { return cancelled; },
      get cancelReason() { return cancelReason; },
      timestamp: new Date().toISOString(),
    };

    for (const reg of handlers) {
      try {
        await reg.handler(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[LoopHookRegistry] Error in before:${hook} handler "${reg.name ?? "anonymous"}": ${msg}`);
      }
    }

    return { cancelled, cancelReason, data: ctx.data };
  }

  async runAfter<K extends LoopHook>(
    hook: K,
    data: LoopHookPayloads[K],
  ): Promise<void> {
    const handlers = this.registrations.filter(r => r.hook === hook && r.phase === "after");
    if (handlers.length === 0) return;

    const ctx: LoopHookContext<LoopHookPayloads[K]> = {
      hook,
      phase: "after",
      data,
      cancel() {},
      get cancelled() { return false; },
      timestamp: new Date().toISOString(),
    };

    for (const reg of handlers) {
      try {
        await reg.handler(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[LoopHookRegistry] Error in after:${hook} handler "${reg.name ?? "anonymous"}": ${msg}`);
      }
    }
  }

  get size(): number {
    return this.registrations.length;
  }

  list(): Array<{ hook: LoopHook; phase: LoopHookPhase; priority: number; name?: string }> {
    return this.registrations.map(r => ({
      hook: r.hook,
      phase: r.phase,
      priority: r.priority,
      name: r.name,
    }));
  }

  clear(): void {
    this.registrations.length = 0;
  }
}
