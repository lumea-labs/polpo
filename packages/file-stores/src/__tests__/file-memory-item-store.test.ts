import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryItemStore,
  MemoryAuthorizationError,
  MemoryConflictError,
  MemoryContractError,
  createMemoryItem,
  normalizeMemoryItem,
  type CreateMemoryItemInput,
  type MemoryItemStore,
  type MemoryStoreContext,
  type TextEmbeddingProvider,
} from "@polpo-ai/core/memory";
import { FileMemoryItemStore } from "../file-memory-item-store.js";

interface MemoryItemStoreFixture {
  store: MemoryItemStore;
  cleanup?: () => Promise<void> | void;
}

type MemoryItemStoreFactory =
  () => Promise<MemoryItemStoreFixture> | MemoryItemStoreFixture;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "polpo-memory-items-"));
  return {
    store: new FileMemoryItemStore(directory),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const context: MemoryStoreContext = {
  namespace: "project-a",
  access: {
    projectId: "project-a",
    agentName: "support",
    externalUserId: "user-a",
  },
  surface: "api" as const,
};

const otherProjectContext: MemoryStoreContext = {
  namespace: "project-b",
  access: {
    orgId: "org-b",
    projectId: "project-b",
    agentName: "support",
    externalUserId: "user-a",
  },
  surface: "api",
};

function memory(
  id: string,
  content: string,
  overrides: Partial<CreateMemoryItemInput> = {},
) {
  return createMemoryItem(
    {
      scope: { kind: "agent", agentName: "support" },
      kind: "fact",
      content,
      provenance: { source: "explicit", actor: "user" },
      ...overrides,
      id,
    },
    {
      createId: () => id,
      now: () => "2026-07-28T10:00:00.000Z",
    },
  );
}

async function withStore(
  factory: MemoryItemStoreFactory,
  run: (store: MemoryItemStore) => Promise<void>,
): Promise<void> {
  const instance = await factory();
  try {
    await run(instance.store);
  } finally {
    await instance.store.close?.();
    await instance.cleanup?.();
  }
}

function memoryItemStoreConformance(
  name: string,
  factory: MemoryItemStoreFactory,
): void {
  it(`${name}: paginates with a stable created-at and id keyset`, async () => {
    await withStore(factory, async (store) => {
      for (const id of ["memory-d", "memory-a", "memory-c", "memory-b"]) {
        await store.create(memory(id, `Record ${id}.`), context);
      }

      const listPage = (store as MemoryItemStore & {
        listPage: (
          query: Record<string, unknown>,
          context: MemoryStoreContext,
        ) => Promise<{
          items: Array<{ id: string }>;
          nextCursor?: { createdAt: string; id: string };
        }>;
      }).listPage;

      expect(typeof listPage).toBe("function");
      const first = await listPage.call(store, { limit: 2 }, context);
      expect(first.items.map((item) => item.id)).toEqual([
        "memory-a",
        "memory-b",
      ]);
      expect(first.nextCursor).toEqual({
        createdAt: "2026-07-28T10:00:00.000Z",
        id: "memory-b",
      });

      await store.forget("memory-b", context);
      await store.create(memory("memory-bb", "Inserted after page one."), context);

      const second = await listPage.call(store, {
        limit: 2,
        after: first.nextCursor,
      }, context);
      expect(second.items.map((item) => item.id)).toEqual([
        "memory-bb",
        "memory-c",
      ]);
      expect(second.nextCursor).toEqual({
        createdAt: "2026-07-28T10:00:00.000Z",
        id: "memory-c",
      });

      const third = await listPage.call(store, {
        limit: 2,
        after: second.nextCursor,
      }, context);
      expect(third.items.map((item) => item.id)).toEqual(["memory-d"]);
      expect(third.nextCursor).toBeUndefined();
    });
  });

  it(`${name}: rejects malformed page positions without returning data`, async () => {
    await withStore(factory, async (store) => {
      await store.create(memory("memory-1", "Visible record."), context);
      const listPage = (store as any).listPage;

      await expect(listPage.call(store, {
        limit: 10,
        after: {
          createdAt: "not-a-timestamp",
          id: "memory-1",
        },
      }, context)).rejects.toBeInstanceOf(MemoryContractError);
      await expect(listPage.call(store, {
        limit: 10,
        after: {
          createdAt: "2026-07-28T10:00:00.000Z",
          id: "",
        },
      }, context)).rejects.toBeInstanceOf(MemoryContractError);
    });
  });

  it(`${name}: keeps zero-sized pages terminal and orders Unicode ids deterministically`, async () => {
    await withStore(factory, async (store) => {
      for (const id of ["memory-😀", "memory-é", "memory-z"]) {
        await store.create(memory(id, `Record ${id}.`), context);
      }
      const listPage = (store as any).listPage;

      await expect(listPage.call(store, { limit: 0 }, context)).resolves.toEqual({
        items: [],
      });

      const first = await listPage.call(store, { limit: 2 }, context);
      expect(first.items.map((item: { id: string }) => item.id)).toEqual([
        "memory-z",
        "memory-é",
      ]);
      const second = await listPage.call(store, {
        limit: 2,
        after: first.nextCursor,
      }, context);
      expect(second.items.map((item: { id: string }) => item.id)).toEqual([
        "memory-😀",
      ]);
    });
  });

  it(`${name}: creates, gets, lists, and updates authorized items`, async () => {
    await withStore(factory, async (store) => {
      const created = await store.create(
        memory("memory-1", "Annual billing is enabled."),
        context,
      );
      expect(created.id).toBe("memory-1");
      expect(await store.get("memory-1", context)).toEqual(created);
      expect(await store.list({}, context)).toEqual([created]);

      const updated = await store.update(
        "memory-1",
        {
          content: "Annual billing is active.",
          summary: "Billing preference",
          confidence: 0.9,
        },
        { ...context, now: "2026-07-28T11:00:00.000Z" },
      );
      expect(updated).toMatchObject({
        content: "Annual billing is active.",
        summary: "Billing preference",
        confidence: 0.9,
        updatedAt: "2026-07-28T11:00:00.000Z",
      });
    });
  });

  it(`${name}: isolates identical external users across host namespaces`, async () => {
    await withStore(factory, async (store) => {
      const first = memory("memory-user", "Prefers Italian.", {
        scope: { kind: "user", subjectId: "user-a" },
        kind: "preference",
      });
      await store.create(first, context);

      expect(await store.get(first.id, otherProjectContext)).toBeUndefined();
      expect(await store.list({}, otherProjectContext)).toEqual([]);

      const second = memory("memory-user", "Prefers French.", {
        scope: { kind: "user", subjectId: "user-a" },
        kind: "preference",
      });
      await expect(store.create(second, otherProjectContext))
        .resolves.toMatchObject({ content: "Prefers French." });
    });
  });

  it(`${name}: rejects unauthorized writes without revealing reads`, async () => {
    await withStore(factory, async (store) => {
      const privateItem = memory("private", "Private note.", {
        scope: { kind: "user", subjectId: "user-a" },
      });
      await store.create(privateItem, context);
      const wrongUser: MemoryStoreContext = {
        ...context,
        access: { ...context.access, externalUserId: "user-b" },
      };

      expect(await store.get(privateItem.id, wrongUser)).toBeUndefined();
      expect(await store.update(
        privateItem.id,
        { content: "stolen" },
        wrongUser,
      )).toBeUndefined();
      expect(await store.forget(privateItem.id, wrongUser)).toBe(false);
      await expect(store.create(memory("forbidden", "No.", {
        scope: { kind: "project", subjectId: "project-b" },
      }), context)).rejects.toBeInstanceOf(MemoryAuthorizationError);
    });
  });

  it(`${name}: rejects duplicate ids and finds dedupe candidates`, async () => {
    await withStore(factory, async (store) => {
      const candidate = memory("dedupe", " Prefers   short answers. ", {
        scope: { kind: "user", subjectId: "user-a" },
        kind: "preference",
      });
      await store.create(candidate, context);
      await expect(store.create(candidate, context)).rejects.toBeInstanceOf(
        MemoryConflictError,
      );
      expect(await store.findDedupeCandidate({
        scope: candidate.scope,
        kind: candidate.kind,
        content: "prefers short answers.",
      }, context)).toMatchObject({ id: candidate.id });
    });
  });

  it(`${name}: rejects inactive creates and invalid transitions atomically`, async () => {
    await withStore(factory, async (store) => {
      const active = memory("active", "Current value.");
      await store.create(active, context);
      const inactive = normalizeMemoryItem({
        ...memory("inactive", "Old value."),
        status: "deleted",
      });
      await expect(store.create(inactive, context)).rejects.toBeInstanceOf(
        MemoryContractError,
      );
      await expect(store.update("active", {
        status: "pending",
      }, context)).rejects.toBeInstanceOf(MemoryContractError);
      expect(await store.get("active", context)).toEqual(active);
      expect(await store.list({
        statuses: ["deleted"],
        includeExpired: true,
      }, context)).toEqual([]);
    });
  });

  it(`${name}: supersedes atomically and soft-deletes immediately`, async () => {
    await withStore(factory, async (store) => {
      await store.create(memory("old", "Uses monthly billing."), context);
      const result = await store.supersede(
        "old",
        memory("new", "Uses annual billing."),
        { ...context, now: "2026-07-28T12:00:00.000Z" },
      );
      expect(result?.superseded.status).toBe("superseded");
      expect(result?.replacement.status).toBe("active");
      expect((await store.search({ query: "billing" }, context))[0]?.item.id)
        .toBe("new");

      expect(await store.forget("new", {
        ...context,
        now: "2026-07-28T13:00:00.000Z",
      })).toBe(true);
      expect(await store.get("new", context)).toBeUndefined();
      expect(await store.search({ query: "billing" }, context)).toEqual([]);
      expect(await store.list({
        statuses: ["deleted"],
        includeExpired: true,
      }, context)).toMatchObject([{ id: "new", status: "deleted" }]);
    });
  });

  it(`${name}: rolls back supersede conflicts without changing the original`, async () => {
    await withStore(factory, async (store) => {
      await store.create(memory("old", "Old value."), context);
      await store.create(memory("existing", "Existing value."), context);
      await expect(store.supersede(
        "old",
        memory("existing", "Replacement value."),
        context,
      )).rejects.toBeInstanceOf(MemoryConflictError);
      expect(await store.get("old", context)).toMatchObject({
        id: "old",
        status: "active",
      });
    });
  });

  it(`${name}: filters expiry and enforces token budgets`, async () => {
    await withStore(factory, async (store) => {
      await store.create(memory("a", "Billing invoice reconciliation."), context);
      await store.create(memory("b", "Billing.", {
        expiresAt: "2026-07-28T10:30:00.000Z",
      }), context);
      await store.create(memory("c", "Billing invoice archive."), context);

      const results = await store.search({
        query: "billing invoice",
        tokenBudget: 10,
        maxResults: 10,
        now: "2026-07-28T11:00:00.000Z",
      }, context);
      expect(results.map((result) => result.item.id)).toEqual(["a"]);
      expect(results.reduce(
        (sum, result) => sum + result.estimatedTokens,
        0,
      )).toBeLessThanOrEqual(10);
    });
  });

  it(`${name}: records usage without cross-namespace exposure`, async () => {
    await withStore(factory, async (store) => {
      await store.create(memory("used", "Used item."), context);
      await store.appendUsage({
        id: "usage-1",
        memoryId: "used",
        type: "retrieved",
        at: "2026-07-28T12:00:00.000Z",
        runId: "run-1",
      }, context);
      expect(await store.listUsage("used", context)).toHaveLength(1);
      expect(await store.listUsage("used", otherProjectContext)).toEqual([]);
    });
  });
}

memoryItemStoreConformance("InMemoryMemoryItemStore", () => ({
  store: new InMemoryMemoryItemStore(),
}));
memoryItemStoreConformance("FileMemoryItemStore", fixture);

describe("FileMemoryItemStore durability", () => {
  it("survives reopen without modifying legacy markdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "polpo-memory-items-"));
    try {
      const legacyPath = join(directory, "memory.md");
      writeFileSync(legacyPath, "# Existing legacy memory\n", "utf8");
      const first = new FileMemoryItemStore(directory);
      await first.create(createMemoryItem({
        id: "memory-1",
        scope: { kind: "agent", agentName: "support" },
        kind: "fact",
        content: "Persists.",
        provenance: { source: "explicit", actor: "system" },
      }), context);
      await first.close();

      const reopened = new FileMemoryItemStore(directory);
      await expect(reopened.get("memory-1", context))
        .resolves.toMatchObject({ content: "Persists." });
      expect(readFileSync(legacyPath, "utf8")).toBe("# Existing legacy memory\n");
      await reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds semantic embeddings from canonical items after reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "polpo-memory-items-"));
    const embeddingProvider: TextEmbeddingProvider = {
      identity: () => ({
        provider: "fixture",
        model: "meaning-v1",
        dimensions: 2,
        revision: "r1",
      }),
      embed: async ({ texts }) => ({
        identity: {
          provider: "fixture",
          model: "meaning-v1",
          dimensions: 2,
          revision: "r1",
        },
        vectors: texts.map((text) => (
          /refund|money back/i.test(text) ? [1, 0] : [0, 1]
        )),
      }),
    };
    try {
      const first = new FileMemoryItemStore(directory, {
        semantic: { embeddingProvider },
      });
      await first.create(memory("refund", "Refunds are approved in five days."), context);
      await first.close();

      const canonical = readFileSync(join(directory, "memory-items.json"), "utf8");
      expect(canonical).not.toContain("meaning-v1");
      expect(canonical).not.toContain("vectors");

      const reopened = new FileMemoryItemStore(directory, {
        semantic: { embeddingProvider },
      });
      await expect(reopened.search({ query: "When can I get my money back?" }, context))
        .resolves.toMatchObject([{
          item: { id: "refund" },
          retrievalMode: "semantic",
        }]);
      await reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writes without dropping records", async () => {
    const { store, cleanup } = fixture();
    try {
      await Promise.all(Array.from({ length: 50 }, (_, index) => (
        store.create(createMemoryItem({
          id: `memory-${index}`,
          scope: { kind: "agent", agentName: "support" },
          kind: "fact",
          content: `Record ${index}`,
          provenance: { source: "explicit", actor: "system" },
        }), context)
      )));
      expect(await store.list({}, context)).toHaveLength(50);
    } finally {
      await store.close();
      cleanup();
    }
  });

  it("fails closed on corrupt persistence and never overwrites it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "polpo-memory-items-"));
    try {
      const path = join(directory, "memory-items.json");
      writeFileSync(path, "{ definitely-not-json", "utf8");
      const store = new FileMemoryItemStore(directory);
      await expect(store.list({}, context)).rejects.toThrow(/corrupt/i);
      await expect(store.create(createMemoryItem({
        id: "memory-1",
        scope: { kind: "agent", agentName: "support" },
        kind: "fact",
        content: "Must not overwrite.",
        provenance: { source: "explicit", actor: "system" },
      }), context)).rejects.toThrow(/corrupt/i);
      expect(readFileSync(path, "utf8")).toBe("{ definitely-not-json");
      expect(existsSync(`${path}.tmp`)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
