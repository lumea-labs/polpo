/**
 * Node.js Shell implementation — wraps execa.
 *
 * Default implementation for self-hosted mode. Executes real shell commands.
 * Drop-in replacement pattern: swap with JustBashShell, SandboxProxyShell, etc.
 */
import { execa } from "execa";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import { bashSafeEnv } from "../safe-env.js";

/**
 * Fork the command into a fresh process group so we can kill the
 * whole tree on timeout. execa's built-in `timeout` only sends
 * SIGTERM to the spawned shell process; with `shell: true` the
 * shell becomes a parent of the user's command (e.g. `sleep 30`),
 * which survives the SIGTERM and keeps running until natural exit.
 * We bypass that by spawning detached and killing -PID with
 * SIGKILL when our timer fires.
 */
export class NodeShell implements Shell {
  async execute(command: string, options?: ShellOptions): Promise<ShellResult> {
    const timeout = options?.timeout;
    try {
      const child = execa("bash", ["-c", command], {
        detached: true,
        cwd: options?.cwd,
        env: { ...bashSafeEnv(), ...options?.env },
        reject: false,
      });

      let killedByTimeout = false;
      const timer = timeout
        ? setTimeout(() => {
            killedByTimeout = true;
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              // process already gone
            }
          }, timeout)
        : null;

      try {
        const result = await child;
        return {
          stdout: result.stdout?.toString() ?? "",
          stderr: killedByTimeout
            ? `${result.stderr ?? ""}\nCommand timed out after ${timeout}ms (SIGKILL).`
            : result.stderr?.toString() ?? "",
          exitCode: result.exitCode ?? (killedByTimeout ? 124 : (result.signal ? 130 : 0)),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (err: any) {
      return {
        stdout: "",
        stderr: err.message ?? String(err),
        exitCode: 1,
      };
    }
  }
}
