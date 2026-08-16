import { describe, expect, it, vi } from "vitest";
import {
  SandboxManagementError,
  type SandboxManagementContext,
  type SandboxManager,
  type SandboxInventoryPage,
  type SandboxMutationContext,
  type SandboxMutationResult,
  type SandboxSummary,
} from "@polpo-ai/core";
import { sandboxManagementRoutes } from "./sandboxes.js";

const summary: SandboxSummary = {
  id: "sandbox-1",
  name: "polpo-project-1",
  operationalState: "running",
  allocationState: "idle",
  health: "healthy",
  workspace: { mode: "local", volumeCount: 0 },
  lifecycle: { autoStopMinutes: 5, autoDeleteMinutes: 30 },
  holderCount: 0,
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T10:05:00.000Z",
  lastActivityAt: "2026-08-16T10:05:00.000Z",
  actions: {
    start: { allowed: false, reason: "already_running" },
    stop: { allowed: true },
    destroy: { allowed: true },
  },
};

const capabilities = {
  inventory: true,
  detail: true,
  actions: {
    start: { allowed: true },
    stop: { allowed: true },
    destroy: { allowed: true },
    clearIdle: { allowed: true },
  },
} as const;

function createManager(overrides: Partial<SandboxManager> = {}): SandboxManager {
  const page: SandboxInventoryPage = {
    items: [summary],
    nextCursor: null,
    summary: {
      total: 1,
      operational: { running: 1 },
      allocation: { idle: 1 },
    },
    observedAt: "2026-08-16T10:06:00.000Z",
    sources: {
      provider: "available",
      coordination: "available",
      enrichment: "available",
    },
    capabilities,
  };
  return {
    capabilities: vi.fn(async () => capabilities),
    list: vi.fn(async () => page),
    get: vi.fn(async (_context, sandboxId) => (
      sandboxId === summary.id ? summary : null
    )),
    start: vi.fn(async (
      context: SandboxMutationContext,
    ): Promise<SandboxMutationResult> => ({
      sandboxId: context.sandboxId,
      operationId: context.operationId,
      outcome: "applied",
      sandbox: {
        ...summary,
        operationalState: "running",
        actions: {
          start: { allowed: false, reason: "already_running" },
          stop: { allowed: true },
          destroy: { allowed: true },
        },
      },
    })),
    stop: vi.fn(async (
      context: SandboxMutationContext,
    ): Promise<SandboxMutationResult> => ({
      sandboxId: context.sandboxId,
      operationId: context.operationId,
      outcome: "applied",
      sandbox: {
        ...summary,
        operationalState: "stopped",
        actions: {
          start: { allowed: true },
          stop: { allowed: false, reason: "already_stopped" },
          destroy: { allowed: true },
        },
      },
    })),
    destroy: vi.fn(async (
      context: SandboxMutationContext,
    ): Promise<SandboxMutationResult> => ({
      sandboxId: context.sandboxId,
      operationId: context.operationId,
      outcome: "applied",
    })),
    clearIdle: vi.fn(async (context) => ({
      operationId: context.operationId,
      inspected: 1,
      destroyed: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    })),
    ...overrides,
  };
}

function context(projectId = "project-1"): SandboxManagementContext {
  return {
    projectId,
    actorId: "user-1",
    requestId: "request-1",
  };
}

function createApp(options: {
  manager?: SandboxManager;
  resolvedProjectId?: string;
} = {}) {
  const resolveContext = vi.fn(async (input: {
    projectId: string;
    permission: "read" | "control";
  }) => context(options.resolvedProjectId ?? input.projectId));
  const app = sandboxManagementRoutes(() => ({
    manager: options.manager,
    resolveContext,
    createOperationId: () => "operation-generated",
  }));
  return { app, resolveContext };
}

describe("sandboxManagementRoutes", () => {
  it("returns explicit unavailable instead of an empty inventory", async () => {
    const { app } = createApp();
    const response = await app.request(
      "http://localhost/projects/project-1/sandboxes",
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "SANDBOX_MANAGEMENT_UNAVAILABLE",
    });
  });

  it("lists a strictly parsed project-scoped page", async () => {
    const manager = createManager();
    const { app, resolveContext } = createApp({ manager });
    const response = await app.request(
      "http://localhost/projects/project-1/sandboxes"
        + "?operationalState=running,stopped&allocationState=idle"
        + "&workspaceMode=local&search=sandbox&limit=20&cursor=next%2Fpage",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { items: [{ id: "sandbox-1" }], nextCursor: null },
    });
    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      permission: "read",
    }));
    expect(manager.list).toHaveBeenCalledWith(
      context(),
      {
        operationalStates: ["running", "stopped"],
        allocationStates: ["idle"],
        workspaceModes: ["local"],
        search: "sandbox",
        limit: 20,
        cursor: "next/page",
      },
    );
  });

  it("rejects unknown query fields before calling the manager", async () => {
    const manager = createManager();
    const { app } = createApp({ manager });
    const response = await app.request(
      "http://localhost/projects/project-1/sandboxes?providerToken=secret",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "SANDBOX_INVALID_REQUEST",
    });
    expect(manager.list).not.toHaveBeenCalled();
  });

  it("rejects duplicated query fields instead of using an ambiguous value", async () => {
    const manager = createManager();
    const { app } = createApp({ manager });
    const response = await app.request(
      "http://localhost/projects/project-1/sandboxes"
        + "?allocationState=idle&allocationState=leased",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "SANDBOX_INVALID_REQUEST",
    });
    expect(manager.list).not.toHaveBeenCalled();
  });

  it("fails closed when the host resolves a different project", async () => {
    const manager = createManager();
    const { app } = createApp({ manager, resolvedProjectId: "project-2" });
    const response = await app.request(
      "http://localhost/projects/project-1/sandboxes",
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "SANDBOX_FORBIDDEN" });
    expect(manager.list).not.toHaveBeenCalled();
  });

  it("returns detail and stable not-found responses", async () => {
    const manager = createManager();
    const { app } = createApp({ manager });

    const found = await app.request(
      "http://localhost/projects/project-1/sandboxes/sandbox-1",
    );
    const missing = await app.request(
      "http://localhost/projects/project-1/sandboxes/missing",
    );

    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ data: { id: "sandbox-1" } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "SANDBOX_NOT_FOUND" });
  });

  it("uses control authorization and preserves caller operation IDs", async () => {
    const manager = createManager();
    const { app, resolveContext } = createApp({ manager });
    const response = await app.request(
      "http://localhost/projects/project-1/sandboxes/sandbox-1/stop",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "operation-client",
          expectedState: "running",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        sandboxId: "sandbox-1",
        operationId: "operation-client",
        outcome: "applied",
      },
    });
    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({
      permission: "control",
    }));
    expect(manager.stop).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      sandboxId: "sandbox-1",
      operationId: "operation-client",
      expectedState: "running",
    }));
  });

  it("generates an operation id for a bodyless action and propagates abort", async () => {
    const manager = createManager();
    const { app } = createApp({ manager });
    const response = await app.request(
      "http://localhost/projects/project-1/sandboxes/sandbox-1/start",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { operationId: "operation-generated" },
    });
    expect(manager.start).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "operation-generated",
      signal: expect.any(AbortSignal),
    }));
  });

  it("rejects unknown or duplicated destroy query preconditions", async () => {
    const manager = createManager();
    const { app } = createApp({ manager });
    const unknown = await app.request(
      "http://localhost/projects/project-1/sandboxes/sandbox-1?force=true",
      { method: "DELETE" },
    );
    const duplicate = await app.request(
      "http://localhost/projects/project-1/sandboxes/sandbox-1"
        + "?expectedState=running&expectedState=stopped",
      { method: "DELETE" },
    );

    expect(unknown.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(manager.destroy).not.toHaveBeenCalled();
  });

  it("maps busy and provider failures without leaking provider exceptions", async () => {
    const busy = createManager({
      destroy: vi.fn(async () => {
        throw new SandboxManagementError(
          "SANDBOX_BUSY",
          "Sandbox is in use",
          { retryable: true },
        );
      }),
    });
    const unavailable = createManager({
      list: vi.fn(async () => {
        throw new Error("secret provider token and internal URL");
      }),
    });

    const busyResponse = await createApp({ manager: busy }).app.request(
      "http://localhost/projects/project-1/sandboxes/sandbox-1",
      { method: "DELETE", headers: { "x-polpo-operation-id": "destroy-1" } },
    );
    const unavailableResponse = await createApp({ manager: unavailable }).app.request(
      "http://localhost/projects/project-1/sandboxes",
    );

    expect(busyResponse.status).toBe(409);
    expect(await busyResponse.json()).toMatchObject({ code: "SANDBOX_BUSY" });
    expect(unavailableResponse.status).toBe(500);
    const body = await unavailableResponse.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: "SANDBOX_INTERNAL_ERROR" });
    expect(JSON.stringify(body)).not.toContain("secret provider token");
  });

  it("rejects malformed adapter output rather than passing it to clients", async () => {
    const manager = createManager({
      list: vi.fn(async () => ({ items: [{ id: "sandbox-1" }] }) as never),
    });
    const response = await createApp({ manager }).app.request(
      "http://localhost/projects/project-1/sandboxes",
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "SANDBOX_INVALID_RESPONSE",
    });
  });

  it("rejects unsafe capabilities for an allocated sandbox", async () => {
    const manager = createManager({
      get: vi.fn(async (): Promise<SandboxSummary> => ({
        ...summary,
        allocationState: "leased",
        holderCount: 1,
        currentRuns: [{ runId: "run-1" }],
        actions: {
          start: { allowed: false },
          stop: { allowed: false },
          destroy: { allowed: true },
        },
      })),
    });
    const response = await createApp({ manager }).app.request(
      "http://localhost/projects/project-1/sandboxes/sandbox-1",
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "SANDBOX_INVALID_RESPONSE",
    });
  });

  it("maps typed provider outages to a retryable stable response", async () => {
    const manager = createManager({
      list: vi.fn(async () => {
        throw new SandboxManagementError(
          "SANDBOX_PROVIDER_UNAVAILABLE",
          "provider raw error should not escape",
          { retryable: true },
        );
      }),
    });
    const response = await createApp({ manager }).app.request(
      "http://localhost/projects/project-1/sandboxes",
    );

    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "SANDBOX_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain("raw error");
  });
});
