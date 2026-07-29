import { describe, expect, it, vi } from "vitest";
import { HookRegistry } from "../hooks.js";
import { TaskRunner } from "../task-runner.js";
import type { OrchestratorContext } from "../orchestrator-context.js";
import type { RunnerConfig, Task } from "../types.js";

describe("TaskRunner model profiles", () => {
  it("passes the project profile registry and explicit agent selection to the runner", async () => {
    const task: Task = {
      id: "task-1",
      title: "Use a model profile",
      description: "Run with the configured profile.",
      assignTo: "profiled-agent",
      dependsOn: [],
      status: "pending",
      expectations: [],
      metrics: [],
      retries: 0,
      maxRetries: 0,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    };
    const modelProfiles = {
      fast: "openai/gpt-4o-mini",
    };
    const modelAllowlist = {
      "openai/gpt-4o-mini": {},
    };
    const agent = {
      name: "profiled-agent",
      model: { profile: "fast" as const },
      allowedModelProfiles: ["fast"],
    };
    let spawnedConfig: RunnerConfig | undefined;

    const ctx = {
      emitter: { emit: vi.fn() },
      taskStore: {
        transition: vi.fn(),
        updateTask: vi.fn(),
      },
      runStore: {
        upsertRun: vi.fn(),
        getRun: vi.fn().mockResolvedValue({ status: "running" }),
        updateSpawnInfo: vi.fn(),
      },
      memoryStore: {
        get: vi.fn().mockResolvedValue(""),
      },
      agentStore: {
        getAgent: vi.fn().mockResolvedValue(agent),
      },
      hooks: new HookRegistry(),
      config: {
        version: "1",
        project: "profile-test",
        teams: [],
        tasks: [],
        settings: {
          maxRetries: 0,
          workDir: ".",
          logLevel: "quiet",
          modelProfiles,
          modelAllowlist,
        },
      },
      spawner: {
        spawn: vi.fn(async (config: RunnerConfig) => {
          spawnedConfig = config;
          return { pid: 123, configPath: "memory://task-1" };
        }),
        isAlive: vi.fn(),
        kill: vi.fn(),
      },
      workDir: "/tmp/profile-test",
      agentWorkDir: "/tmp/profile-test",
      polpoDir: "/tmp/profile-test/.polpo",
      assessFn: vi.fn(),
    } as unknown as OrchestratorContext;

    await new TaskRunner(ctx).spawnForTask(task);

    expect(spawnedConfig).toBeDefined();
    expect(spawnedConfig?.agent.model).toEqual({ profile: "fast" });
    expect(spawnedConfig?.agent.allowedModelProfiles).toEqual(["fast"]);
    expect(spawnedConfig?.modelProfiles).toBe(modelProfiles);
    expect(spawnedConfig?.modelAllowlist).toBe(modelAllowlist);
  });
});
