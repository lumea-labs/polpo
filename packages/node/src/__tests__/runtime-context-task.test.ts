import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeContextProvider,
  RuntimeContextRetrievalInput,
} from "@polpo-ai/core/runtime-context";
import type { RunnerConfig } from "@polpo-ai/core/types";
import type { Spawner } from "@polpo-ai/core/spawner";
import { Orchestrator } from "../core/orchestrator.js";
import {
  InMemoryRunStore,
  InMemoryTaskStore,
  createTestAgent,
} from "./fixtures.js";

function memoryResult(content = "The customer prefers concise answers.") {
  return {
    segments: [{
      kind: "memory" as const,
      entries: [{
        id: "memory-1",
        content,
        source: { type: "memory" as const, id: "memory-1" },
        timestamp: "2026-07-28T10:00:00.000Z",
        trust: "user_provided" as const,
      }],
    }],
  };
}

describe("task runtime context retrieval", () => {
  let workDir: string;
  let taskStore: InMemoryTaskStore;
  let runStore: InMemoryRunStore;
  let spawnedConfigs: RunnerConfig[];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "polpo-runtime-context-"));
    taskStore = new InMemoryTaskStore();
    runStore = new InMemoryRunStore();
    spawnedConfigs = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  function spawner(): Spawner {
    return {
      spawn: async (config) => {
        spawnedConfigs.push(config);
        return { pid: 4242, configPath: "memory://runtime-context-test" };
      },
      isAlive: () => false,
      kill: () => {},
    };
  }

  async function setup(runtimeContext?: RuntimeContextProvider) {
    const orchestrator = new Orchestrator({
      workDir,
      store: taskStore,
      runStore,
      spawner: spawner(),
      runtimeContext,
      assessFn: async () => ({
        passed: true,
        checks: [],
        metrics: [],
        timestamp: new Date().toISOString(),
      }),
    });
    await orchestrator.initInteractive("runtime-context-project", {
      name: "test-team",
      agents: [createTestAgent({ name: "agent-1" })],
    });
    return orchestrator;
  }

  it("is disabled by default and does not alter the runner config", async () => {
    const orchestrator = await setup();
    const task = await orchestrator.engine.createTask({
      title: "Prepare report",
      description: "Summarize the account",
      assignTo: "agent-1",
    });

    await (orchestrator.engine as any).runner.spawnForTask(task);

    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0].runtimeContext).toBeUndefined();
  });

  it("resolves one scoped snapshot before spawning and serializes it", async () => {
    const calls: RuntimeContextRetrievalInput[] = [];
    const orchestrator = await setup({
      tokenBudget: 1_000,
      retrieve: async (input) => {
        calls.push(input);
        return memoryResult();
      },
    });
    const task = await orchestrator.engine.createTask({
      title: "Prepare report",
      description: "Summarize the account",
      assignTo: "agent-1",
      user: "external-user-42",
    });

    await (orchestrator.engine as any).runner.spawnForTask(task);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agentName: "agent-1",
      query: "Prepare report\n\nSummarize the account",
      surface: "task",
      source: "task",
      externalUserId: "external-user-42",
      tokenBudget: 1_000,
    });
    expect(calls[0].runId).toEqual(expect.any(String));
    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0].runtimeContext?.segments[0].entries[0].id)
      .toBe("memory-1");
    expect(spawnedConfigs[0].runtimeContext?.audit.selectedEntries).toBe(1);
  });

  it("does not copy legacy agent Memory into a task when typed Memory replaces it", async () => {
    const orchestrator = await setup({
      tokenBudget: 1_000,
      retrieve: async () => ({
        ...memoryResult("Use the typed customer preference."),
        legacyMemory: { agent: "replace" },
      }),
    });
    await orchestrator.engine.saveAgentMemory(
      "agent-1",
      "LEGACY_AGENT_MEMORY_MUST_NOT_BE_INJECTED",
    );
    await orchestrator.engine.saveMemory("SHARED_MEMORY_REMAINS_AVAILABLE");
    const task = await orchestrator.engine.createTask({
      title: "Prepare report",
      description: "Summarize the account",
      assignTo: "agent-1",
    });

    await (orchestrator.engine as any).runner.spawnForTask(task);

    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0].task.description).not.toContain(
      "LEGACY_AGENT_MEMORY_MUST_NOT_BE_INJECTED",
    );
    expect(spawnedConfigs[0].task.description).toContain(
      "SHARED_MEMORY_REMAINS_AVAILABLE",
    );
    expect(spawnedConfigs[0].runtimeContext?.legacyMemory).toEqual({
      agent: "replace",
    });
    expect(spawnedConfigs[0].runtimeContext?.segments[0].entries[0].content)
      .toBe("Use the typed customer preference.");
  });

  it("does not copy shared Memory into a task when Brain replaces it with no results", async () => {
    const orchestrator = await setup({
      tokenBudget: 1_000,
      retrieve: async () => ({
        segments: [],
        legacyMemory: { shared: "replace" },
      }),
    });
    await orchestrator.engine.saveAgentMemory(
      "agent-1",
      "AGENT_MEMORY_REMAINS_AVAILABLE",
    );
    await orchestrator.engine.saveMemory(
      "LEGACY_SHARED_MEMORY_MUST_NOT_BE_INJECTED",
    );
    const task = await orchestrator.engine.createTask({
      title: "Prepare report",
      description: "Summarize the account",
      assignTo: "agent-1",
    });

    await (orchestrator.engine as any).runner.spawnForTask(task);

    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0].task.description).not.toContain(
      "LEGACY_SHARED_MEMORY_MUST_NOT_BE_INJECTED",
    );
    expect(spawnedConfigs[0].task.description).toContain(
      "AGENT_MEMORY_REMAINS_AVAILABLE",
    );
    expect(spawnedConfigs[0].runtimeContext?.legacyMemory).toEqual({
      shared: "replace",
    });
  });

  it("does not invoke a zero-budget provider or serialize empty context", async () => {
    const retrieve = vi.fn(async () => memoryResult());
    const orchestrator = await setup({ tokenBudget: 0, retrieve });
    const task = await orchestrator.engine.createTask({
      title: "No retrieval",
      description: "Leave the task unchanged",
      assignTo: "agent-1",
    });

    await (orchestrator.engine as any).runner.spawnForTask(task);

    expect(retrieve).not.toHaveBeenCalled();
    expect(spawnedConfigs[0].runtimeContext).toBeUndefined();
  });

  it("fails the durable run before spawn without leaking provider errors", async () => {
    const orchestrator = await setup({
      tokenBudget: 1_000,
      retrieve: async () => {
        throw new Error("secret-provider-token-value");
      },
    });
    const task = await orchestrator.engine.createTask({
      title: "Sensitive retrieval",
      description: "The provider will fail",
      assignTo: "agent-1",
    });

    await (orchestrator.engine as any).runner.spawnForTask(task);

    expect(spawnedConfigs).toHaveLength(0);
    const run = await runStore.getRunByTaskId(task.id);
    expect(run?.status).toBe("failed");
    expect(run?.result?.stderr).toContain("Runtime context retrieval failed");
    expect(run?.result?.stderr).not.toContain("secret-provider-token-value");
  });
});
