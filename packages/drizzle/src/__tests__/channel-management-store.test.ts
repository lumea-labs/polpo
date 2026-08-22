import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ChannelManagementScope } from "@polpo-ai/channels";
import { createSqliteStores } from "../index.js";
import { migrateSqliteSchema } from "../sqlite-migrator.js";

const scope: ChannelManagementScope = {
  actorId: "user-1",
  actorType: "user",
  orgId: "org-1",
  projectId: "project-1",
};

describe("DrizzleChannelManagementStore", () => {
  let sqlite: InstanceType<typeof Database>;
  let store: ReturnType<typeof createSqliteStores>["channelManagementStore"];

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    const db = drizzle(sqlite);
    await migrateSqliteSchema(db);
    store = createSqliteStores(db).channelManagementStore;
  });

  afterEach(() => sqlite.close());

  it("persists scoped channels and converges operation and destination retries", async () => {
    const first = await store.createOrReuseChannel(scope, {
      id: "channel-1",
      provider: "whatsapp",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "operation-1",
      name: "WhatsApp",
      status: "pending",
      settings: { typingEnabled: true },
      timestamp: "2026-08-17T10:00:00.000Z",
    });
    const sameOperation = await store.createOrReuseChannel(scope, {
      id: "channel-2",
      provider: "whatsapp",
      connectionId: "connection-2",
      externalChannelId: "phone-2",
      idempotencyKey: "operation-1",
      name: "Ignored",
      status: "pending",
      settings: {},
      timestamp: "2026-08-17T10:01:00.000Z",
    });
    const sameDestination = await store.createOrReuseChannel(scope, {
      id: "channel-3",
      provider: "whatsapp",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "operation-2",
      name: "Ignored too",
      status: "pending",
      settings: {},
      timestamp: "2026-08-17T10:02:00.000Z",
    });

    expect(first.id).toBe("channel-1");
    expect(sameOperation.id).toBe("channel-1");
    expect(sameDestination.id).toBe("channel-1");
    expect((await store.getChannel(scope, "channel-1"))?.settings).toEqual({ typingEnabled: true });
    expect(await store.listChannels({ ...scope, projectId: "other" })).toEqual([]);
  });

  it("upserts one scoped route and cascades it when the channel is removed", async () => {
    await store.createOrReuseChannel(scope, {
      id: "channel-1",
      provider: "telegram",
      connectionId: "connection-1",
      externalChannelId: "chat-1",
      idempotencyKey: "operation-1",
      name: "Telegram",
      status: "active",
      settings: {},
      timestamp: "2026-08-17T10:00:00.000Z",
    });
    const first = await store.upsertRoute(scope, {
      id: "route-1",
      channelId: "channel-1",
      agentName: "assistant",
      allowedTools: ["read"],
      externalChannelId: null,
      enabled: true,
      priority: 100,
      timestamp: "2026-08-17T10:00:00.000Z",
    });
    const updated = await store.upsertRoute(scope, {
      id: "route-2",
      channelId: "channel-1",
      agentName: "assistant",
      allowedTools: ["read", "bash"],
      externalChannelId: null,
      enabled: false,
      priority: 10,
      timestamp: "2026-08-17T10:01:00.000Z",
    });

    expect(first.id).toBe("route-1");
    expect(updated).toMatchObject({
      id: "route-1",
      allowedTools: ["read", "bash"],
      enabled: false,
      priority: 10,
    });
    expect(await store.listRoutes(scope, "channel-1")).toHaveLength(1);
    expect(await store.removeChannel(scope, "channel-1")).toBe(true);
    expect(await store.listRoutes(scope, "channel-1")).toEqual([]);
  });

  it("is safe to migrate repeatedly and creates unique indexes", async () => {
    const db = drizzle(sqlite);
    await migrateSqliteSchema(db);
    await migrateSqliteSchema(db);
    const indexes = sqlite.prepare("PRAGMA index_list('conversation_channels')").all() as Array<{
      name: string;
      unique: number;
    }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "uq_conversation_channels_operation", unique: 1 }),
      expect.objectContaining({ name: "uq_conversation_channels_destination", unique: 1 }),
    ]));
  });
});
