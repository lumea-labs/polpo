import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryItemStore,
  createMemoryItem,
  type MemoryItemStore,
  type MemoryStoreContext,
} from "@polpo-ai/core";
import {
  createTypedMemoryTools,
  type TypedMemoryToolGrants,
} from "../typed-memory-tools.js";

const now = "2026-07-28T10:00:00.000Z";
const toolContext: MemoryStoreContext = {
  namespace: "project-a",
  access: {
    projectId: "project-a",
    agentName: "support",
    externalUserId: "user-a",
    sessionId: "session-a",
  },
  surface: "chat",
  now,
};

function createTools(
  grants: TypedMemoryToolGrants,
  store: MemoryItemStore = new InMemoryMemoryItemStore(),
) {
  let id = 0;
  return {
    store,
    tools: createTypedMemoryTools(store, {
      agentName: "support",
      context: toolContext,
      grants,
      writeScope: {
        kind: "user",
        subjectId: "user-a",
        agentName: "support",
      },
      provenance: {
        source: "tool",
        actor: "agent",
        runId: "run-a",
        sessionId: "session-a",
        toolName: "memory_remember",
      },
      createId: () => `memory-${++id}`,
      createUsageId: () => `usage-${++id}`,
      now: () => now,
    }),
  };
}

async function execute(
  tools: ReturnType<typeof createTypedMemoryTools>,
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute("call-a", params);
}

describe("createTypedMemoryTools", () => {
  it("returns no tools when no action is explicitly granted", () => {
    expect(createTools({}).tools).toEqual([]);
  });

  it("can expose search without configuring any write authority", () => {
    const tools = createTypedMemoryTools(new InMemoryMemoryItemStore(), {
      agentName: "support",
      context: toolContext,
      grants: { search: true },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["memory_search"]);
  });

  it("exposes only the explicitly granted actions", () => {
    expect(createTools({ search: true }).tools.map((tool) => tool.name)).toEqual([
      "memory_search",
    ]);
    expect(createTools({
      remember: true,
      update: true,
      forget: true,
      writableScopeKinds: ["user"],
      writableKinds: ["fact"],
    }).tools.map((tool) => tool.name)).toEqual([
      "memory_remember",
      "memory_update_item",
      "memory_forget",
    ]);
  });

  it("searches authorized memory read-only and records retrieval usage", async () => {
    const { store, tools } = createTools({ search: true });
    await store.create(createMemoryItem({
      id: "memory-existing",
      scope: {
        kind: "user",
        subjectId: "user-a",
        agentName: "support",
      },
      kind: "fact",
      content: "The customer's renewal date is in October.",
      provenance: { source: "explicit", actor: "user" },
    }, { now: () => now }), toolContext);

    const result = await execute(tools, "memory_search", {
      query: "renewal",
      max_results: 3,
      token_budget: 100,
    });

    expect(result.content[0]!.type).toBe("text");
    const text = result.content[0]!.type === "text"
      ? result.content[0]!.text
      : "";
    expect(JSON.parse(text)).toMatchObject({
      total: 1,
      results: [
        {
          item: {
            id: "memory-existing",
            content: "The customer's renewal date is in October.",
          },
        },
      ],
    });
    expect(await store.listUsage("memory-existing", toolContext)).toEqual([
      expect.objectContaining({
        type: "retrieved",
        runId: "run-a",
        sessionId: "session-a",
      }),
    ]);
    expect(await store.list({}, toolContext)).toHaveLength(1);
  });

  it("remembers only in the host-fixed scope and rejects semantic duplicates", async () => {
    const { store, tools } = createTools({
      remember: true,
      writableScopeKinds: ["user"],
      writableKinds: ["preference"],
    });

    const first = await execute(tools, "memory_remember", {
      kind: "preference",
      content: "Prefer concise status updates.",
      confidence: 0.8,
    });
    expect(first.details).toMatchObject({
      item: {
        id: "memory-1",
        scope: {
          kind: "user",
          subjectId: "user-a",
          agentName: "support",
        },
      },
    });

    await expect(execute(tools, "memory_remember", {
      kind: "preference",
      content: "  prefer   concise status updates. ",
    })).rejects.toThrow("equivalent Memory item already exists");
    expect(await store.list({}, toolContext)).toHaveLength(1);
  });

  it.each([
    ["scope kind", {
      remember: true,
      writableScopeKinds: ["agent"],
      writableKinds: ["preference"],
    } satisfies TypedMemoryToolGrants],
    ["memory kind", {
      remember: true,
      writableScopeKinds: ["user"],
      writableKinds: ["fact"],
    } satisfies TypedMemoryToolGrants],
  ])("fails closed when the %s grant does not authorize a write", async (_name, grants) => {
    const { store, tools } = createTools(grants);

    await expect(execute(tools, "memory_remember", {
      kind: "preference",
      content: "Prefer concise status updates.",
    })).rejects.toThrow("not granted");
    expect(await store.list({}, toolContext)).toEqual([]);
  });

  it("never persists or echoes sensitive content", async () => {
    const secret = "neutral-fixture-value-12345";
    const { store, tools } = createTools({
      remember: true,
      writableScopeKinds: ["user"],
      writableKinds: ["fact"],
    });

    await expect(execute(tools, "memory_remember", {
      kind: "fact",
      content: `api_key: ${secret}`,
    })).rejects.toThrow("Memory write denied");
    expect(await store.list({}, toolContext)).toEqual([]);
  });

  it("updates and forgets only when each destructive action is granted", async () => {
    const { store, tools } = createTools({
      remember: true,
      update: true,
      forget: true,
      writableScopeKinds: ["user"],
      writableKinds: ["fact", "preference"],
    });
    await execute(tools, "memory_remember", {
      kind: "fact",
      content: "The renewal date is September.",
    });

    const updated = await execute(tools, "memory_update_item", {
      id: "memory-1",
      content: "The renewal date is October.",
      summary: "Renewal in October",
    });
    expect(updated.details).toMatchObject({
      item: {
        id: "memory-1",
        content: "The renewal date is October.",
      },
    });

    const forgotten = await execute(tools, "memory_forget", {
      id: "memory-1",
    });
    expect(forgotten.details).toEqual({
      itemId: "memory-1",
      forgotten: true,
    });
    expect(await store.get("memory-1", toolContext)).toBeUndefined();
  });

  it("does not reveal whether an unauthorized item exists", async () => {
    const store = new InMemoryMemoryItemStore();
    await store.create(createMemoryItem({
      id: "private-memory",
      scope: {
        kind: "user",
        subjectId: "other-user",
        agentName: "support",
      },
      kind: "fact",
      content: "Private fact",
      provenance: { source: "explicit", actor: "user" },
    }, { now: () => now }), {
      ...toolContext,
      access: { ...toolContext.access, externalUserId: "other-user" },
    });
    const { tools } = createTools({
      update: true,
      forget: true,
      writableScopeKinds: ["user"],
      writableKinds: ["fact"],
    }, store);

    await expect(execute(tools, "memory_update_item", {
      id: "private-memory",
      content: "stolen",
    })).rejects.toThrow("Memory item not found");
    await expect(execute(tools, "memory_forget", {
      id: "private-memory",
    })).rejects.toThrow("Memory item not found");
  });

  it("keeps a completed write successful when usage telemetry fails", async () => {
    class UsageFailureStore extends InMemoryMemoryItemStore {
      override async appendUsage(): Promise<void> {
        throw new Error("usage backend unavailable");
      }
    }
    const errors: unknown[] = [];
    const store = new UsageFailureStore();
    const tools = createTypedMemoryTools(store, {
      agentName: "support",
      context: toolContext,
      grants: {
        remember: true,
        writableScopeKinds: ["user"],
        writableKinds: ["fact"],
      },
      writeScope: {
        kind: "user",
        subjectId: "user-a",
        agentName: "support",
      },
      onUsageError: (error) => {
        errors.push(error);
      },
      createId: () => "memory-a",
      now: () => now,
    });

    const result = await execute(tools, "memory_remember", {
      kind: "fact",
      content: "The customer renewed.",
    });

    expect(result.details).toMatchObject({ remembered: true });
    expect(errors).toHaveLength(1);
    expect(await store.get("memory-a", toolContext)).toBeDefined();
  });

  it("rejects a host composition that binds tools to another agent", () => {
    expect(() => createTypedMemoryTools(new InMemoryMemoryItemStore(), {
      agentName: "other-agent",
      context: toolContext,
      grants: { search: true },
    })).toThrow("does not match the agent");
  });

  it("rejects incomplete write grants at composition time", () => {
    expect(() => createTypedMemoryTools(new InMemoryMemoryItemStore(), {
      agentName: "support",
      context: toolContext,
      grants: { remember: true },
      writeScope: { kind: "agent", agentName: "support" },
    })).toThrow("require writable scope kinds");

    expect(() => createTypedMemoryTools(new InMemoryMemoryItemStore(), {
      agentName: "support",
      context: toolContext,
      grants: {
        remember: true,
        writableScopeKinds: ["agent"],
        writableKinds: ["fact"],
      },
    })).toThrow("requires a host-fixed write scope");
  });
});
