/**
 * Shell abstraction for agent tools.
 *
 * Decouples tools from child_process so they can work on any backend:
 *   - NodeShell:          child_process.exec (self-hosted, default)
 *   - JustBashShell:      just-bash in-process (serverless, edge)
 *   - SandboxProxyShell:  Remote sandbox process proxy
 */

export interface Shell {
  /** Execute a command and return the result. */
  execute(command: string, options?: ShellOptions): Promise<ShellResult>;
}

export interface ShellOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Timeout in milliseconds. */
  timeout?: number;
  /**
   * Cancels the command. Implementations should terminate the whole process
   * tree and resolve (not reject) with a non-zero exit code.
   */
  signal?: AbortSignal;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
