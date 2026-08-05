import { SafeExpressionEvaluator } from "./expression.js";
import {
  cloneLoopJsonValue,
  LoopContextBindingError,
  resolveLoopInputBindings,
} from "./bindings.js";
import type { LoopHookRegistry } from "./hooks.js";
import {
  type LoopApprovedGate,
  LoopApprovalRequiredError,
  LoopPermissionApprovalRequiredError,
  LoopPermissionDeniedError,
  LoopPolicyDeniedError,
} from "./run-store.js";
import {
  isHumanStep,
  isLoopStep,
  isParallelStep,
  isSwitchStep,
  isWhileStep,
  isToolStep,
  type ContextBag,
  type LoopConfig,
  type LoopHookAction,
  type LoopLifecycleHook,
  type ProjectLoopHooks,
  type ProjectLoopPolicy,
  type LoopTraceEvent,
  type Pipeline,
  type ProjectLoopPermission,
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
  type: "loop" | "tool" | "human" | "switch" | "while" | "parallel" | "skip";
  name?: string;
  when?: string;
  matched?: boolean;
  iteration?: number;
}

export interface PipelineExecutionResult {
  context: ContextBag;
  trace: PipelineTraceEvent[];
  events: LoopTraceEvent[];
}

/**
 * Durable pipeline checkpoint — everything a resumed execution needs.
 *
 * Deliberately the SAME shape the human-gate resume format already replays
 * (LoopResumeState.steps/context/previousNode): resume = execute exactly
 * `steps` against `context`. Completed steps are never in the list — their
 * outputs replay from the context bag, they are never re-executed
 * (Temporal semantics).
 */
export interface PipelineCheckpoint {
  /**
   * Steps still to execute, composed across nested frames: switch branches
   * are inlined at selection time (the choice is a historical fact, never
   * re-evaluated), while iterations re-enter through a continuation step
   * carrying `completedIterations`.
   */
  steps: Step[];
  /** Live context bag at emit time. */
  context: ContextBag;
  /** Last completed node — drives the loop:transition hook on resume. */
  previousNode?: string;
}

/**
 * Pipeline position handed to `runLoop` while checkpointing is active, so
 * the host can compose per-turn agent-session checkpoints with the pipeline
 * position. `steps[0]` is the in-flight step itself. Undefined when
 * checkpointing is off or suppressed (inside parallel branches).
 */
export interface PipelineStepPosition {
  steps: Step[];
  previousNode?: string;
}

export interface PipelineExecutorOptions {
  name?: string;
  pipeline: Pipeline;
  loops: Record<string, LoopConfig>;
  context?: ContextBag;
  /** Context roots owned by the host and unavailable to step outputs. */
  protectedContextRoots?: readonly string[];
  /** Validate and optionally normalize resolved input before any tool lifecycle hooks run. */
  validateToolInput?: (
    name: string,
    input: unknown,
    step: Extract<Step, { tool: string }>,
    context: Readonly<ContextBag>,
  ) => unknown | Promise<unknown>;
  hooks?: LoopHookRegistry;
  projectHooks?: ProjectLoopHooks;
  projectPermissions?: ProjectLoopPermission[];
  projectPolicies?: ProjectLoopPolicy[];
  resume?: {
    previousNode?: string;
    approvedGates?: LoopApprovedGate[];
  };
  onTrace?: (event: LoopTraceEvent) => void | Promise<void>;
  /**
   * Durable checkpoint sink — invoked after every completed step, at
   * switch-branch selection, and at while-iteration boundaries with the
   * composed remaining-steps continuation. Best-effort by contract: errors
   * are swallowed so a flaky store can never fail a healthy pipeline.
   *
   * v1 cut, deliberate: SUPPRESSED inside parallel branches. One resume
   * slot cannot honestly represent N concurrent branch positions, so a
   * crash mid-parallel resumes from the checkpoint BEFORE the block and
   * re-executes every branch (see the parallel handler below).
   */
  onCheckpoint?: (checkpoint: PipelineCheckpoint) => void | Promise<void>;
  runLoop: (name: string, loop: LoopConfig, context: Readonly<ContextBag>, position?: PipelineStepPosition) => Promise<PipelineLoopResult>;
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
    const protectedRoots = new Set(options.protectedContextRoots ?? []);
    for (const root of protectedRoots) {
      if (Object.prototype.hasOwnProperty.call(context, root)) {
        context[root] = deepFreeze(cloneLoopJsonValue(context[root], `$.${root}`));
      }
    }
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

    if (options.resume) {
      await state.emit({ type: "loop.resume", status: "started", data: { previousNode: options.resume.previousNode } });
    } else {
      await state.emit({ type: "loop.start", status: "started" });
    }
    try {
      if (!options.resume) {
        await this.runLifecyclePoint("loop:start", context, options, state, { loop: { name: options.name } });
      }
      await this.executeSteps(options.pipeline.steps, context, trace, options, state, options.resume?.previousNode, [], !!options.onCheckpoint);
      await this.runLifecyclePoint("loop:end", context, options, state, { loop: { name: options.name }, status: "completed" });
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
    /** Steps the OUTER frames still have to execute after this frame — the
     *  durable continuation composed across switch branches and while bodies. */
    tail: Step[] = [],
    /** Checkpointing active for this frame (false inside parallel branches). */
    checkpoints = false,
  ): Promise<string | undefined> {
    let lastNode = previousNode;
    const protectedRoots = new Set(options.protectedContextRoots ?? []);

    // Best-effort durable checkpoint: remaining steps + live bag + position.
    const emitCheckpoint = async (remaining: Step[], node: string | undefined): Promise<void> => {
      if (!checkpoints || !options.onCheckpoint) return;
      try {
        await options.onCheckpoint({ steps: remaining, context: { ...context }, previousNode: node });
      } catch { /* checkpoint persistence is best-effort */ }
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      /** Continuation after the current step completes: this frame's rest + outer tail. */
      const remainingAfter = (): Step[] => [...steps.slice(i + 1), ...tail];
      try {
        if (!this.matchesWhen(step.when, context)) {
          trace.push({ type: "skip", when: step.when, matched: false });
          await state.emit({ type: "step.skip", status: "skipped", when: step.when });
          continue;
        }

        if (isLoopStep(step)) {
          const loop = options.loops[step.loop];
          if (!loop) throw new Error(`Pipeline references unknown loop "${step.loop}"`);
          await this.runTransitionHook(lastNode, step.loop, context, options, state);
          await this.runLifecyclePoint("step:before", context, options, state, { step: { name: step.loop, type: "agent" } });
          await this.runLifecyclePoint("model:before", context, options, state, { step: { name: step.loop, type: "agent" } });
          await state.emit({ type: "step.start", step: step.loop, status: "started", when: step.when });
          // Position lets the host compose per-turn session checkpoints with
          // the pipeline position while this agent step is in flight.
          const position = checkpoints && options.onCheckpoint
            ? { steps: [step, ...remainingAfter()], previousNode: lastNode }
            : undefined;
          const result = await options.runLoop(step.loop, loop, freezeContext(context), position);
          mergeLoopResult(context, step.loop, result, protectedRoots);
          trace.push({ type: "loop", name: step.loop, when: step.when, matched: true });
          await this.runLifecyclePoint("step:after", context, options, state, { step: { name: step.loop, type: "agent" }, output: result.output });
          await state.emit({ type: "step.end", step: step.loop, status: "completed", output: result.output });
          lastNode = step.loop;
          await emitCheckpoint(remainingAfter(), lastNode);
          continue;
        }

        if (isToolStep(step)) {
          if (!options.runTool) throw new Error(`Pipeline tool step "${step.tool}" requires a tool handler`);
          const resolvedInput = resolveLoopInputBindings(step.input, context);
          const resolvedStep = { ...step, input: resolvedInput };
          const validatedInput = options.validateToolInput
            ? await options.validateToolInput(
                step.tool,
                resolvedInput,
                resolvedStep,
                freezeContext(context),
              )
            : resolvedInput;
          resolvedStep.input = validatedInput;
          await this.runTransitionHook(lastNode, step.tool, context, options, state);
          const stepName = step.saveAs ?? step.tool;
          await this.runLifecyclePoint("step:before", context, options, state, { step: { name: stepName, type: "tool" }, tool: { name: step.tool, input: validatedInput } });
          await this.runLifecyclePoint("tool:before", context, options, state, { step: { name: stepName, type: "tool" }, tool: { name: step.tool, input: validatedInput } });
          await state.emit({ type: "tool.call", tool: step.tool, step: step.saveAs ?? step.tool, status: "started", input: validatedInput });
          const result = await options.runTool(step.tool, validatedInput, freezeContext(context), resolvedStep);
          mergeStepResult(context, step.saveAs ?? step.tool, result, protectedRoots);
          trace.push({ type: "tool", name: step.tool, when: step.when, matched: true });
          await this.runLifecyclePoint("tool:after", context, options, state, { step: { name: stepName, type: "tool" }, tool: { name: step.tool, input: validatedInput }, output: result.output });
          await this.runLifecyclePoint("step:after", context, options, state, { step: { name: stepName, type: "tool" }, tool: { name: step.tool, input: validatedInput }, output: result.output });
          await state.emit({ type: "tool.result", tool: step.tool, step: step.saveAs ?? step.tool, status: "completed", output: result.output });
          lastNode = step.tool;
          await emitCheckpoint(remainingAfter(), lastNode);
          continue;
        }

        if (isSwitchStep(step)) {
          let matched = false;
          for (const branch of step.switch.cases) {
            if (this.matchesWhen(branch.when, context)) {
              trace.push({ type: "switch", when: branch.when, matched: true });
              // Pin the choice as a historical fact: the selection checkpoint
              // inlines the chosen branch ahead of the rest — a resume replays
              // the branch without ever re-evaluating the condition.
              await emitCheckpoint([...branch.steps, ...remainingAfter()], lastNode);
              lastNode = await this.executeSteps(branch.steps, context, trace, options, state, lastNode, remainingAfter(), checkpoints);
              matched = true;
              break;
            }
          }
          if (!matched && step.switch.default) {
            trace.push({ type: "switch", matched: false });
            await emitCheckpoint([...step.switch.default.steps, ...remainingAfter()], lastNode);
            lastNode = await this.executeSteps(step.switch.default.steps, context, trace, options, state, lastNode, remainingAfter(), checkpoints);
          }
          await emitCheckpoint(remainingAfter(), lastNode);
          continue;
        }

        if (isWhileStep(step)) {
          await this.runLifecyclePoint("step:before", context, options, state, { step: { name: "while", type: "while" } });
          await state.emit({
            type: "step.start",
            step: "while",
            status: "started",
            when: step.when,
            data: { condition: step.while.condition, until: step.while.until, maxIterations: step.while.maxIterations },
          });
          const maxIterations = step.while.maxIterations ?? 5;
          // Durable resume: continuation steps carry the iterations already
          // completed by a previous process — the budget stays absolute.
          let iterations = step.while.completedIterations ?? 0;
          while (this.shouldRunWhile(step.while.condition, step.while.until, context)) {
            if (iterations >= maxIterations) {
              throw new Error(`Loop while step exceeded maxIterations (${maxIterations}) before its exit condition was satisfied`);
            }
            iterations += 1;
            trace.push({ type: "while", when: step.while.condition ?? step.while.until, matched: true, iteration: iterations });
            await state.emit({
              type: "step.start",
              step: "while",
              status: "started",
              data: { iteration: iterations, condition: step.while.condition, until: step.while.until },
            });
            // A crash inside this iteration's body resumes by completing the
            // body's remaining steps, then re-entering the while with this
            // iteration already accounted for. The continuation drops the
            // step's `when` guard — entry already happened, it is history.
            const continuation: Step = { while: { ...step.while, completedIterations: iterations } };
            lastNode = await this.executeSteps(step.while.steps, context, trace, options, state, lastNode, [continuation, ...remainingAfter()], checkpoints);
            await state.emit({
              type: "step.end",
              step: "while",
              status: "completed",
              data: { iteration: iterations },
            });
            // Iteration boundary — even when the body emitted no checkpoint.
            await emitCheckpoint([continuation, ...remainingAfter()], lastNode);
          }
          trace.push({ type: "while", when: step.while.condition ?? step.while.until, matched: false, iteration: iterations });
          await this.runLifecyclePoint("step:after", context, options, state, { step: { name: "while", type: "while" }, output: { iterations } });
          await state.emit({ type: "step.end", step: "while", status: "completed", output: { iterations } });
          lastNode = "while";
          await emitCheckpoint(remainingAfter(), lastNode);
          continue;
        }

        if (isParallelStep(step)) {
          await this.runLifecyclePoint("step:before", context, options, state, { step: { name: "parallel", type: "parallel" } });
          await state.emit({ type: "step.start", step: "parallel", status: "started", when: step.when });
          const snapshot = freezeContext(context);
          const branches = normalizeParallelBranches(step.parallel);
          // Durable v1 cut (deliberate): checkpointing is DISABLED inside the
          // branches — a single resume slot cannot honestly represent N
          // concurrent branch positions. A crash mid-parallel resumes from
          // the checkpoint BEFORE this block and re-executes every branch,
          // including branches that had already completed. Per-branch
          // checkpoints (resume only the incomplete branches) are a known
          // follow-up, not faked here.
          const branchResults = await Promise.all(branches.map(async (branchSteps) => {
            const branchContext = { ...snapshot };
            const branchTrace: PipelineTraceEvent[] = [];
            await this.executeSteps(branchSteps, branchContext, branchTrace, options, state, lastNode, [], false);
            return { branchContext, branchTrace };
          }));
          for (const result of branchResults) {
            mergeContext(context, result.branchContext, protectedRoots, true);
            trace.push(...result.branchTrace);
          }
          trace.push({ type: "parallel", matched: true });
          await this.runLifecyclePoint("step:after", context, options, state, { step: { name: "parallel", type: "parallel" } });
          await state.emit({ type: "step.end", step: "parallel", status: "completed" });
          lastNode = "parallel";
          await emitCheckpoint(remainingAfter(), lastNode);
          continue;
        }

        if (isHumanStep(step)) {
          if (!options.handleHuman) throw new Error(`Pipeline human step "${step.human}" requires a human handler`);
          await this.runTransitionHook(lastNode, step.human, context, options, state);
          await this.runLifecyclePoint("step:before", context, options, state, { step: { name: step.human, type: "human" } });
          await state.emit({ type: "human.request", human: step.human, step: step.human, status: "started", when: step.when });
          const result = await options.handleHuman(step.human, step, freezeContext(context));
          mergeLoopResult(context, step.human, result, protectedRoots);
          trace.push({ type: "human", name: step.human, when: step.when, matched: true });
          await this.runLifecyclePoint("step:after", context, options, state, { step: { name: step.human, type: "human" }, output: result.output });
          await state.emit({ type: "human.result", human: step.human, step: step.human, status: "completed", output: result.output });
          lastNode = step.human;
          await emitCheckpoint(remainingAfter(), lastNode);
        }
      } catch (err) {
        this.attachApprovalResume(err, context, (err as any).resume ? steps.slice(i + 1) : steps.slice(i), lastNode);
        throw err;
      }
    }
    return lastNode;
  }

  private matchesWhen(expression: string | undefined, context: ContextBag): boolean {
    if (!expression) return true;
    return this.evaluator.evaluate(expression, context);
  }

  private shouldRunWhile(condition: string | undefined, until: string | undefined, context: ContextBag): boolean {
    if (until && this.matchesWhen(until, context)) return false;
    if (condition) return this.matchesWhen(condition, context);
    return !!until;
  }

  private async runTransitionHook(
    from: string | undefined,
    to: string,
    context: ContextBag,
    options: PipelineExecutorOptions,
    state: PipelineExecutionState,
  ): Promise<void> {
    if (!from) return;
    await this.runLifecyclePoint("loop:transition", context, options, state, { transition: { from, to } });
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
    mergeContext(context, result.data.context, new Set(options.protectedContextRoots ?? []));
    await options.hooks.runAfter("loop:transition", result.data);
    await state.emit({ type: "transition", from, to, status: "completed" });
  }

  private async runLifecyclePoint(
    hook: LoopLifecycleHook,
    context: ContextBag,
    options: PipelineExecutorOptions,
    state: PipelineExecutionState,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.enforcePermissions(hook, context, options.projectPermissions ?? [], payload, state, options.resume?.approvedGates);
    await this.enforcePolicies(hook, context, options.projectPolicies ?? [], payload, state, options.resume?.approvedGates);

    const actions = options.projectHooks?.[hook] ?? [];
    for (const action of actions) {
      if (!this.matchesWhen(action.when, this.policyContext(context, hook, payload))) continue;
      await this.runHookAction(hook, action, context, options, state, payload);
    }
  }

  private async runHookAction(
    hook: LoopLifecycleHook,
    action: LoopHookAction,
    context: ContextBag,
    options: PipelineExecutorOptions,
    state: PipelineExecutionState,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!options.runTool) {
      throw new Error(`Loop hook "${hook}" action "${action.tool}" requires a tool handler`);
    }

    const resolvedStep: Extract<Step, { tool: string }> = {
      tool: action.tool,
      input: resolveLoopInputBindings(action.input, context),
      saveAs: action.saveAs,
    };
    const validatedInput = options.validateToolInput
      ? await options.validateToolInput(
          action.tool,
          resolvedStep.input,
          resolvedStep,
          freezeContext(context),
        )
      : resolvedStep.input;
    const step = { ...resolvedStep, input: validatedInput };

    await state.emit({
      type: "tool.call",
      tool: action.tool,
      step: action.saveAs ?? action.tool,
      status: "started",
      input: step.input,
      data: { hook, kind: "hook", payload },
    });

    try {
      const result = await options.runTool(action.tool, step.input, freezeContext(context), step);
      mergeStepResult(context, action.saveAs ?? action.tool, result, new Set(options.protectedContextRoots ?? []));
      await state.emit({
        type: "tool.result",
        tool: action.tool,
        step: action.saveAs ?? action.tool,
        status: "completed",
        output: result.output,
        data: { hook, kind: "hook", payload },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await state.emit({
        type: "tool.result",
        tool: action.tool,
        step: action.saveAs ?? action.tool,
        status: "failed",
        error: message,
        data: { hook, kind: "hook", payload },
      });
      if (action.onError !== "continue") {
        throw new Error(`Loop hook "${hook}" action "${action.tool}" failed: ${message}`);
      }
    }
  }

  private async enforcePermissions(
    hook: LoopLifecycleHook,
    context: ContextBag,
    permissions: ProjectLoopPermission[],
    payload: Record<string, unknown>,
    state: PipelineExecutionState,
    approvedGates: LoopApprovedGate[] | undefined,
  ): Promise<void> {
    const relevant = permissions.filter((permission) => this.permissionAppliesToHook(permission, hook, payload));
    if (relevant.length === 0) return;

    const policyContext = this.policyContext(context, hook, payload);
    const allowPermissions = relevant.filter((permission) => permission.effect === "allow");
    let allowMatched = false;

    for (const permission of relevant) {
      const matched = this.matchesPermission(permission, hook, policyContext, payload);
      await state.emit({
        type: "permission.result",
        status: matched ? "completed" : "skipped",
        data: {
          permissionId: permission.id,
          effect: permission.effect,
          resource: permission.resource,
          action: permission.action,
          hook,
          matched,
        },
      });
      if (!matched) continue;

      if (permission.effect === "allow") {
        allowMatched = true;
        continue;
      }

      const id = permission.id ?? "anonymous";
      const suffix = permission.message ? `: ${permission.message}` : "";
      if (permission.effect === "deny") {
        throw new LoopPermissionDeniedError(permission, hook, payload, `Loop permission "${id}" denied ${hook}${suffix}`);
      }
      if (this.isGateApproved(approvedGates, "permission", id, hook)) {
        await state.emit({
          type: "approval.required",
          status: "completed",
          data: { type: "permission", permissionId: id, hook, payload, resumed: true },
        });
        continue;
      }
      await state.emit({
        type: "approval.required",
        status: "started",
        data: { type: "permission", permissionId: id, hook, payload },
      });
      throw new LoopPermissionApprovalRequiredError(permission, hook, { ...context }, payload, `Loop permission "${id}" requires approval at ${hook}${suffix}`);
    }

    if (allowPermissions.length > 0 && !allowMatched) {
      throw new LoopPermissionDeniedError(
        allowPermissions[0]!,
        hook,
        payload,
        `Loop permission allow-list blocked ${hook}: no allow permission matched`,
      );
    }
  }

  private async enforcePolicies(
    hook: LoopLifecycleHook,
    context: ContextBag,
    policies: ProjectLoopPolicy[],
    payload: Record<string, unknown>,
    state: PipelineExecutionState,
    approvedGates: LoopApprovedGate[] | undefined,
  ): Promise<void> {
    const relevant = policies.filter((policy) => (policy.hook ?? "tool:before") === hook);
    if (relevant.length === 0) return;

    const policyContext = this.policyContext(context, hook, payload);
    const allowPolicies = relevant.filter((policy) => policy.effect === "allow");
    let allowMatched = false;

    for (const policy of relevant) {
      const matched = this.matchesWhen(policy.when, policyContext);
      await state.emit({
        type: "policy.result",
        status: matched ? "completed" : "skipped",
        data: {
          policyId: policy.id,
          effect: policy.effect,
          hook,
          matched,
        },
      });
      if (!matched) continue;

      if (policy.effect === "allow") {
        allowMatched = true;
        continue;
      }

      const id = policy.id ?? "anonymous";
      const suffix = policy.message ? `: ${policy.message}` : "";
      if (policy.effect === "deny") {
        throw new LoopPolicyDeniedError(policy, hook, payload, `Loop policy "${id}" denied ${hook}${suffix}`);
      }
      if (this.isGateApproved(approvedGates, "policy", id, hook)) {
        await state.emit({
          type: "approval.required",
          status: "completed",
          data: { type: "policy", policyId: id, hook, payload, resumed: true },
        });
        continue;
      }
      await state.emit({
        type: "approval.required",
        status: "started",
        data: { type: "policy", policyId: id, hook, payload },
      });
      throw new LoopApprovalRequiredError(policy, hook, { ...context }, payload, `Loop policy "${id}" requires approval at ${hook}${suffix}`);
    }

    if (allowPolicies.length > 0 && !allowMatched) {
      throw new Error(`Loop policy allow-list blocked ${hook}: no allow policy matched`);
    }
  }

  private policyContext(context: ContextBag, hook: LoopLifecycleHook, payload: Record<string, unknown>): ContextBag {
    return {
      ...context,
      hook,
      ...payload,
    };
  }

  private permissionAppliesToHook(permission: ProjectLoopPermission, hook: LoopLifecycleHook, payload: Record<string, unknown>): boolean {
    if ((permission.match?.hook && !matchesName(permission.match.hook, hook)) || defaultHookForResource(permission.resource) !== hook) {
      return false;
    }
    if (permission.resource === "tool" && !payload.tool) return false;
    if (permission.resource === "step" && !payload.step) return false;
    if (permission.resource === "model" && !payload.step) return false;
    if (permission.resource === "human" && !(payload.step as any)?.type?.includes?.("human") && !payload.human) return false;
    return true;
  }

  private matchesPermission(
    permission: ProjectLoopPermission,
    hook: LoopLifecycleHook,
    policyContext: ContextBag,
    payload: Record<string, unknown>,
  ): boolean {
    const match = permission.match;
    if (match?.hook && !matchesName(match.hook, hook)) return false;
    if (match?.loop && !matchesName(match.loop, String(payload.loop && typeof payload.loop === "object" ? (payload.loop as any).name : policyContext.loop ?? ""))) return false;
    if (match?.step && !matchesName(match.step, String((payload.step as any)?.name ?? ""))) return false;
    if (match?.tool && !matchesName(match.tool, String((payload.tool as any)?.name ?? ""))) return false;
    if (match?.human && !matchesName(match.human, String((payload.human as any)?.name ?? (payload.step as any)?.name ?? ""))) return false;
    return permission.when ? this.matchesWhen(permission.when, policyContext) : true;
  }

  private isGateApproved(
    approvedGates: LoopApprovedGate[] | undefined,
    type: LoopApprovedGate["type"],
    id: string,
    hook: LoopLifecycleHook,
  ): boolean {
    return !!approvedGates?.some((gate) => gate.type === type && gate.id === id && gate.hook === hook);
  }

  private attachApprovalResume(
    err: unknown,
    context: ContextBag,
    remainingSteps: Step[],
    previousNode?: string,
  ): void {
    if (!(err instanceof LoopApprovalRequiredError || err instanceof LoopPermissionApprovalRequiredError)) return;
    const existing = err.resume;
    err.resume = {
      context: { ...context },
      previousNode: existing?.previousNode ?? previousNode,
      steps: existing ? [...existing.steps, ...remainingSteps] : remainingSteps,
    };
  }
}

function defaultHookForResource(resource: ProjectLoopPermission["resource"]): LoopLifecycleHook {
  switch (resource) {
    case "loop": return "loop:start";
    case "step": return "step:before";
    case "model": return "model:before";
    case "tool": return "tool:before";
    case "human": return "step:before";
  }
}

function matchesName(pattern: string | string[], value: string): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((item) => item === "*" || item === value);
}

function normalizeParallelBranches(parallel: Step[][]): Step[][] {
  return parallel.map((branch) => Array.isArray(branch) ? branch : [branch]);
}

function freezeContext(context: ContextBag): Readonly<ContextBag> {
  return Object.freeze({ ...context });
}

function deepFreeze(value: unknown): unknown {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const UNSAFE_CONTEXT_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function assertContextWriteAllowed(path: string, protectedRoots: ReadonlySet<string>): void {
  const segments = path.split(".");
  const unsafe = segments.find((segment) => UNSAFE_CONTEXT_PATH_SEGMENTS.has(segment));
  if (unsafe) {
    throw new LoopContextBindingError({
      code: "loop_binding_invalid",
      message: `Invalid loop context write path "${path}": unsafe segment "${unsafe}"`,
      contextPath: path,
    });
  }
  const root = segments[0];
  if (!root || !protectedRoots.has(root)) return;
  throw new LoopContextBindingError({
    code: "loop_context_readonly",
    message: `Loop context root "${root}" is read-only`,
    contextPath: path,
  });
}

function mergeContext(
  context: ContextBag,
  patch: Readonly<ContextBag>,
  protectedRoots: ReadonlySet<string>,
  skipProtected = false,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (skipProtected && protectedRoots.has(key)) continue;
    assertContextWriteAllowed(key, protectedRoots);
    context[key] = value;
  }
}

function setContextPath(
  context: ContextBag,
  path: string,
  value: unknown,
  protectedRoots: ReadonlySet<string>,
): void {
  assertContextWriteAllowed(path, protectedRoots);
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

function mergeStepResult(
  context: ContextBag,
  name: string,
  result: PipelineLoopResult | PipelineHumanResult | PipelineToolResult,
  protectedRoots: ReadonlySet<string>,
): void {
  if (result.context) mergeContext(context, result.context, protectedRoots);
  if (result.output !== undefined) setContextPath(context, name, result.output, protectedRoots);
}

function mergeLoopResult(
  context: ContextBag,
  name: string,
  result: PipelineLoopResult | PipelineHumanResult,
  protectedRoots: ReadonlySet<string>,
): void {
  mergeStepResult(context, name, result, protectedRoots);
}
