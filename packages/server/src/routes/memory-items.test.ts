import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryItemStore,
  MemoryAuthorizationError,
  type MemoryItemStore,
  type MemoryStoreContext,
} from "@polpo-ai/core";
import {
  memoryItemRoutes,
  type MemoryRouteDeps,
} from "./memory-items.js";

const now = "2026-07-28T10:00:00.000Z";

function context(
  namespace = "project-a",
  externalUserId = "user-a",
): MemoryStoreContext {
  return {
    namespace,
    access: {
      projectId: namespace,
      agentName: "support",
      externalUserId,
      sessionId: "session-a",
    },
    surface: "api",
    now,
  };
}

function createApp(
  store: MemoryItemStore | null = new InMemoryMemoryItemStore(),
  resolveContext: MemoryRouteDeps["resolveMemoryContext"] = () => context(),
  overrides: Partial<MemoryRouteDeps> = {},
) {
  let nextId = 0;
  return memoryItemRoutes(() => ({
    memoryItemStore: store ?? undefined,
    resolveMemoryContext: resolveContext,
    createId: () => `memory-${++nextId}`,
    createUsageId: () => `usage-${++nextId}`,
    now: () => now,
    ...overrides,
  }));
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function itemInput(overrides: Record<string, unknown> = {}) {
  return {
    scope: { kind: "user", subjectId: "user-a", agentName: "support" },
    kind: "preference",
    content: "Prefers concise weekly summaries.",
    provenance: {
      source: "explicit",
      actor: "user",
      sourceId: "request-a",
    },
    ...overrides,
  };
}

async function createItem(
  app: ReturnType<typeof createApp>,
  overrides: Record<string, unknown> = {},
) {
  const response = await app.request(
    "/agents/support/memory/items",
    json("POST", itemInput(overrides)),
  );
  return {
    response,
    body: await response.json() as any,
  };
}

describe("memoryItemRoutes", () => {
  it("is host-neutral and unavailable until a store is explicitly wired", async () => {
    const response = await createApp(null).request(
      "/agents/support/memory/items",
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Typed Memory is not available",
      code: "MEMORY_UNAVAILABLE",
    });
  });

  it("creates, lists, searches, updates, and softly forgets typed items", async () => {
    const app = createApp();
    const created = await createItem(app);

    expect(created.response.status).toBe(201);
    expect(created.body.data.item).toMatchObject({
      id: "memory-1",
      kind: "preference",
      content: "Prefers concise weekly summaries.",
      status: "active",
    });

    const listed = await app.request(
      "/agents/support/memory/items?kinds=preference&scopeKind=user"
        + "&scopeSubjectId=user-a&scopeAgentName=support&limit=10",
    );
    expect(listed.status).toBe(200);
    expect((await listed.json() as any).data.items).toHaveLength(1);

    const searched = await app.request(
      "/agents/support/memory/search",
      json("POST", { query: "weekly summary", tokenBudget: 100, maxResults: 5 }),
    );
    const searchBody = await searched.json() as any;
    expect(searched.status).toBe(200);
    expect(searchBody.data.results).toHaveLength(1);
    expect(searchBody.data.results[0].item.id).toBe("memory-1");

    const updated = await app.request(
      "/agents/support/memory/items/memory-1",
      json("PATCH", { summary: "Weekly summaries", confidence: 0.9 }),
    );
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).data.item).toMatchObject({
      summary: "Weekly summaries",
      confidence: 0.9,
    });

    const forgotten = await app.request(
      "/agents/support/memory/items/memory-1",
      { method: "DELETE" },
    );
    expect(forgotten.status).toBe(200);
    expect(await forgotten.json()).toMatchObject({
      ok: true,
      data: { forgotten: true, itemId: "memory-1" },
    });

    const afterDelete = await app.request(
      "/agents/support/memory/search",
      json("POST", { query: "weekly" }),
    );
    expect((await afterDelete.json() as any).data.results).toEqual([]);
  });

  it("records retrieval usage without exposing it in the search payload", async () => {
    const store = new InMemoryMemoryItemStore();
    const app = createApp(store);
    await createItem(app);

    await app.request(
      "/agents/support/memory/search",
      json("POST", { query: "weekly" }),
    );

    expect(await store.listUsage("memory-1", context())).toEqual([
      expect.objectContaining({
        memoryId: "memory-1",
        type: "written",
        at: now,
      }),
      expect.objectContaining({
        memoryId: "memory-1",
        type: "retrieved",
        at: now,
      }),
    ]);
  });

  it("returns 409 for a duplicate semantic memory instead of persisting it twice", async () => {
    const app = createApp();
    expect((await createItem(app)).response.status).toBe(201);

    const duplicate = await createItem(app, { id: "another-id" });

    expect(duplicate.response.status).toBe(409);
    expect(duplicate.body).toEqual({
      ok: false,
      error: "An equivalent Memory item already exists",
      code: "MEMORY_CONFLICT",
    });
  });

  it.each([
    ["invalid JSON", "{", 400],
    ["empty body", undefined, 400],
    ["unknown kind", itemInput({ kind: "guess" }), 400],
    ["empty content", itemInput({ content: " " }), 400],
    [
      "invalid confidence",
      itemInput({ confidence: 2 }),
      400,
    ],
  ])("rejects %s without touching the store", async (_name, body, status) => {
    const app = createApp();
    const response = await app.request(
      "/agents/support/memory/items",
      body === "{" ? {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      } : json("POST", body),
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "INVALID_MEMORY_REQUEST",
    });
    const listed = await app.request("/agents/support/memory/items");
    expect((await listed.json() as any).data.items).toEqual([]);
  });

  it("fails closed on sensitive content and never echoes the secret", async () => {
    const secret = "neutral-fixture-value-12345";
    const app = createApp();
    const response = await app.request(
      "/agents/support/memory/items",
      json("POST", itemInput({ content: `api_key: ${secret}` })),
    );
    const raw = await response.text();

    expect(response.status).toBe(422);
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw)).toEqual({
      ok: false,
      error: "Memory write denied by policy",
      code: "MEMORY_POLICY_DENIED",
    });
  });

  it("does not leak items across namespaces or external users", async () => {
    const store = new InMemoryMemoryItemStore();
    const projectA = createApp(store, () => context("project-a", "same-user"));
    const projectB = createApp(store, () => context("project-b", "same-user"));
    const anotherUser = createApp(store, () => context("project-a", "user-b"));

    await createItem(projectA, {
      scope: {
        kind: "user",
        subjectId: "same-user",
        agentName: "support",
      },
    });

    for (const app of [projectB, anotherUser]) {
      const listed = await app.request("/agents/support/memory/items");
      expect((await listed.json() as any).data.items).toEqual([]);
      const update = await app.request(
        "/agents/support/memory/items/memory-1",
        json("PATCH", { content: "stolen" }),
      );
      expect(update.status).toBe(404);
      const remove = await app.request(
        "/agents/support/memory/items/memory-1",
        { method: "DELETE" },
      );
      expect(remove.status).toBe(404);
    }
  });

  it("maps host authorization denial without invoking the store", async () => {
    const app = createApp(
      new InMemoryMemoryItemStore(),
      () => {
        throw new MemoryAuthorizationError("denied by host");
      },
    );

    const response = await app.request("/agents/support/memory/items");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Memory access denied",
      code: "MEMORY_FORBIDDEN",
    });
  });

  it("rejects an agent name mismatch between route and resolved context", async () => {
    const app = createApp(
      new InMemoryMemoryItemStore(),
      () => ({
        ...context(),
        access: { ...context().access, agentName: "different-agent" },
      }),
    );

    const response = await app.request("/agents/support/memory/items");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "MEMORY_FORBIDDEN",
    });
  });

  it("returns 404 for invisible or missing updates and deletes", async () => {
    const app = createApp();
    const update = await app.request(
      "/agents/support/memory/items/missing",
      json("PATCH", { content: "new" }),
    );
    const remove = await app.request(
      "/agents/support/memory/items/missing",
      { method: "DELETE" },
    );

    expect(update.status).toBe(404);
    expect(remove.status).toBe(404);
  });

  it.each([
    ["non-string query", { query: 42 }],
    ["non-array kinds", { query: "weekly", kinds: "preference" }],
    ["negative token budget", { query: "weekly", tokenBudget: -1 }],
    ["client-controlled clock", { query: "weekly", now: "2020-01-01" }],
  ])("maps malformed search input (%s) to 400", async (_name, body) => {
    const response = await createApp().request(
      "/agents/support/memory/search",
      json("POST", body),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "INVALID_MEMORY_REQUEST",
    });
  });

  it("keeps a completed operation successful when usage telemetry fails", async () => {
    class UsageFailureStore extends InMemoryMemoryItemStore {
      override async appendUsage(): Promise<void> {
        throw new Error("usage backend unavailable");
      }
    }
    const errors: unknown[] = [];
    const store = new UsageFailureStore();
    const app = createApp(store, () => context(), {
      onUsageError: (error) => {
        errors.push(error);
      },
    });

    const created = await createItem(app);

    expect(created.response.status).toBe(201);
    expect(errors).toHaveLength(1);
    expect(await store.list({}, context())).toHaveLength(1);
  });

  it("redacts unexpected store errors instead of reflecting provider details", async () => {
    const secret = "database-password-super-secret";
    class FailingStore extends InMemoryMemoryItemStore {
      override async list(): Promise<never> {
        throw new Error(`Provider failed with ${secret}`);
      }
    }

    const response = await createApp(new FailingStore()).request(
      "/agents/support/memory/items",
    );
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw)).toEqual({
      ok: false,
      error: "Memory operation failed",
      code: "MEMORY_OPERATION_FAILED",
    });
  });

  it("decodes agent names and binds them to the resolved context", async () => {
    let resolvedAgent = "";
    const app = createApp(
      new InMemoryMemoryItemStore(),
      (agent) => {
        resolvedAgent = agent;
        return {
          ...context(),
          access: { ...context().access, agentName: agent },
        };
      },
    );

    const response = await app.request(
      "/agents/support%20eu/memory/items",
    );

    expect(response.status).toBe(200);
    expect(resolvedAgent).toBe("support eu");
  });
});
