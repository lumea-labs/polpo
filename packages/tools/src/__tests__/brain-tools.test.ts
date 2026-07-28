import { describe, expect, it, vi } from "vitest";
import type {
  BrainReadService,
  BrainServiceContext,
} from "@polpo-ai/core/brain";
import {
  ALL_BRAIN_TOOL_NAMES,
  TOOL_CATALOG,
  createAllTools,
  createBrainTools,
  NodeFileSystem,
  NodeShell,
} from "../index.js";

const projectA = { kind: "project", subjectId: "project-a" } as const;
const projectB = { kind: "project", subjectId: "project-b" } as const;
const context: BrainServiceContext = {
  actor: {
    actor: "agent",
    actorId: "support",
    agentName: "support",
    projectId: "project-a",
  },
  readScopes: [projectA],
  writeScopes: [],
};

function reader(): BrainReadService {
  const search: BrainReadService["search"] = vi.fn(async (_context, request) => [{
    scope: projectA,
    chunk: {
      id: "chunk-1",
      sourceId: "source-1",
      version: "v1",
      index: 0,
      content: `Found ${request.query}`,
      citation: {
        sourceId: "source-1",
        version: "v1",
        chunkId: "chunk-1",
        label: "Runbook",
      },
      metadata: {},
    },
    score: 0.9,
    scores: { keyword: 0.9 },
    trust: "user_provided" as const,
  }]);
  const readSource: BrainReadService["readSource"] = vi.fn(async (_context, request) => ({
    source: {
      id: request.ref.sourceId,
      scope: request.ref.scope,
      type: "paste" as const,
      label: "Runbook",
      status: "indexed" as const,
      trust: "user_provided" as const,
      currentVersion: "v1",
      metadata: {},
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:01.000Z",
    },
    version: {
      sourceId: request.ref.sourceId,
      version: request.version ?? "v1",
      status: "indexed" as const,
      metadata: {},
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:01.000Z",
      indexedAt: "2026-07-28T12:00:01.000Z",
    },
    chunks: [{
      id: "chunk-1",
      sourceId: request.ref.sourceId,
      version: request.version ?? "v1",
      index: 0,
      content: "Readable source content.",
      citation: {
        sourceId: request.ref.sourceId,
        version: request.version ?? "v1",
        chunkId: "chunk-1",
        label: "Runbook",
      },
      metadata: {},
    }],
  }));
  return {
    search,
    readSource,
  };
}

describe("createBrainTools", () => {
  it("publishes only the two read-only Brain tools in the public catalog", () => {
    expect([...ALL_BRAIN_TOOL_NAMES]).toEqual(["brain_search", "source_read"]);
    expect(TOOL_CATALOG).toEqual(
      expect.arrayContaining([...ALL_BRAIN_TOOL_NAMES]),
    );
  });

  it("searches only through the host-injected context and preserves citations", async () => {
    const service = reader();
    const tool = createBrainTools(service, context).find(
      (candidate) => candidate.name === "brain_search",
    )!;

    const result = await tool.execute("call-1", {
      query: "refund policy",
      limit: 3,
      token_budget: 500,
    });

    expect(service.search).toHaveBeenCalledWith(context, {
      query: "refund policy",
      limit: 3,
      tokenBudget: 500,
    });
    expect(result.content[0].type).toBe("text");
    const payload = JSON.parse(
      result.content[0].type === "text" ? result.content[0].text : "",
    );
    expect(payload.results[0]).toMatchObject({
      source: {
        id: "source-1",
        scope: projectA,
      },
      citation: {
        sourceId: "source-1",
        version: "v1",
        chunkId: "chunk-1",
      },
    });
  });

  it("reads the sole granted scope without exposing a scope parameter", async () => {
    const service = reader();
    const tool = createBrainTools(service, context).find(
      (candidate) => candidate.name === "source_read",
    )!;

    const result = await tool.execute("call-1", {
      source_id: "source-1",
      version: "v1",
    });

    expect(service.readSource).toHaveBeenCalledWith(context, {
      ref: { scope: projectA, sourceId: "source-1" },
      version: "v1",
    });
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(
      result.content[0].type === "text" ? result.content[0].text : "",
    )).toMatchObject({
      source: { id: "source-1", scope: projectA },
      chunks: [{ content: "Readable source content." }],
    });
  });

  it("requires an exact granted scope when more than one scope is available", async () => {
    const service = reader();
    const multiScope = {
      ...context,
      readScopes: [projectA, projectB],
    };
    const tool = createBrainTools(service, multiScope).find(
      (candidate) => candidate.name === "source_read",
    )!;

    await expect(tool.execute("call-1", {
      source_id: "source-1",
    })).rejects.toThrow(/scope/i);
    await expect(tool.execute("call-2", {
      source_id: "source-1",
      scope_kind: "project",
      scope_id: "project-b",
    })).resolves.toBeDefined();
    expect(service.readSource).toHaveBeenLastCalledWith(multiScope, {
      ref: { scope: projectB, sourceId: "source-1" },
    });
  });

  it("rejects a model-supplied scope outside the host grant", async () => {
    const service = reader();
    const tool = createBrainTools(service, context).find(
      (candidate) => candidate.name === "source_read",
    )!;

    await expect(tool.execute("call-1", {
      source_id: "source-1",
      scope_kind: "project",
      scope_id: "project-b",
    })).rejects.toThrow(/not granted/i);
    expect(service.readSource).not.toHaveBeenCalled();
  });

  it("supports allowlist filtering without making Brain tools implicit", () => {
    const service = reader();

    expect(createBrainTools(service, context, ["brain_search"]).map(
      (tool) => tool.name,
    )).toEqual(["brain_search"]);
    expect(createBrainTools(service, context, ["read"]).map(
      (tool) => tool.name,
    )).toEqual([]);
  });

  it("joins the shared task tool resolver only when explicitly allowed", async () => {
    const service = reader();
    const options = {
      cwd: process.cwd(),
      allowedTools: ["brain_search"],
      fs: new NodeFileSystem(),
      shell: new NodeShell(),
    };

    await expect(createAllTools({
      ...options,
      brainService: service,
      brainContext: context,
    }).then((tools) => tools.map((tool) => tool.name))).resolves.toEqual([
      "brain_search",
    ]);
    await expect(createAllTools(options).then(
      (tools) => tools.map((tool) => tool.name),
    )).resolves.toEqual([]);
  });
});
