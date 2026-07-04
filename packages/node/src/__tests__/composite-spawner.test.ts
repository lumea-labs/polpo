import { describe, it, expect, vi } from "vitest";
import { CompositeSpawner } from "../adapters/composite-spawner.js";
import type { Spawner, SpawnResult } from "@polpo-ai/core/spawner";
import type { RunnerConfig } from "@polpo-ai/core/types";

function fakeSpawner(pid: number): Spawner & { spawn: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  return {
    spawn: vi.fn(async (_c: RunnerConfig): Promise<SpawnResult> => ({ pid, configPath: `fake://${pid}` })),
    isAlive: vi.fn((p: number) => p === pid),
    kill: vi.fn(),
  } as any;
}

const config = (mode?: string): RunnerConfig =>
  ({ runId: "r1", taskId: "t1", executionMode: mode, agent: { name: "a" }, task: { id: "t1" } }) as any;

describe("CompositeSpawner — adaptive isolation dispatch", () => {
  it("routes in-process mode to the in-process backend", async () => {
    const sub = fakeSpawner(4242);
    const inp = fakeSpawner(-7);
    const composite = new CompositeSpawner(sub, inp);

    const r = await composite.spawn(config("in-process"));
    expect(r.pid).toBe(-7);
    expect(inp.spawn).toHaveBeenCalledOnce();
    expect(sub.spawn).not.toHaveBeenCalled();
  });

  it("routes subprocess mode — and no mode at all — to the subprocess backend", async () => {
    const sub = fakeSpawner(4242);
    const inp = fakeSpawner(-7);
    const composite = new CompositeSpawner(sub, inp);

    await composite.spawn(config("subprocess"));
    await composite.spawn(config(undefined));
    expect(sub.spawn).toHaveBeenCalledTimes(2);
    expect(inp.spawn).not.toHaveBeenCalled();
  });

  it("isAlive and kill route by pid sign", () => {
    const sub = fakeSpawner(4242);
    const inp = fakeSpawner(-7);
    const composite = new CompositeSpawner(sub, inp);

    expect(composite.isAlive(-7)).toBe(true);
    expect(composite.isAlive(4242)).toBe(true);
    expect(composite.isAlive(-99)).toBe(false);

    composite.kill(-7);
    expect(inp.kill).toHaveBeenCalledWith(-7);
    expect(sub.kill).not.toHaveBeenCalled();

    composite.kill(4242);
    expect(sub.kill).toHaveBeenCalledWith(4242);
  });
});
