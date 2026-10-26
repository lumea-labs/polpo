import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPgStores, type DrizzleStores } from "../index.js";
import { ensurePgSchema } from "../migrate.js";
import { SessionTitleCoordinator, resolveSessionTitleSettings, type SessionTitleStore } from "@polpo-ai/core/session-titles";

const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/polpo_test";
let available = false;
try { const probe = postgres(url, { max: 1, connect_timeout: 3 }); await probe`SELECT 1`; await probe.end(); available = true; } catch { /* CI supplies PostgreSQL; local suite reports a skip if unavailable. */ }
describe.skipIf(!available)("Session titles: real PostgreSQL", () => {
  const namespace = `titles_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>, client: ReturnType<typeof postgres>, stores: DrizzleStores;
  beforeAll(async () => {
    admin = postgres(url, { max: 1, onnotice: () => {} }); await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
    client = postgres(url, { max: 20, connection: { search_path: namespace }, onnotice: () => {} });
    const db = drizzle(client); await ensurePgSchema(db); await ensurePgSchema(db); stores = createPgStores(db);
  });
  afterAll(async () => { await client.end(); await admin.unsafe(`DROP SCHEMA "${namespace}" CASCADE`); await admin.end(); });
  it("atomically admits one first-message job across simultaneous writers and workers", async () => {
    const store = stores.sessionStore as typeof stores.sessionStore & SessionTitleStore;
    const id = await store.create({ title: "First", titleSource: "provisional" });
    const policy = resolveSessionTitleSettings({}, {}, {}, "test/model");
    await Promise.all(Array.from({ length: 12 }, (_, n) => store.addMessage(id, "user", `Message ${n}`, { sessionTitle: { policy } })));
    const before = await store.getSession(id); const job = (await store.getSessionTitleState(id))!.job!;
    expect((await store.getMessages(id)).some(m => m.id === job.messageId && m.content === job.text)).toBe(true);
    const generate = vi.fn(async () => ({ text: "One title" }));
    await Promise.all(Array.from({ length: 12 }, () => new SessionTitleCoordinator({ store, generate, emit: async () => {} }).run(id)));
    expect(generate).toHaveBeenCalledOnce();
    expect(await store.getSession(id)).toMatchObject({ title: "One title", titleRevision: 1, version: 12, updatedAt: before!.updatedAt });
    await store.renameSession(id, "Manual");
    expect(await store.getSession(id)).toMatchObject({ title: "Manual", titleRevision: 2 });
  });
  it("rolls back message and admission together on a failed SQL transaction", async () => {
    const store = stores.sessionStore as typeof stores.sessionStore & SessionTitleStore;
    const id = await store.create({ title: "First", titleSource: "provisional" });
    await client.unsafe(`CREATE FUNCTION reject_title() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title_work_pending THEN RAISE EXCEPTION 'title transaction rejected'; END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER reject_title BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION reject_title()`);
    try {
      await expect(store.addMessage(id, "user", "First", { sessionTitle: { policy: resolveSessionTitleSettings({}, {}, {}, "test/model") } })).rejects.toThrow();
      expect(await store.getMessages(id)).toEqual([]); expect((await store.getSessionTitleState(id))!.job).toBeUndefined();
      expect((await store.getSession(id))!.version).toBe(0);
    } finally { await client.unsafe("DROP TRIGGER reject_title ON sessions"); }
  });
});
