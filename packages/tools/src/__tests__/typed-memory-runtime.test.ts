import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryItemStore,
  createToolInvocationContext,
} from "@polpo-ai/core";
import { resolveTypedMemoryTools } from "../typed-memory-runtime.js";

const invocation = createToolInvocationContext({
  requestId: "request-a",
  runId: "run-a",
  sessionId: "session-a",
  user: "external-user-a",
  metadata: {},
  surface: "chat",
});

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveTypedMemoryTools({
    store: new InMemoryMemoryItemStore(),
    namespace: "project-a",
    agent: {
      name: "support",
      allowedTools: ["memory_*"],
      memory: {
        tools: {
          search: true,
          remember: true,
          update: true,
          forget: true,
          writeScope: "invocation-user",
          writableKinds: ["fact", "preference"],
        },
      },
    },
    invocation,
    ...overrides,
  });
}

describe("resolveTypedMemoryTools", () => {
  it("exposes nothing unless the agent opts into typed Memory", () => {
    expect(resolve({
      agent: { name: "support", allowedTools: ["memory_*"] },
    })).toEqual([]);
  });

  it("intersects Memory capabilities with allowedTools", () => {
    const tools = resolve({
      agent: {
        name: "support",
        allowedTools: ["memory_search", "memory_remember"],
        memory: {
          tools: {
            search: true,
            remember: true,
            update: true,
            writableKinds: ["fact"],
          },
        },
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_remember",
    ]);
  });

  it("binds invocation-user writes to the immutable invocation identity", async () => {
    const store = new InMemoryMemoryItemStore();
    const [tool] = resolve({
      store,
      agent: {
        name: "support",
        allowedTools: ["memory_remember"],
        memory: {
          tools: {
            remember: true,
            writeScope: "invocation-user",
            writableKinds: ["fact"],
          },
        },
      },
    });

    await tool!.execute("call-a", { kind: "fact", content: "Renewal is in October." });
    const [item] = await store.list({}, {
      namespace: "project-a",
      access: {
        projectId: "project-a",
        agentName: "support",
        externalUserId: "external-user-a",
        sessionId: "session-a",
      },
      surface: "chat",
    });

    expect(item).toMatchObject({
      scope: {
        kind: "user",
        subjectId: "external-user-a",
        agentName: "support",
      },
      provenance: {
        source: "tool",
        actor: "agent",
        runId: "run-a",
        sessionId: "session-a",
      },
    });
  });

  it("fails closed for invocation-user writes without an external user", () => {
    expect(resolve({
      invocation: createToolInvocationContext({
        requestId: "request-a",
        runId: "run-a",
        metadata: {},
        surface: "schedule",
      }),
    }).map((tool) => tool.name)).toEqual(["memory_search"]);
  });

  it("supports explicit agent-wide writes without an external user", async () => {
    const store = new InMemoryMemoryItemStore();
    const tools = resolve({
      store,
      invocation: createToolInvocationContext({
        requestId: "request-a",
        runId: "run-a",
        metadata: {},
        surface: "task",
      }),
      agent: {
        name: "support",
        allowedTools: ["memory_remember"],
        memory: {
          tools: {
            remember: true,
            writeScope: "agent",
            writableKinds: ["procedure_hint"],
          },
        },
      },
    });

    await tools[0]!.execute("call-a", {
      kind: "procedure_hint",
      content: "Validate before publishing.",
    });
    const [item] = await store.list({}, {
      namespace: "project-a",
      access: { projectId: "project-a", agentName: "support" },
      surface: "task",
    });
    expect(item?.scope).toEqual({ kind: "agent", agentName: "support" });
  });
});
