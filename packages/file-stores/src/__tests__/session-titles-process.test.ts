import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { FileSessionStore } from "../file-session-store.js";
import { resolveSessionTitleSettings } from "@polpo-ai/core/session-titles";
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "title-process-")); directories.push(dir);
  const store = new FileSessionStore(dir), marker = join(dir, "calls");
  const id = await store.create({ title: "ciao", titleSource: "provisional" });
  await store.addMessage(id, "user", "ciao", { sessionTitle: { policy: resolveSessionTitleSettings({}, {}, {}, "test/model") } });
  const worker = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL("./fixtures/session-title-process.mjs", import.meta.url)), dir, id, marker]);
  return { store, id, marker, worker };
}
it("admits a single inference across two actual file-store processes", async () => {
  const f = await fixture(); await Promise.all([f.worker(), f.worker()]);
  expect(readFileSync(f.marker, "utf8")).toBe("call\n");
  expect(await f.store.getSession(f.id)).toMatchObject({ title: "Generated in a worker", titleRevision: 1, version: 1 });
});
it("preserves another process's manual title and transcript writes", async () => {
  const f = await fixture(); const worker = f.worker();
  await vi.waitFor(() => expect(existsSync(f.marker)).toBe(true));
  await f.store.addMessage(f.id, "assistant", "Ciao!"); await f.store.renameSession(f.id, "Manual"); await worker;
  expect(await f.store.getSession(f.id)).toMatchObject({ title: "Manual", titleRevision: 1, version: 2, messageCount: 2 });
});
