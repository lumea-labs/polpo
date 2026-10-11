import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RunnerConfig } from "@polpo-ai/core/types";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { NodeSpawner } from "../adapters/node-spawner.js";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); spawn.mockReset(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "polpo-node-cancel-")); roots.push(root);
  const child = () => Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn(), unref: vi.fn() });
  const config = (runId: string) => ({ runId, outputDir: join(root, "output"), taskId: "task", task: {}, agent: {} } as RunnerConfig);
  return { spawner: new NodeSpawner({ polpoDir: root, cwd: root }), child, config };
}

it("signals only the locally owned Run and never a coincidentally equal foreign PID", async () => {
  vi.useFakeTimers();
  const f = fixture(), a = f.child(), b = f.child();
  spawn.mockReturnValueOnce(a).mockReturnValueOnce(b);
  await f.spawner.spawn(f.config("a")); await f.spawner.spawn(f.config("b"));
  f.spawner.cancelRun("foreign"); expect(a.kill).not.toHaveBeenCalled(); expect(b.kill).not.toHaveBeenCalled();
  f.spawner.cancelRun("a"); expect(a.kill).toHaveBeenCalledWith("SIGTERM"); expect(b.kill).not.toHaveBeenCalled();
  a.emit("exit"); await vi.advanceTimersByTimeAsync(3000);
  expect(a.kill).toHaveBeenCalledTimes(1); expect(b.kill).not.toHaveBeenCalled();
});

it("escalates only while that same child still owns the Run", async () => {
  vi.useFakeTimers();
  const f = fixture(), original = f.child(), replacement = f.child();
  spawn.mockReturnValueOnce(original).mockReturnValueOnce(replacement);
  await f.spawner.spawn(f.config("a")); f.spawner.cancelRun("a");
  await f.spawner.spawn(f.config("a")); original.emit("exit");
  await vi.advanceTimersByTimeAsync(3000);
  expect(original.kill.mock.calls).toEqual([["SIGTERM"]]); expect(replacement.kill).not.toHaveBeenCalled();
  f.spawner.cancelRun("a"); await vi.advanceTimersByTimeAsync(3000);
  expect(replacement.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
});
