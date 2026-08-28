import { projectLoopConfigSchema } from "../schemas.js";
import type {
  AgentLoopStep,
  HumanLoopStep,
  LoopHookAction,
  LoopNext,
  LoopTransition,
  ParallelLoopStep,
  ProjectLoopConfig,
  ProjectLoopPermission,
  ProjectLoopPolicy,
  ToolLoopStep,
  WhileLoopStep,
} from "./types.js";

/**
 * Code-first loop definition helper.
 *
 * This intentionally returns the canonical JSON-compatible ProjectLoopConfig:
 * developers can keep loops in TypeScript with type checking, while the runtime,
 * dashboard, API, and audit logs keep one declarative contract.
 */
export function defineProjectLoop(config: ProjectLoopConfig): ProjectLoopConfig {
  return projectLoopConfigSchema.parse({
    version: "1",
    kind: "graph",
    context: "shared",
    ...config,
  }) as ProjectLoopConfig;
}

export function defineLoop(config: ProjectLoopConfig): ProjectLoopConfig {
  return defineProjectLoop(config);
}

export function agentStep(step: Omit<AgentLoopStep, "type"> & { type?: "agent" }): AgentLoopStep {
  return { type: "agent", ...step };
}

export function toolStep(step: Omit<ToolLoopStep, "type">): ToolLoopStep {
  return { type: "tool", ...step };
}

export function humanStep(step: Omit<HumanLoopStep, "type">): HumanLoopStep {
  return { type: "human", ...step };
}

export function parallelStep(step: Omit<ParallelLoopStep, "type">): ParallelLoopStep {
  return { type: "parallel", ...step };
}

export function whileStep(step: Omit<WhileLoopStep, "type">): WhileLoopStep {
  return { type: "while", ...step };
}

export function when(
  expression: string,
  to: string,
  metadata: Pick<LoopTransition, "label" | "description"> = {},
): Exclude<LoopNext, string>[number] {
  return { when: expression, to, ...metadata };
}

export function otherwise(
  to: string,
  metadata: Pick<LoopTransition, "label" | "description"> = {},
): Exclude<LoopNext, string>[number] {
  return { to, ...metadata };
}

export function requireTool(tool: string): { mode: "required"; tool: string } {
  return { mode: "required", tool };
}

export function toolAction(
  tool: string,
  input?: unknown,
  options: Omit<LoopHookAction, "tool" | "input"> = {},
): LoopHookAction {
  return { tool, ...(input !== undefined ? { input } : {}), ...options };
}

export function bash(command: string, options: Omit<LoopHookAction, "tool" | "input"> = {}): LoopHookAction {
  return toolAction("bash", { command }, options);
}

export function permission(config: ProjectLoopPermission): ProjectLoopPermission {
  return config;
}

export function policy(config: ProjectLoopPolicy): ProjectLoopPolicy {
  return config;
}
