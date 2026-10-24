/**
 * Node.js Shell implementation for the self-hosted runtime.
 *
 * Delegates to the `@polpo-ai/tools` implementation, which runs the command
 * in its own process group and kills the whole tree (SIGKILL) on timeout or
 * when the caller's AbortSignal fires. execa's built-in `timeout` only
 * signalled the top-level shell, leaving children running, and reported a
 * timed-out command as exit code 0.
 *
 * Commands keep running under `/bin/sh -c` as before.
 */
import { NodeShell as ProcessGroupShell } from "@polpo-ai/tools";

export class NodeShell extends ProcessGroupShell {
  constructor() {
    super({ shellPath: "/bin/sh" });
  }
}
