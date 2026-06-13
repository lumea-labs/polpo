import { SafeExpressionEvaluator } from "./expression.js";
import type { LoopHookRegistry } from "./hooks.js";
import {
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
  projectHooks?: ProjectLoopHooks;
  projectPermissions?: ProjectLoopPermission[];
  projectPolicies?: ProjectLoopPolicy[];
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
      await this.runLifecyclePoint("loop:start", context, options, state, { loop: { name: options.name } });
      await this.executeSteps(options.pipeline.steps, context, trace, options, state);
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
        await this.runLifecyclePoint("step:before", context, options, state, { step: { name: step.loop, type: "agent" } });
        await this.runLifecyclePoint("model:before", context, options, state, { step: { name: step.loop, type: "agent" } });
        await state.emit({ type: "step.start", step: step.loop, status: "started", when: step.when });
        const result = await options.runLoop(step.loop, loop, freezeContext(context));
        mergeLoopResult(context, step.loop, result);
        trace.push({ type: "loop", name: step.loop, when: step.when, matched: true });
        await this.runLifecyclePoint("step:after", context, options, state, { step: { name: step.loop, type: "agent" }, output: result.output });
        await state.emit({ type: "step.end", step: step.loop, status: "completed", output: result.output });
        lastNode = step.loop;
        continue;
      }

      if (isToolStep(step)) {
        if (!options.runTool) throw new Error(`Pipeline tool step "${step.tool}" requires a tool handler`);
        await this.runTransitionHook(lastNode, step.tool, context, options, state);
        const stepName = step.saveAs ?? step.tool;
        await this.runLifecyclePoint("step:before", context, options, state, { step: { name: stepName, type: "tool" }, tool: { name: step.tool, input: step.input } });
        await this.runLifecyclePoint("tool:before", context, options, state, { step: { name: stepName, type: "tool" }, tool: { name: step.tool, input: step.input } });
        await state.emit({ type: "tool.call", tool: step.tool, step: step.saveAs ?? step.tool, status: "started", input: step.input });
        const result = await options.runTool(step.tool, step.input, freezeContext(context), step);
        mergeStepResult(context, step.saveAs ?? step.tool, result);
        trace.push({ type: "tool", name: step.tool, when: step.when, matched: true });
        await this.runLifecyclePoint("tool:after", context, options, state, { step: { name: stepName, type: "tool" }, tool: { name: step.tool, input: step.input }, output: result.output });
        await this.runLifecyclePoint("step:after", context, options, state, { step: { name: stepName, type: "tool" }, tool: { name: step.tool, input: step.input }, output: result.output });
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
        await this.runLifecyclePoint("step:before", context, options, state, { step: { name: "parallel", type: "parallel" } });
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
        await this.runLifecyclePoint("step:after", context, options, state, { step: { name: "parallel", type: "parallel" } });
        continue;
      }

      if (isHumanStep(step)) {
        if (!options.handleHuman) throw new Error(`Pipeline human step "${step.human}" requires a human handler`);
        await this.runTransitionHook(lastNode, step.human, context, options, state);
        await this.runLifecyclePoint("step:before", context, options, state, { step: { name: step.human, type: "human" } });
        await state.emit({ type: "human.request", human: step.human, step: step.human, status: "started", when: step.when });
        const result = await options.handleHuman(step.human, step, freezeContext(context));
        mergeLoopResult(context, step.human, result);
        trace.push({ type: "human", name: step.human, when: step.when, matched: true });
        await this.runLifecyclePoint("step:after", context, options, state, { step: { name: step.human, type: "human" }, output: result.output });
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
    Object.assign(context, result.data.context);
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
    await this.enforcePermissions(hook, context, options.projectPermissions ?? [], payload, state);
    await this.enforcePolicies(hook, context, options.projectPolicies ?? [], payload, state);

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

    const step: Extract<Step, { tool: string }> = {
      tool: action.tool,
      input: action.input,
      saveAs: action.saveAs,
    };

    await state.emit({
      type: "tool.call",
      tool: action.tool,
      step: action.saveAs ?? action.tool,
      status: "started",
      input: action.input,
      data: { hook, kind: "hook", payload },
    });

    try {
      const result = await options.runTool(action.tool, action.input, freezeContext(context), step);
      mergeStepResult(context, action.saveAs ?? action.tool, result);
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
