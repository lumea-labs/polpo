/**
 * Adaptive isolation — resolve WHERE a task run executes.
 *
 * Pure function, zero I/O. Precedence (first valid wins):
 *   1. task.executionMode      — per-task override
 *   2. agent.executionMode     — per-agent default
 *   3. settings.taskExecution  — project-wide default
 *   4. "subprocess"            — the historical behavior
 *
 * Invalid values are ignored (fall through to the next tier) so a typo in
 * config degrades to the safe default instead of failing the spawn.
 */

import type { ExecutionMode } from "./types/config.js";

const VALID: ReadonlySet<string> = new Set(["subprocess", "in-process"]);

function valid(value: unknown): ExecutionMode | undefined {
  return typeof value === "string" && VALID.has(value) ? (value as ExecutionMode) : undefined;
}

export function resolveExecutionMode(
  task?: { executionMode?: string },
  agent?: { executionMode?: string },
  settings?: { taskExecution?: string },
): ExecutionMode {
  return (
    valid(task?.executionMode) ??
    valid(agent?.executionMode) ??
    valid(settings?.taskExecution) ??
    "subprocess"
  );
}
