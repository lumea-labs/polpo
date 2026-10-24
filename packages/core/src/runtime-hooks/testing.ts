/**
 * In-process hook runtime for tests and local simulations: command hooks are
 * answered by a function instead of a process. The contract (matching,
 * exit-code semantics, composition, continuation) is the real one.
 */
import type { HooksConfig } from "./config.js";
import { HookEngine, type CommandHookRequest, type HookExecutionRecord } from "./engine.js";
import type { CommandRunResult } from "./output.js";
import { HookRuntime, type HookRuntimeContext, type HookRuntimeOptions } from "./runtime.js";

export interface ScriptedHookRuntimeOptions {
  hooks: HooksConfig;
  /** Answer one command hook run; `input` is the parsed event JSON from stdin. */
  respond: (input: Record<string, any>, request: CommandHookRequest) => Partial<CommandRunResult> | Promise<Partial<CommandRunResult>>;
  context?: Partial<HookRuntimeContext>;
  runtimeOptions?: HookRuntimeOptions;
  /** Durable receipts keyed by execution key (replay without re-running). */
  ledger?: Map<string, HookExecutionRecord>;
}

export function createScriptedHookRuntime(options: ScriptedHookRuntimeOptions): HookRuntime {
  const ledger = options.ledger;
  const engine = new HookEngine({
    projectDir: options.context?.projectDir ?? "/workspace",
    sources: [{ source: "agent", name: "scripted", hooks: options.hooks }],
    host: {
      runCommand: async (request) => ({
        kind: "command",
        exitCode: 0,
        stdout: "",
        stderr: "",
        ...(await options.respond(JSON.parse(request.stdin) as Record<string, any>, request)),
      }),
      ...(ledger ? {
        findCompleted: async (key: string) => ledger.get(key),
        record: async (record: HookExecutionRecord) => { ledger.set(record.key, record); },
      } : {}),
    },
  });
  return new HookRuntime(engine, {
    sessionId: "session",
    cwd: "/workspace",
    projectDir: "/workspace",
    ...options.context,
  }, options.runtimeOptions);
}
