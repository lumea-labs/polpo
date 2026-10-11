import fs from "node:fs";
import Module, { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
const [directory, mode, parameter] = process.argv.slice(2);
if (mode.endsWith("unavailable")) {
  const load = Module._load;
  Module._load = function (id, ...args) { if (id === "better-sqlite3") throw new Error("not installed"); return load.call(this, id, ...args); };
}
const emit = value => fs.writeSync(1, `${JSON.stringify(value)}\n`);
const pause = value => { emit(value); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000); };
if (mode === "run-contend") {
  const SQLite = createRequire(import.meta.url)("better-sqlite3");
  const execute = SQLite.prototype.exec;
  SQLite.prototype.exec = function (sql) {
    if (sql !== "BEGIN IMMEDIATE") return execute.call(this, sql);
    this.pragma("busy_timeout = 0");
    try { return execute.call(this, sql); }
    catch (error) {
      if (error.code !== "SQLITE_BUSY") throw error;
      // Observe actual lock contention before the parent releases the writer.
      emit({ contended: true });
      this.pragma("busy_timeout = 5000");
      return execute.call(this, sql);
    }
  };
}
let checkpoints = 0;
if (mode.includes("crash") || mode.includes("count")) {
  for (const key of ["fsyncSync", "renameSync", "rmSync"]) {
    const original = fs[key];
    fs[key] = (...args) => {
      const value = original(...args);
      checkpoints++;
      if (mode.includes("crash") && checkpoints === Number(parameter)) pause({ checkpoint: checkpoints });
      return value;
    };
  }
  syncBuiltinESMExports();
}
if (mode === "run-pause") {
  const original = fs.readFileSync;
  let paused = false;
  fs.readFileSync = (...args) => {
    const value = original(...args);
    if (!paused && String(args[0]).endsWith("/runs/run-1.json")) {
      paused = true;
      emit({ read: true });
      // Deterministic process barrier after reading the row, before its write.
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(`${directory}/release-run-writer`)) {
        if (Date.now() > deadline) throw new Error("Run writer barrier timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return value;
  };
  syncBuiltinESMExports();
}
const { FileAgentStore } = await import("../../../dist/file-agent-store.js");
const { FileTaskStore } = await import("../../../dist/file-task-store.js");
const { FileRunStore } = await import("../../../dist/file-run-store.js");
const { withProjectFileTransaction } = await import("../../../dist/project-file-transaction.js");
const { migrateProjectLayoutV2 } = await import("../../../dist/project-layout-files.js");
const store = new FileAgentStore(directory);
const assign = mode === "skills" ? (await import("../../../../cli/dist/util/runtime-skills.js")).assignRuntimeSkills : undefined;
emit({ ready: true });
process.stdin.once("data", async data => {
  try {
    const input = JSON.parse(data.toString());
    let receipt;
    let created;
    if (mode.startsWith("task-execution")) {
      const tasks = new FileTaskStore(directory);
      if (input.operation === "claim") await tasks.claimTaskExecution(input.expected, input.runId);
      else await tasks.mutateTaskExecution(input.expected, input.mutation);
    } else if (mode.startsWith("run")) {
      const runs = new FileRunStore(directory);
      if (input.operation === "complete") await runs.completeRun("run-1", "killed", { exitCode: 143, stdout: "", stderr: "cancelled", duration: 1 });
      else if (input.operation === "activity") await runs.updateActivity("run-1", { filesCreated: [], filesEdited: [], toolCalls: 9, totalTokens: 9, lastUpdate: "now" });
      else if (input.operation === "trace") await runs.appendTrace("run-1", { id: "trace", type: "sandbox.released", ts: "now", operation: "release" });
      else if (input.operation === "spawn") await runs.updateSpawnInfo("run-1", 9999, "memory://late");
      else if (input.operation === "outcomes") await runs.updateOutcomes("run-1", []);
      else if (input.operation === "resume") await runs.updateResumeState("run-1", { context: {}, steps: [], turn: 1, history: [], createdAt: "now" });
      else if (input.operation === "collected") await runs.markRunCollected("run-1");
      else throw new Error("Unknown run operation");
    } else if (mode === "hold") {
      withProjectFileTransaction(directory, () => pause({ locked: true }));
    } else if (mode === "merge") {
      await store.updateAgent("support", input);
    } else if (mode === "skills") {
      assign(dirname(directory), input, ["support"]);
    } else if (mode === "unavailable") {
      await store.getAgentSnapshot("support");
    } else if (mode === "mission-unavailable") {
      await new FileTaskStore(directory).listTasks();
    } else if (mode.startsWith("migrate-")) {
      migrateProjectLayoutV2(directory);
    } else if (mode.startsWith("mission")) {
      ({ receipt, created } = await new FileTaskStore(directory).commitMissionExecution(input));
    } else {
      await store.compareAndSwapAgent("support", input);
    }
    emit({ ok: true, checkpoints, receipt, created });
  } catch (error) { emit({ error: error.code ?? error.message }); }
  process.exit(0);
});
