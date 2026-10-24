/**
 * Node.js Shell implementation — wraps execa.
 *
 * Default implementation for self-hosted mode. Executes real shell commands.
 * Drop-in replacement pattern: swap with JustBashShell, SandboxProxyShell, etc.
 */
import { execa } from "execa";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import { bashSafeEnv } from "../safe-env.js";

export interface NodeShellOptions {
  /** Shell binary invoked as `<shellPath> -c <command>`. Default: `bash`. */
  shellPath?: string;
}

/**
 * Fork the command into a fresh process group so we can kill the
 * whole tree on timeout or abort. execa's built-in `timeout` only sends
 * SIGTERM to the spawned shell process; with `shell: true` the
 * shell becomes a parent of the user's command (e.g. `sleep 30`),
 * which survives the SIGTERM and keeps running until natural exit.
 * We bypass that by spawning detached and killing -PID with
 * SIGKILL when our timer fires or the caller's signal aborts.
 */
export class NodeShell implements Shell {
  private readonly shellPath: string;

  constructor(options: NodeShellOptions = {}) {
    this.shellPath = options.shellPath ?? "bash";
  }

  async execute(command: string, options?: ShellOptions): Promise<ShellResult> {
    const timeout = options?.timeout && options.timeout > 0 ? options.timeout : undefined;
    const signal = options?.signal;
    if (signal?.aborted) {
      return { stdout: "", stderr: "Command aborted before start.", exitCode: 130 };
    }
    try {
      const child = execa(this.shellPath, ["-c", command], {
        detached: true,
        cwd: options?.cwd,
        env: { ...bashSafeEnv(), ...options?.env },
        reject: false,
      });

      let killedBy: "timeout" | "abort" | undefined;
      const killGroup = (reason: "timeout" | "abort") => {
        if (killedBy) return;
        killedBy = reason;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // process already gone
        }
      };
      const timer = timeout ? setTimeout(() => killGroup("timeout"), timeout) : null;
      const onAbort = () => killGroup("abort");
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const result = await child;
        const stderr = result.stderr?.toString() ?? "";
        if (killedBy === "timeout") {
          return {
            stdout: result.stdout?.toString() ?? "",
            stderr: `${stderr}\nCommand timed out after ${timeout}ms (SIGKILL).`,
            exitCode: 124,
          };
        }
        if (killedBy === "abort") {
          return {
            stdout: result.stdout?.toString() ?? "",
            stderr: `${stderr}\nCommand aborted (SIGKILL).`,
            exitCode: 130,
          };
        }
        return {
          stdout: result.stdout?.toString() ?? "",
          stderr,
          exitCode: result.exitCode ?? (result.signal ? 130 : 0),
        };
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
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
