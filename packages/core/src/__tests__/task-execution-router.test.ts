import { describe, expect, it, vi } from "vitest";
import { TaskRunner } from "../task-runner.js";
import type { AgentConfig, RunnerConfig, Task } from "../types.js";
import type { ProjectLoopConfig } from "../loop/types.js";

const loops: Record<string, ProjectLoopConfig> = {
  research: {
    name: "research",
    label: "Research",
    description: "Collect and compare sources.",
    metadata: { secret: "PRIVATE LOOP METADATA" },
    start: "run",
    steps: {
      run: {
        type: "agent",
        systemPrompt: "PRIVATE LOOP PROMPT",
        tools: ["search_web"],
        next: "end",
      },
    },
  },
  build: {
    name: "build",
    label: "Build",
    description: "Create project files.",
    start: "run",
    steps: { run: { type: "agent", tools: ["bash"], next: "end" } },
  },
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Research competitors",
    description: "Compare the current market.",
    assignTo: "agent-1",
    dependsOn: [],
    status: "pending",
    expectations: [],
    metrics: [],
    retries: 0,
    maxRetries: 0,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    ...overrides,
  };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "agent-1",
    assignedLoops: ["research", "build"],
    executionRouter: {
      mode: "auto",
      allowedLoops: ["research", "build"],
    },
    ...overrides,
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const runs = new Map<string, any>();
  const spawned: RunnerConfig[] = [];
  const events: Array<[string, unknown]> = [];
  const getProjectLoop = vi.fn(async (name: string) => {
    calls.push(`loop:${name}`);
    return loops[name] ?? null;
  });
  const resolveExecutionRouteClassifier = vi.fn(async () => ({
    classify: async (input: unknown) => {
      calls.push("classify");
      return {
        mode: "loop",
        loop: "research",
        confidence: 0.96,
        reason: "Requires source collection",
      };
    },
  }));
  const ctx: any = {
    emitter: {
      emit: (name: string, payload: unknown) => {
        events.push([name, payload]);
        return true;
      },
    },
    agentStore: {
      getAgent: vi.fn(async () => agent()),
    },
    taskStore: {
      transition: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => undefined),
      listTasks: vi.fn(async () => []),
    },
    runStore: {
      upsertRun: vi.fn(async (run: any) => {
        runs.set(run.id, structuredClone(run));
      }),
      completeRun: vi.fn(async (id: string, status: string, result: unknown) => {
        const current = runs.get(id);
        runs.set(id, { ...current, status, result });
      }),
      getRun: vi.fn(async (id: string) => runs.get(id)),
    },
    memoryStore: {
      get: vi.fn(async () => {
        calls.push("memory");
        return "";
      }),
    },
    hooks: {
      runBeforeSync: vi.fn(() => ({ cancelled: false })),
    },
    spawner: {
      spawn: vi.fn(async (config: RunnerConfig) => {
        calls.push("spawn");
        spawned.push(config);
        return { pid: 101, configPath: "memory://runner" };
      }),
      isAlive: vi.fn(() => false),
      kill: vi.fn(),
    },
    config: {
      settings: {
        workDir: ".",
        maxRetries: 0,
        logLevel: "quiet",
      },
      providers: undefined,
    },
    polpoDir: "/project/.polpo",
    agentWorkDir: "/project",
    getProjectLoop,
    resolveExecutionRouteClassifier,
    ...overrides,
  };
  return {
    calls,
    ctx,
    events,
    getProjectLoop,
    resolveExecutionRouteClassifier,
    runs,
    spawned,
  };
}

describe("TaskRunner execution routing", () => {
  it("routes before context and spawn, then stamps an immutable loop decision", async () => {
    const h = harness();
    let classifierInput: any;
    const resolveExecutionRouteClassifier = vi.fn(async () => ({
      classify: async (input: unknown) => {
        h.calls.push("classify");
        classifierInput = input;
        return {
          mode: "loop",
          loop: "research",
          confidence: 0.96,
          reason: "Requires source collection",
        };
      },
    }));
    h.ctx.resolveExecutionRouteClassifier = resolveExecutionRouteClassifier;
    const original = task({ user: "external-user-1" });

    await new TaskRunner(h.ctx).spawnForTask(original);

    expect(h.calls).toEqual([
      "loop:research",
      "loop:build",
      "classify",
      "memory",
      "memory",
      "spawn",
    ]);
    expect(classifierInput).toEqual({
      version: 1,
      surface: "task",
      source: "task",
      input: "Research competitors\n\nCompare the current market.",
      loops: [
        {
          name: "research",
          label: "Research",
          description: "Collect and compare sources.",
        },
        {
          name: "build",
          label: "Build",
          description: "Create project files.",
        },
      ],
      labels: [],
    });
    expect(JSON.stringify(classifierInput)).not.toContain("PRIVATE");
    expect(JSON.stringify(classifierInput)).not.toContain("search_web");
    expect(resolveExecutionRouteClassifier).toHaveBeenCalledWith({
      surface: "task",
      source: "task",
      agentName: "agent-1",
      userId: "external-user-1",
    });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].task.loop).toBe("research");
    expect(h.spawned[0].executionRoute).toMatchObject({
      surface: "task",
      invocationSource: "task",
      mode: "loop",
      loop: "research",
      decisionSource: "router",
    });
    expect(Object.isFrozen(h.spawned[0].executionRoute)).toBe(true);
    expect(original.loop).toBeUndefined();
    expect(h.events).toContainEqual([
      "runtime:execution-route",
      expect.objectContaining({
        route: expect.objectContaining({ loop: "research" }),
      }),
    ]);
  });

  it("lets an explicit authorized loop win without classifier work", async () => {
    const h = harness();

    await new TaskRunner(h.ctx).spawnForTask(task({ loop: "build" }));

    expect(h.resolveExecutionRouteClassifier).not.toHaveBeenCalled();
    expect(h.getProjectLoop).not.toHaveBeenCalled();
    expect(h.spawned[0].task.loop).toBe("build");
    expect(h.spawned[0].executionRoute).toMatchObject({
      status: "explicit",
      mode: "loop",
      loop: "build",
      decisionSource: "request",
    });
  });

  it("does zero router work when configuration is absent or off", async () => {
    for (const executionRouter of [undefined, { mode: "off" as const }]) {
      const h = harness({
        agentStore: {
          getAgent: vi.fn(async () => agent({ executionRouter })),
        },
      });

      await new TaskRunner(h.ctx).spawnForTask(task());

      expect(h.getProjectLoop).not.toHaveBeenCalled();
      expect(h.resolveExecutionRouteClassifier).not.toHaveBeenCalled();
      expect(h.spawned[0].executionRoute).toBeUndefined();
      expect(h.spawned[0].task.loop).toBeUndefined();
    }
  });

  it("stays direct without classifier work when every candidate is missing", async () => {
    const h = harness({
      getProjectLoop: vi.fn(async () => null),
    });

    await new TaskRunner(h.ctx).spawnForTask(task());

    expect(h.resolveExecutionRouteClassifier).not.toHaveBeenCalled();
    expect(h.spawned[0].task.loop).toBeUndefined();
    expect(h.spawned[0].executionRoute).toMatchObject({
      status: "skipped",
      mode: "direct",
      fallbackUsed: false,
    });
  });

  it("cannot route to an unassigned loop", async () => {
    const h = harness();
    h.ctx.resolveExecutionRouteClassifier = vi.fn(async () => ({
      classify: async () => ({
        mode: "loop",
        loop: "admin",
        confidence: 1,
        reason: "Attempted widening",
      }),
    }));

    await new TaskRunner(h.ctx).spawnForTask(task());

    expect(h.spawned[0].task.loop).toBeUndefined();
    expect(h.spawned[0].executionRoute).toMatchObject({
      status: "fallback",
      mode: "direct",
      fallbackUsed: true,
    });
  });

  it("fails before memory or spawn for an unauthorized explicit loop", async () => {
    const h = harness();

    await new TaskRunner(h.ctx).spawnForTask(task({ loop: "admin" }));

    expect(h.calls).not.toContain("memory");
    expect(h.spawned).toHaveLength(0);
    expect(h.ctx.runStore.completeRun).toHaveBeenCalledWith(
      expect.any(String),
      "failed",
      expect.objectContaining({
        stderr: expect.stringContaining("Unknown loop"),
      }),
    );
  });

  it("rejects malformed router settings before loading loop manifests", async () => {
    const getProjectLoop = vi.fn();
    const h = harness({
      agentStore: {
        getAgent: vi.fn(async () => agent({
          executionRouter: {
            mode: "auto",
            allowedLoops: Array.from(
              { length: 33 },
              (_, index) => `loop-${index}`,
            ),
          },
        })),
      },
      getProjectLoop,
    });

    await new TaskRunner(h.ctx).spawnForTask(task());

    expect(getProjectLoop).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("memory");
    expect(h.spawned).toHaveLength(0);
    expect(h.ctx.runStore.completeRun).toHaveBeenCalledWith(
      expect.any(String),
      "failed",
      expect.objectContaining({
        stderr: expect.stringContaining("must not contain more than 32"),
      }),
    );
  });
});
