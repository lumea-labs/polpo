import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { FileSessionStore } from "../packages/file-stores/src/file-session-store.js";
import { createSqliteStores } from "../packages/drizzle/src/index.js";
import { migrateSqliteSchema } from "../packages/drizzle/src/sqlite-migrator.js";
import { SessionTitleCoordinator, resolveSessionTitleSettings, type SessionTitleStore } from "../packages/core/src/session-titles.js";
import type { SessionStore } from "../packages/core/src/session-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });
const policy = resolveSessionTitleSettings(undefined, undefined, undefined, "test/small");

async function fixture(kind: "file" | "sqlite") {
  let store: SessionStore & SessionTitleStore;
  if (kind === "file") {
    const dir = mkdtempSync(join(tmpdir(), "polpo-title-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    store = new FileSessionStore(dir);
  } else {
    const db = new Database(":memory:"); cleanup.push(() => db.close());
    db.exec("PRAGMA foreign_keys = ON");
    const orm = drizzle(db); await migrateSqliteSchema(orm); await migrateSqliteSchema(orm);
    store = createSqliteStores(orm).sessionStore as SessionStore & SessionTitleStore;
  }
  const id = await store.create({ title: "ciao", titleSource: "provisional", agent: "leo" });
  return { store, id };
}

describe.each(["file", "sqlite"] as const)("Session titles: %s persistence", kind => {
  it("recovers from a crash immediately after the first user write, preserving transcript version and activity", async () => {
    const { store, id } = await fixture(kind);
    const user = await store.addMessage(id, "user", "ciao 👋", { sessionTitle: { policy, agentName: "leo" } });
    const before = await store.getSession(id);
    const emit = vi.fn(async () => {});
    const generate = vi.fn(async () => ({ text: "Un primo saluto 👋" }));
    const recovered = new SessionTitleCoordinator({ store, generate, emit });
    await recovered.drain();
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]![0]).toMatchObject({ messageId: user.id, text: "ciao 👋", agentName: "leo" });
    expect(await store.getSession(id)).toMatchObject({ title: "Un primo saluto 👋", titleRevision: 1, titleSource: "generated", version: before!.version, updatedAt: before!.updatedAt, messageCount: 1 });
    expect((await store.listSessions())[0]).toMatchObject({ title: "Un primo saluto 👋", titleRevision: 1 });
    expect(await store.getMessages(id)).toEqual([user]);
    expect(user).not.toHaveProperty("titleRequest");
    expect(await store.listPendingSessionTitles()).toEqual([]);
  });

  it("fences a generation after a same-text manual rename", async () => {
    const { store, id } = await fixture(kind);
    await store.addMessage(id, "user", "ciao", { sessionTitle: { policy } });
    let finish!: (result: { text: string }) => void;
    const generate = vi.fn(() => new Promise<{ text: string }>(resolve => { finish = resolve; }));
    const coordinator = new SessionTitleCoordinator({ store, generate });
    const pending = coordinator.run(id);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    await store.renameSession(id, "ciao");
    finish({ text: "Overwrite" }); await pending;
    expect(await store.getSession(id)).toMatchObject({ title: "ciao", titleSource: "manual", titleRevision: 1 });
    expect((await store.getSessionTitleState(id))?.job).toBeUndefined();
  });

  it("admits only the canonical first message and never changes manually created titles", async () => {
    const { store, id } = await fixture(kind);
    await store.addMessage(id, "user", "First", { sessionTitle: { policy } });
    await store.addMessage(id, "user", "Second", { sessionTitle: { policy: { ...policy, language: "it" } } });
    const generate = vi.fn(async () => ({ text: "First title" }));
    await new SessionTitleCoordinator({ store, generate }).run(id);
    expect(generate.mock.calls[0]![0]).toMatchObject({ text: "First", policy: { language: "auto" } });
    const manual = await store.create({ title: "Mine" });
    await store.addMessage(manual, "user", "First", { sessionTitle: { policy } });
    await new SessionTitleCoordinator({ store, generate }).run(manual);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not resurrect a deleted Session and rejects stale CAS", async () => {
    const { store, id } = await fixture(kind);
    const old = (await store.getSessionTitleState(id))!;
    await store.renameSession(id, "Manual");
    expect(await store.compareAndSetSessionTitleState(id, old, old)).toBe(false);
    await store.deleteSession(id);
    expect(await store.compareAndSetSessionTitleState(id, old, old)).toBe(false);
    expect(await store.getSession(id)).toBeUndefined();
  });
});
