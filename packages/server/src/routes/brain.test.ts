import { describe, expect, it, vi } from "vitest";
import {
  BrainIngestionError,
  BrainStoreAuthorizationError,
  BrainStoreConflictError,
  type BrainManagementService,
  type BrainServiceContext,
} from "@polpo-ai/core/brain";
import { brainRoutes } from "./brain.js";

const projectA = { kind: "project", subjectId: "project-a" } as const;
const projectB = { kind: "project", subjectId: "project-b" } as const;
const context: BrainServiceContext = {
  actor: {
    actor: "user",
    actorId: "user-1",
    projectId: "project-a",
  },
  readScopes: [projectA],
  writeScopes: [projectA],
  defaultWriteScope: projectA,
};

const source = {
  id: "source-1",
  scope: projectA,
  type: "paste",
  label: "Runbook",
  status: "indexed",
  trust: "user_provided",
  currentVersion: "v1",
  metadata: {},
  createdAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:01.000Z",
} as const;

const version = {
  sourceId: source.id,
  version: "v1",
  status: "indexed",
  contentType: "text/plain",
  byteSize: 15,
  contentHash: "a".repeat(64),
  metadata: {},
  createdAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:01.000Z",
  indexedAt: "2026-07-28T12:00:01.000Z",
} as const;

function service(): BrainManagementService {
  return {
    listSources: vi.fn(async () => ({ sources: [source] })),
    createSource: vi.fn(async () => source),
    getSource: vi.fn(async () => source),
    updateSource: vi.fn(async () => source),
    deleteSource: vi.fn(async () => undefined),
    reindexSource: vi.fn(async () => source),
    listVersions: vi.fn(async () => [version]),
    search: vi.fn(async () => []),
    readSource: vi.fn(async () => ({
      source,
      version,
      chunks: [{
        id: "chunk-1",
        sourceId: source.id,
        version: version.version,
        index: 0,
        content: "Support policy.",
        citation: {
          sourceId: source.id,
          version: version.version,
          chunkId: "chunk-1",
          label: source.label,
        },
        metadata: {},
      }],
    })),
  };
}

function app(overrides: {
  service?: BrainManagementService;
  context?: BrainServiceContext;
} = {}) {
  const runtime = overrides.service ?? service();
  return {
    runtime,
    app: brainRoutes(async () => ({
      service: runtime,
      context: overrides.context ?? context,
    })),
  };
}

describe("brainRoutes", () => {
  it("lists sources using host scopes and bounded query filters", async () => {
    const runtime = app();
    const response = await runtime.app.request(
      "/sources?status=indexed&type=paste&limit=25",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { sources: [{ id: "source-1" }] },
    });
    expect(runtime.runtime.listSources).toHaveBeenCalledWith(context, {
      statuses: ["indexed"],
      types: ["paste"],
      limit: 25,
    });
  });

  it("creates a source in the default write scope without accepting model context", async () => {
    const runtime = app();
    const response = await runtime.app.request("/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Runbook",
        trust: "user_provided",
        content: { kind: "paste", text: "Support policy." },
      }),
    });

    expect(response.status).toBe(201);
    expect(runtime.runtime.createSource).toHaveBeenCalledWith(context, {
      scope: projectA,
      label: "Runbook",
      trust: "user_provided",
      content: { kind: "paste", text: "Support policy." },
    });
  });

  it("requires an explicit scope when the host grants multiple write scopes", async () => {
    const runtime = app({
      context: {
        ...context,
        readScopes: [projectA, projectB],
        writeScopes: [projectA, projectB],
        defaultWriteScope: undefined,
      },
    });
    const response = await runtime.app.request("/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Runbook",
        trust: "user_provided",
        content: { kind: "paste", text: "Support policy." },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(runtime.runtime.createSource).not.toHaveBeenCalled();
  });

  it("gets, updates, reindexes, and deletes by an exact inferred scope", async () => {
    const runtime = app();

    expect((await runtime.app.request("/sources/source-1")).status).toBe(200);
    expect((await runtime.app.request("/sources/source-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Updated" }),
    })).status).toBe(200);
    expect((await runtime.app.request("/sources/source-1/reindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: { kind: "url", url: "https://example.com/runbook" },
      }),
    })).status).toBe(202);
    expect((await runtime.app.request("/sources/source-1", {
      method: "DELETE",
    })).status).toBe(200);

    const ref = { scope: projectA, sourceId: "source-1" };
    expect(runtime.runtime.getSource).toHaveBeenCalledWith(context, ref);
    expect(runtime.runtime.updateSource).toHaveBeenCalledWith(
      context,
      ref,
      { label: "Updated" },
    );
    expect(runtime.runtime.reindexSource).toHaveBeenCalledWith(
      context,
      ref,
      { content: { kind: "url", url: "https://example.com/runbook" } },
    );
    expect(runtime.runtime.deleteSource).toHaveBeenCalledWith(context, ref);
  });

  it("searches only the scopes resolved by the host", async () => {
    const runtime = app();
    const response = await runtime.app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "refund policy",
        limit: 4,
        tokenBudget: 900,
      }),
    });

    expect(response.status).toBe(200);
    expect(runtime.runtime.search).toHaveBeenCalledWith(context, {
      query: "refund policy",
      limit: 4,
      tokenBudget: 900,
    });
  });

  it("lists versions and reads bounded source chunks in an exact scope", async () => {
    const runtime = app();

    const versions = await runtime.app.request(
      "/sources/source-1/versions",
    );
    const read = await runtime.app.request(
      "/sources/source-1/read?offset=2&limit=4&tokenBudget=900",
    );

    expect(versions.status).toBe(200);
    expect(await versions.json()).toMatchObject({
      ok: true,
      data: [{ version: "v1", status: "indexed" }],
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      ok: true,
      data: {
        source: { id: "source-1" },
        chunks: [{ id: "chunk-1" }],
      },
    });
    const ref = { scope: projectA, sourceId: "source-1" };
    expect(runtime.runtime.listVersions).toHaveBeenCalledWith(context, ref);
    expect(runtime.runtime.readSource).toHaveBeenCalledWith(context, {
      ref,
      offset: 2,
      limit: 4,
      tokenBudget: 900,
    });
  });

  it("validates source inspection bounds before calling the service", async () => {
    const runtime = app();
    const responses = await Promise.all([
      runtime.app.request("/sources/source-1/read?offset=-1"),
      runtime.app.request("/sources/source-1/read?limit=0"),
      runtime.app.request("/sources/source-1/read?limit=101"),
      runtime.app.request("/sources/source-1/read?tokenBudget=0"),
      runtime.app.request("/sources/source-1/read?unexpected=true"),
      runtime.app.request(
        "/sources/source-1/versions?scopeKind=project",
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "Invalid Brain request",
        code: "invalid_request",
      });
    }
    expect(runtime.runtime.readSource).not.toHaveBeenCalled();
    expect(runtime.runtime.listVersions).not.toHaveBeenCalled();
  });

  it("returns 404 without leaking whether an inaccessible source exists", async () => {
    const runtime = service();
    vi.mocked(runtime.getSource).mockResolvedValue(null);
    const routes = app({ service: runtime });
    const response = await routes.app.request("/sources/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Brain source not found",
      code: "not_found",
    });
  });

  it.each([
    [
      new BrainStoreAuthorizationError("internal policy detail"),
      403,
      "forbidden",
    ],
    [
      new BrainIngestionError("internal source detail", "source_not_found"),
      404,
      "not_found",
    ],
    [
      new BrainStoreConflictError("internal version detail"),
      409,
      "conflict",
    ],
  ])("maps domain failures without exposing internals", async (
    error,
    status,
    code,
  ) => {
    const runtime = service();
    vi.mocked(runtime.createSource).mockRejectedValue(error);
    const routes = app({ service: runtime });
    const response = await routes.app.request("/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Runbook",
        trust: "user_provided",
        content: { kind: "paste", text: "Support policy." },
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(status);
    expect(payload).toMatchObject({ ok: false, code });
    expect(JSON.stringify(payload)).not.toContain("internal");
  });

  it("rejects malformed content, unknown fields, and invalid bounds", async () => {
    const runtime = app();
    const requests = [
      runtime.app.request("/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Runbook",
          trust: "future",
          content: { kind: "paste", text: "content" },
        }),
      }),
      runtime.app.request("/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Runbook",
          trust: "trusted",
          content: { kind: "paste", text: "content", secret: "no" },
        }),
      }),
      runtime.app.request("/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "x", limit: 0 }),
      }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "Invalid Brain request",
        code: "invalid_request",
      });
    }
    expect(runtime.runtime.createSource).not.toHaveBeenCalled();
    expect(runtime.runtime.search).not.toHaveBeenCalled();
  });
});
