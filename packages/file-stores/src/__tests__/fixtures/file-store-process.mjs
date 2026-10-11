import fs from "node:fs";
import Module, { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
const [directory, mode, parameter] = process.argv.slice(2);
if (mode === "unavailable") {
  const load = Module._load;
  Module._load = function (id, ...args) { if (id === "better-sqlite3") throw new Error("not installed"); return load.call(this, id, ...args); };
}
const emit = value => fs.writeSync(1, `${JSON.stringify(value)}\n`);
const pause = value => { emit(value); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000); };
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
const { FileAgentStore } = await import("../../../dist/file-agent-store.js");
const { withProjectFileTransaction } = await import("../../../dist/project-file-transaction.js");
const { migrateProjectLayoutV2 } = await import("../../../dist/project-layout-files.js");
const store = new FileAgentStore(directory);
const assign = mode === "skills" ? (await import("../../../../cli/dist/util/runtime-skills.js")).assignRuntimeSkills : undefined;
emit({ ready: true });
process.stdin.once("data", async data => {
  try {
    const input = JSON.parse(data.toString());
    if (mode === "hold") {
      withProjectFileTransaction(directory, () => pause({ locked: true }));
    } else if (mode === "merge") {
      await store.updateAgent("support", input);
    } else if (mode === "skills") {
      assign(dirname(directory), input, ["support"]);
    } else if (mode === "unavailable") {
      await store.getAgentSnapshot("support");
    } else if (mode.startsWith("migrate-")) {
      migrateProjectLayoutV2(directory);
    } else {
      await store.compareAndSwapAgent("support", input);
    }
    emit({ ok: true, checkpoints });
  } catch (error) { emit({ error: error.code ?? error.message }); }
  process.exit(0);
});
