import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileTaskStore } from "../file-task-store.js";
import { JsonTaskStore } from "../json-task-store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "polpo-task-mutations-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe.each([FileTaskStore, JsonTaskStore])("%s metadata patch authority", Store => {
  it("does not let an untyped patch replace task identity or status", async () => {
    const store = new Store(root);
    const task = await store.createTask({ title: "Original", description: "Task", assignTo: "agent",
      dependsOn: [], expectations: [], metrics: [], maxRetries: 2 });
    const id = task.id;
    expect(await store.updateTask(id, { id: "forged", status: "done", title: "Edited" } as never))
      .toMatchObject({ id, status: "pending", title: "Edited" });
    expect(await new Store(root).getTask(id)).toMatchObject({ id, status: "pending", title: "Edited" });
    expect(await store.getTask("forged")).toBeUndefined();
  });
});
