/**
 * CompositeSpawner — adaptive isolation dispatch.
 *
 * Holds both execution backends and routes each spawn by the mode the task
 * runner resolved into RunnerConfig.executionMode (task > agent > settings >
 * "subprocess"). isAlive/kill route by pid sign — the invariant established
 * by InProcessSpawner: negative pids are in-process runs, positive pids are
 * OS subprocesses (0 = sandbox, which never flows through this composite:
 * an injected spawner always bypasses it).
 */

import type { Spawner, SpawnResult } from "@polpo-ai/core/spawner";
import type { RunnerConfig } from "@polpo-ai/core/types";

export class CompositeSpawner implements Spawner {
  constructor(
    private subprocess: Spawner,
    private inProcess: Spawner,
  ) {}

  async spawn(config: RunnerConfig): Promise<SpawnResult> {
    const target = config.executionMode === "in-process" ? this.inProcess : this.subprocess;
    return target.spawn(config);
  }

  isAlive(pid: number): boolean {
    return pid < 0 ? this.inProcess.isAlive(pid) : this.subprocess.isAlive(pid);
  }

  kill(pid: number): void {
    if (pid < 0) this.inProcess.kill(pid);
    else this.subprocess.kill(pid);
  }
}
