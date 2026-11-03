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
      skills: ["testing"],
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
      skills: ["testing", "review"],
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
    expect(spawnedConfig?.task.skills).toEqual(["testing"]);
  });

  it("rejects an unassigned task skill before spawning the runtime", async () => {
    const task: Task = {
      id: "task-unauthorized-skill",
      title: "Use an unavailable skill",
      description: "Try to widen runtime capability.",
      assignTo: "profiled-agent",
      skills: ["security-review"],
      dependsOn: [],
      status: "pending",
      expectations: [],
      metrics: [],
      retries: 0,
      maxRetries: 0,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    };
    const spawn = vi.fn();
    const ctx = {
      emitter: { emit: vi.fn() },
      taskStore: { transition: vi.fn(), updateTask: vi.fn() },
      runStore: { upsertRun: vi.fn(), getRun: vi.fn(), completeRun: vi.fn() },
      memoryStore: { get: vi.fn() },
      agentStore: {
        getAgent: vi.fn().mockResolvedValue({
          name: "profiled-agent",
          skills: ["testing"],
        }),
      },
      hooks: new HookRegistry(),
      config: {
        project: "profile-test",
        teams: [],
        tasks: [],
        settings: { maxRetries: 0, workDir: ".", logLevel: "quiet" },
      },
      spawner: { spawn, isAlive: vi.fn(), kill: vi.fn() },
      workDir: "/tmp/profile-test",
      agentWorkDir: "/tmp/profile-test",
      polpoDir: "/tmp/profile-test/.polpo",
      assessFn: vi.fn(),
    } as unknown as OrchestratorContext;

    await new TaskRunner(ctx).spawnForTask(task);
    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.memoryStore.get).not.toHaveBeenCalled();
    expect(ctx.runStore.completeRun).toHaveBeenCalledWith(
      expect.any(String),
      "failed",
      expect.objectContaining({ stderr: expect.stringMatching(/not assigned/i) }),
    );
  });
});
