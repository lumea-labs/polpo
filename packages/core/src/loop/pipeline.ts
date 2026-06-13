import { SafeExpressionEvaluator } from "./expression.js";
import type { LoopHookRegistry } from "./hooks.js";
import {
  isHumanStep,
  isLoopStep,
  isParallelStep,
  isSwitchStep,
  isToolStep,
  type ContextBag,
  type LoopConfig,
  type LoopTraceEvent,
  type Pipeline,
  type Step,
} from "./types.js";

export interface PipelineLoopResult {
  output?: unknown;
  context?: ContextBag;
}

export interface PipelineHumanResult {
  output?: unknown;
  context?: ContextBag;
}

export interface PipelineToolResult {
  output?: unknown;
  context?: ContextBag;
}

export interface PipelineTraceEvent {
  type: "loop" | "tool" | "human" | "switch" | "parallel" | "skip";
  name?: string;
  when?: string;
  matched?: boolean;
}

export interface PipelineExecutionResult {
  context: ContextBag;
  trace: PipelineTraceEvent[];
  events: LoopTraceEvent[];
}

export interface PipelineExecutorOptions {
  name?: string;
  pipeline: Pipeline;
  loops: Record<string, LoopConfig>;
  context?: ContextBag;
  hooks?: LoopHookRegistry;
  onTrace?: (event: LoopTraceEvent) => void | Promise<void>;
  runLoop: (name: string, loop: LoopConfig, context: Readonly<ContextBag>) => Promise<PipelineLoopResult>;
  runTool?: (name: string, input: unknown, context: Readonly<ContextBag>, step: Extract<Step, { tool: string }>) => Promise<PipelineToolResult>;
  handleHuman?: (name: string, step: Extract<Step, { human: string }>, context: Readonly<ContextBag>) => Promise<PipelineHumanResult>;
}

interface PipelineExecutionState {
  events: LoopTraceEvent[];
  nextEventId(): string;
  emit(event: Omit<LoopTraceEvent, "id" | "ts" | "loop">): Promise<void>;
}

export class PipelineExecutor {
  private readonly evaluator = new SafeExpressionEvaluator();

  async execute(options: PipelineExecutorOptions): Promise<PipelineExecutionResult> {
    const context = { ...(options.context ?? {}) };
    const trace: PipelineTraceEvent[] = [];
    let nextId = 0;
    const state: PipelineExecutionState = {
      events: [],
      nextEventId: () => `trace-${++nextId}`,
      emit: async (event) => {
        const full: LoopTraceEvent = {
          id: state.nextEventId(),
          ts: new Date().toISOString(),
          loop: options.name,
          ...event,
        };
        state.events.push(full);
        await options.onTrace?.(full);
      },
    };

    await state.emit({ type: "loop.start", status: "started" });
    try {
      await this.executeSteps(options.pipeline.steps, context, trace, options, state);
      await state.emit({ type: "loop.end", status: "completed" });
      return { context, trace, events: state.events };
    } catch (err) {
      await state.emit({
        type: "loop.error",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async executeSteps(
    steps: Step[],
    context: ContextBag,
    trace: PipelineTraceEvent[],
    options: PipelineExecutorOptions,
    state: PipelineExecutionState,
    previousNode?: string,
  ): Promise<string | undefined> {
    let lastNode = previousNode;
    for (const step of steps) {
      if (!this.matchesWhen(step.when, context)) {
        trace.push({ type: "skip", when: step.when, matched: false });
        await state.emit({ type: "step.skip", status: "skipped", when: step.when });
        continue;
      }

      if (isLoopStep(step)) {
        const loop = options.loops[step.loop];
        if (!loop) throw new Error(`Pipeline references unknown loop "${step.loop}"`);
        await this.runTransitionHook(lastNode, step.loop, context, options, state);
        await state.emit({ type: "step.start", step: step.loop, status: "started", when: step.when });
        const result = await options.runLoop(step.loop, loop, freezeContext(context));
        mergeLoopResult(context, step.loop, result);
        trace.push({ type: "loop", name: step.loop, when: step.when, matched: true });
        await state.emit({ type: "step.end", step: step.loop, status: "completed", output: result.output });
        lastNode = step.loop;
        continue;
      }

      if (isToolStep(step)) {
        if (!options.runTool) throw new Error(`Pipeline tool step "${step.tool}" requires a tool handler`);
        await this.runTransitionHook(lastNode, step.tool, context, options, state);
        await state.emit({ type: "tool.call", tool: step.tool, step: step.saveAs ?? step.tool, status: "started", input: step.input });
        const result = await options.runTool(step.tool, step.input, freezeContext(context), step);
        mergeStepResult(context, step.saveAs ?? step.tool, result);
        trace.push({ type: "tool", name: step.tool, when: step.when, matched: true });
        await state.emit({ type: "tool.result", tool: step.tool, step: step.saveAs ?? step.tool, status: "completed", output: result.output });
        lastNode = step.tool;
        continue;
      }

      if (isSwitchStep(step)) {
        let matched = false;
        for (const branch of step.switch.cases) {
          if (this.matchesWhen(branch.when, context)) {
            trace.push({ type: "switch", when: branch.when, matched: true });
            lastNode = await this.executeSteps(branch.steps, context, trace, options, state, lastNode);
            matched = true;
            break;
          }
        }
        if (!matched && step.switch.default) {
          trace.push({ type: "switch", matched: false });
          lastNode = await this.executeSteps(step.switch.default.steps, context, trace, options, state, lastNode);
        }
        continue;
      }

      if (isParallelStep(step)) {
        const snapshot = freezeContext(context);
        const branchResults = await Promise.all(step.parallel.map(async (child) => {
          const branchContext = { ...snapshot };
          const branchTrace: PipelineTraceEvent[] = [];
          await this.executeSteps([child], branchContext, branchTrace, options, state);
          return { branchContext, branchTrace };
        }));
        for (const result of branchResults) {
          Object.assign(context, result.branchContext);
          trace.push(...result.branchTrace);
        }
        trace.push({ type: "parallel", matched: true });
        continue;
      }

      if (isHumanStep(step)) {
        if (!options.handleHuman) throw new Error(`Pipeline human step "${step.human}" requires a human handler`);
        await this.runTransitionHook(lastNode, step.human, context, options, state);
        await state.emit({ type: "human.request", human: step.human, step: step.human, status: "started", when: step.when });
        const result = await options.handleHuman(step.human, step, freezeContext(context));
        mergeLoopResult(context, step.human, result);
        trace.push({ type: "human", name: step.human, when: step.when, matched: true });
        await state.emit({ type: "human.result", human: step.human, step: step.human, status: "completed", output: result.output });
        lastNode = step.human;
      }
    }
    return lastNode;
  }

  private matchesWhen(expression: string | undefined, context: ContextBag): boolean {
    if (!expression) return true;
    return this.evaluator.evaluate(expression, context);
  }

  private async runTransitionHook(
    from: string | undefined,
    to: string,
    context: ContextBag,
    options: PipelineExecutorOptions,
    state: PipelineExecutionState,
  ): Promise<void> {
    if (!from) return;
    if (!options.hooks) {
      await state.emit({ type: "transition", from, to, status: "completed" });
      return;
    }
    const result = await options.hooks.runBefore("loop:transition", {
      from,
      to,
      context,
    });
    if (result.cancelled) {
      throw new Error(`Loop transition from "${from}" to "${to}" cancelled${result.cancelReason ? `: ${result.cancelReason}` : ""}`);
    }
    Object.assign(context, result.data.context);
    await options.hooks.runAfter("loop:transition", result.data);
    await state.emit({ type: "transition", from, to, status: "completed" });
  }
}

function freezeContext(context: ContextBag): Readonly<ContextBag> {
  return Object.freeze({ ...context });
}

function setContextPath(context: ContextBag, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cursor: Record<string, unknown> = context;
  for (const part of parts.slice(0, -1)) {
    const current = cursor[part];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function mergeStepResult(context: ContextBag, name: string, result: PipelineLoopResult | PipelineHumanResult | PipelineToolResult): void {
  if (result.context) Object.assign(context, result.context);
  if (result.output !== undefined) setContextPath(context, name, result.output);
}

function mergeLoopResult(context: ContextBag, name: string, result: PipelineLoopResult | PipelineHumanResult): void {
  mergeStepResult(context, name, result);
}
