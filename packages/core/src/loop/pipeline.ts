import { SafeExpressionEvaluator } from "./expression.js";
import type { LoopHookRegistry } from "./hooks.js";
import { isHumanStep, isLoopStep, isParallelStep, isSwitchStep, type ContextBag, type LoopConfig, type Pipeline, type Step } from "./types.js";

export interface PipelineLoopResult {
  output?: unknown;
  context?: ContextBag;
}

export interface PipelineHumanResult {
  output?: unknown;
  context?: ContextBag;
}

export interface PipelineTraceEvent {
  type: "loop" | "human" | "switch" | "parallel" | "skip";
  name?: string;
  when?: string;
  matched?: boolean;
}

export interface PipelineExecutionResult {
  context: ContextBag;
  trace: PipelineTraceEvent[];
}

export interface PipelineExecutorOptions {
  pipeline: Pipeline;
  loops: Record<string, LoopConfig>;
  context?: ContextBag;
  hooks?: LoopHookRegistry;
  runLoop: (name: string, loop: LoopConfig, context: Readonly<ContextBag>) => Promise<PipelineLoopResult>;
  handleHuman?: (name: string, step: Extract<Step, { human: string }>, context: Readonly<ContextBag>) => Promise<PipelineHumanResult>;
}

export class PipelineExecutor {
  private readonly evaluator = new SafeExpressionEvaluator();

  async execute(options: PipelineExecutorOptions): Promise<PipelineExecutionResult> {
    const context = { ...(options.context ?? {}) };
    const trace: PipelineTraceEvent[] = [];
    await this.executeSteps(options.pipeline.steps, context, trace, options);
    return { context, trace };
  }

  private async executeSteps(
    steps: Step[],
    context: ContextBag,
    trace: PipelineTraceEvent[],
    options: PipelineExecutorOptions,
    previousNode?: string,
  ): Promise<string | undefined> {
    let lastNode = previousNode;
    for (const step of steps) {
      if (!this.matchesWhen(step.when, context)) {
        trace.push({ type: "skip", when: step.when, matched: false });
        continue;
      }

      if (isLoopStep(step)) {
        const loop = options.loops[step.loop];
        if (!loop) throw new Error(`Pipeline references unknown loop "${step.loop}"`);
        await this.runTransitionHook(lastNode, step.loop, context, options);
        const result = await options.runLoop(step.loop, loop, freezeContext(context));
        mergeLoopResult(context, step.loop, result);
        trace.push({ type: "loop", name: step.loop, when: step.when, matched: true });
        lastNode = step.loop;
        continue;
      }

      if (isSwitchStep(step)) {
        let matched = false;
        for (const branch of step.switch.cases) {
          if (this.matchesWhen(branch.when, context)) {
            trace.push({ type: "switch", when: branch.when, matched: true });
            lastNode = await this.executeSteps(branch.steps, context, trace, options, lastNode);
            matched = true;
            break;
          }
        }
        if (!matched && step.switch.default) {
          trace.push({ type: "switch", matched: false });
          lastNode = await this.executeSteps(step.switch.default.steps, context, trace, options, lastNode);
        }
        continue;
      }

      if (isParallelStep(step)) {
        const snapshot = freezeContext(context);
        const branchResults = await Promise.all(step.parallel.map(async (child) => {
          const branchContext = { ...snapshot };
          const branchTrace: PipelineTraceEvent[] = [];
          await this.executeSteps([child], branchContext, branchTrace, options);
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
        await this.runTransitionHook(lastNode, step.human, context, options);
        const result = await options.handleHuman(step.human, step, freezeContext(context));
        mergeLoopResult(context, step.human, result);
        trace.push({ type: "human", name: step.human, when: step.when, matched: true });
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
  ): Promise<void> {
    if (!from || !options.hooks) return;
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
  }
}

function freezeContext(context: ContextBag): Readonly<ContextBag> {
  return Object.freeze({ ...context });
}

function mergeLoopResult(context: ContextBag, name: string, result: PipelineLoopResult | PipelineHumanResult): void {
  if (result.context) Object.assign(context, result.context);
  if (result.output !== undefined) context[name] = result.output;
}
