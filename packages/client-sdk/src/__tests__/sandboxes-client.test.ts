import { describe, expect, it, vi } from "vitest";
import type {
  SandboxInventoryPage,
  SandboxManagementCapabilities,
  SandboxMutationResult,
  SandboxSummary,
} from "@polpo-ai/core";
import { PolpoClient } from "../client/polpo-client.js";
import { PolpoApiError } from "../client/errors.js";

const capabilities: SandboxManagementCapabilities = {
  inventory: true,
  detail: true,
  actions: {
    start: { allowed: true },
    stop: { allowed: true },
    destroy: { allowed: true },
    clearIdle: { allowed: true },
  },
};

const sandbox: SandboxSummary = {
  id: "sandbox / 1",
  operationalState: "stopped",
  allocationState: "idle",
  health: "healthy",
  workspace: { mode: "local", volumeCount: 0 },
  lifecycle: {},
  holderCount: 0,
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T10:00:00.000Z",
  actions: {
    start: { allowed: true },
    stop: { allowed: false },
    destroy: { allowed: true },
  },
};

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("PolpoClient sandbox management", () => {
  it("lists project sandboxes with encoded bounded filters", async () => {
    const page: SandboxInventoryPage = {
      items: [sandbox],
      nextCursor: "next",
      summary: {
        total: 1,
        operational: { stopped: 1 },
        allocation: { idle: 1 },
      },
      observedAt: "2026-08-16T10:01:00.000Z",
      sources: {
        provider: "available",
        coordination: "available",
        enrichment: "available",
      },
      capabilities,
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(ok(page));
    const client = new PolpoClient({
      baseUrl: "https://api.example.test",
      fetch,
    });

    await expect(client.listSandboxes("project / 1", {
      operationalStates: ["running", "stopped"],
      allocationStates: ["idle"],
      workspaceModes: ["local"],
      search: "build sandbox",
      limit: 25,
      cursor: "cursor / 1",
    })).resolves.toEqual(page);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/projects/project%20%2F%201/sandboxes"
        + "?operationalState=running%2Cstopped&allocationState=idle"
        + "&workspaceMode=local&search=build+sandbox&limit=25"
        + "&cursor=cursor+%2F+1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("gets capabilities and detail with encoded identifiers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(ok(capabilities))
      .mockResolvedValueOnce(ok(sandbox));
    const client = new PolpoClient({
      baseUrl: "https://api.example.test",
      fetch,
    });

    await expect(
      client.getSandboxManagementCapabilities("project / 1"),
    ).resolves.toEqual(capabilities);
    await expect(
      client.getSandbox("project / 1", "sandbox / 1"),
    ).resolves.toEqual(sandbox);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.test/api/v1/projects/project%20%2F%201/sandboxes/capabilities",
      "https://api.example.test/api/v1/projects/project%20%2F%201/sandboxes/sandbox%20%2F%201",
    ]);
  });

  it("carries operation preconditions across start, stop, destroy and clear idle", async () => {
    const mutation: SandboxMutationResult = {
      sandboxId: sandbox.id,
      operationId: "operation-1",
      outcome: "applied",
      sandbox,
    };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(ok(mutation))
      .mockResolvedValueOnce(ok(mutation))
      .mockResolvedValueOnce(ok(mutation))
      .mockResolvedValueOnce(ok({
        operationId: "operation-4",
        inspected: 1,
        destroyed: 1,
        skipped: 0,
        failed: 0,
        failures: [],
      }));
    const client = new PolpoClient({
      baseUrl: "https://api.example.test",
      fetch,
    });

    await client.startSandbox("project", sandbox.id, {
      operationId: "operation-1",
      expectedState: "stopped",
    });
    await client.stopSandbox("project", sandbox.id, {
      operationId: "operation-2",
      expectedState: "running",
    });
    await client.destroySandbox("project", sandbox.id, {
      operationId: "operation-3",
      expectedState: "stopped",
    });
    await client.clearIdleSandboxes("project", {
      operationId: "operation-4",
      limit: 10,
    });

    expect(fetch.mock.calls.map(([url, init]) => [
      url,
      init?.method,
      init?.body,
      (init?.headers as Record<string, string>)?.["x-polpo-operation-id"],
    ])).toEqual([
      [
        "https://api.example.test/api/v1/projects/project/sandboxes/sandbox%20%2F%201/start",
        "POST",
        JSON.stringify({ operationId: "operation-1", expectedState: "stopped" }),
        undefined,
      ],
      [
        "https://api.example.test/api/v1/projects/project/sandboxes/sandbox%20%2F%201/stop",
        "POST",
        JSON.stringify({ operationId: "operation-2", expectedState: "running" }),
        undefined,
      ],
      [
        "https://api.example.test/api/v1/projects/project/sandboxes/sandbox%20%2F%201"
          + "?expectedState=stopped",
        "DELETE",
        undefined,
        "operation-3",
      ],
      [
        "https://api.example.test/api/v1/projects/project/sandboxes/clear-idle",
        "POST",
        JSON.stringify({ operationId: "operation-4", limit: 10 }),
        undefined,
      ],
    ]);
  });

  it("rejects invalid list limits before issuing a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new PolpoClient({
      baseUrl: "https://api.example.test",
      fetch,
    });

    await expect(client.listSandboxes("project", { limit: 0 }))
      .rejects.toThrow("Sandbox page limit must be an integer from 1 to 100");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies sandbox API errors through existing client helpers", () => {
    expect(new PolpoApiError("missing", "SANDBOX_NOT_FOUND", 404).isNotFound)
      .toBe(true);
    expect(new PolpoApiError("busy", "SANDBOX_BUSY", 409).isConflict)
      .toBe(true);
    expect(new PolpoApiError("forbidden", "SANDBOX_FORBIDDEN", 403).isAuthError)
      .toBe(true);
    expect(
      new PolpoApiError("invalid", "SANDBOX_INVALID_REQUEST", 400)
        .isValidationError,
    ).toBe(true);
  });
});
