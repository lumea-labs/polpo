import { describe, expect, it } from "vitest";
import { normalizeProjectLoop } from "./normalize.js";
import { LoopHookRegistry } from "./hooks.js";
import { PipelineExecutor, type PipelineCheckpoint } from "./pipeline.js";
import type { ProjectLoopConfig } from "./types.js";

function duplicateAliasLoop(): ProjectLoopConfig {
  return {
    name: "repair-until-valid",
    start: "validate_initial",
    steps: {
      validate_initial: {
        type: "tool",
        tool: "site_validate",
        saveAs: "validation",
        next: "repair_1",
      },
      repair_1: {
        type: "agent",
        next: "validate_repair_1",
      },
      validate_repair_1: {
        type: "tool",
        tool: "site_validate",
        saveAs: "validation",
        next: "finalize_repair_1",
      },
      finalize_repair_1: {
        type: "tool",
        tool: "site_finalize",
        saveAs: "finalization",
        next: "end",
      },
    },
  };
}

describe("project loop step identity", () => {
  it("preserves canonical keys while allowing duplicate saveAs aliases", () => {
    const normalized = normalizeProjectLoop(duplicateAliasLoop());

    expect(normalized.pipeline?.steps).toEqual([
      expect.objectContaining({ key: "validate_initial", tool: "site_validate", saveAs: "validation" }),
      expect.objectContaining({ key: "repair_1", loop: "repair_1" }),
      expect.objectContaining({ key: "validate_repair_1", tool: "site_validate", saveAs: "validation" }),
      expect.objectContaining({ key: "finalize_repair_1", tool: "site_finalize", saveAs: "finalization" }),
    ]);
  });

  it("emits exact step keys independently from result aliases", async () => {
    const normalized = normalizeProjectLoop(duplicateAliasLoop());
    const executor = new PipelineExecutor();
    const result = await executor.execute({
      name: "repair-until-valid",
      loops: normalized.loops,
      pipeline: normalized.pipeline!,
      runLoop: async () => ({ output: { repaired: true } }),
      runTool: async (tool) => ({ output: { tool } }),
    });

    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.result",
        stepKey: "validate_initial",
        step: "validation",
        tool: "site_validate",
      }),
      expect.objectContaining({
        type: "step.end",
        stepKey: "repair_1",
        step: "repair_1",
      }),
      expect.objectContaining({
        type: "tool.result",
        stepKey: "validate_repair_1",
        step: "validation",
        tool: "site_validate",
      }),
      expect.objectContaining({
        type: "tool.result",
        stepKey: "finalize_repair_1",
        step: "finalization",
        tool: "site_finalize",
      }),
      expect.objectContaining({
        type: "transition",
        fromStepKey: "validate_repair_1",
        toStepKey: "finalize_repair_1",
      }),
    ]));
  });

  it("exposes canonical transition keys to runtime hooks", async () => {
    const normalized = normalizeProjectLoop(duplicateAliasLoop());
    const hooks = new LoopHookRegistry();
    const transitions: unknown[] = [];
    hooks.register({
      hook: "loop:transition",
      phase: "before",
      handler: ({ data }) => {
        transitions.push(data);
      },
    });

    await new PipelineExecutor().execute({
      name: "repair-until-valid",
      loops: normalized.loops,
      pipeline: normalized.pipeline!,
      hooks,
      runLoop: async () => ({ output: { repaired: true } }),
      runTool: async (tool) => ({ output: { tool } }),
    });

    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "site_validate",
        to: "repair_1",
        fromStepKey: "validate_initial",
        toStepKey: "repair_1",
      }),
    ]));
  });

  it("identifies skipped and structural graph steps", async () => {
    const normalized = normalizeProjectLoop({
      name: "structural-identity",
      start: "optional",
      steps: {
        optional: {
          type: "tool",
          tool: "probe",
          saveAs: "shared",
          when: "request.enabled == true",
          next: "repeat",
        },
        repeat: {
          type: "while",
          until: "request.done == true",
          body: "inside",
          next: "parallel_work",
        },
        inside: { type: "tool", tool: "probe", saveAs: "shared", next: "end" },
        parallel_work: {
          type: "parallel",
          branches: ["left", "right"],
          next: "end",
        },
        left: { type: "agent", next: "end" },
        right: { type: "agent", next: "end" },
      },
    });
    const executor = new PipelineExecutor();
    const result = await executor.execute({
      name: "structural-identity",
      context: { request: { enabled: false, done: true } },
      loops: normalized.loops,
      pipeline: normalized.pipeline!,
      runLoop: async (name) => ({ output: { name } }),
      runTool: async () => ({ output: {} }),
    });

    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "step.skip", stepKey: "optional" }),
      expect.objectContaining({ type: "step.start", stepKey: "repeat", step: "while" }),
      expect.objectContaining({ type: "step.end", stepKey: "repeat", step: "while" }),
      expect.objectContaining({ type: "step.start", stepKey: "parallel_work", step: "parallel" }),
      expect.objectContaining({ type: "step.end", stepKey: "parallel_work", step: "parallel" }),
    ]));
  });

  it("retains the previous step key across checkpoint and resume", async () => {
    const normalized = normalizeProjectLoop(duplicateAliasLoop());
    const executor = new PipelineExecutor();
    const checkpoints: PipelineCheckpoint[] = [];
    const common = {
      name: "repair-until-valid",
      loops: normalized.loops,
      runLoop: async () => ({ output: { repaired: true } }),
      runTool: async (tool: string) => ({ output: { tool } }),
    };

    await executor.execute({
      ...common,
      pipeline: normalized.pipeline!,
      onCheckpoint: async (checkpoint) => {
        checkpoints.push(JSON.parse(JSON.stringify(checkpoint)) as PipelineCheckpoint);
      },
    });

    const afterInitial = checkpoints[0]!;
    expect(afterInitial.previousNode).toBe("site_validate");
    expect(afterInitial.previousStepKey).toBe("validate_initial");
    expect(afterInitial.steps[0]).toEqual(expect.objectContaining({ key: "repair_1" }));

    const resumed = await executor.execute({
      ...common,
      pipeline: { ...normalized.pipeline!, steps: afterInitial.steps },
      context: afterInitial.context,
      resume: {
        previousNode: afterInitial.previousNode,
        previousStepKey: afterInitial.previousStepKey,
      },
    });

    expect(resumed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "transition",
        from: "site_validate",
        fromStepKey: "validate_initial",
        toStepKey: "repair_1",
      }),
    ]));
  });
});
