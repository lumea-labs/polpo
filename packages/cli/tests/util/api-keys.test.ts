import { describe, it, expect, vi } from "vitest";
import type { ApiClient, ApiResponse } from "../../src/commands/cloud/api.js";
import {
  createApiKey,
  createProjectApiKey,
  type CreatedApiKey,
} from "../../src/util/api-keys.js";

function mockClient(post: ReturnType<typeof vi.fn>): ApiClient {
  return {
    get: vi.fn(),
    post,
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient;
}

function ok<T>(data: T, status = 200): ApiResponse<T> {
  return { status, data };
}

const FAKE_KEY: CreatedApiKey = {
  id: "key-1",
  name: "test",
  keyPrefix: "sk_live_abc",
  scopes: [{ type: "project", projectId: "proj-1" }],
  rawKey: "sk_live_abc_xyz_raw",
  environment: "live",
  createdAt: "2026-04-15T00:00:00.000Z",
};

describe("createApiKey", () => {
  it("POSTs /v1/api-keys with orgId, name, scopes, environment", async () => {
    const post = vi.fn().mockResolvedValue(ok(FAKE_KEY, 201));
    await createApiKey(mockClient(post), {
      orgId: "org-1",
      name: "CI key",
      scopes: [{ type: "project", projectId: "proj-1" }],
    });
    expect(post).toHaveBeenCalledWith("/v1/api-keys", {
      orgId: "org-1",
      name: "CI key",
      scopes: [{ type: "project", projectId: "proj-1" }],
      environment: "live",
    });
  });

  it("defaults environment to 'live' when omitted", async () => {
    const post = vi.fn().mockResolvedValue(ok(FAKE_KEY));
    await createApiKey(mockClient(post), {
      orgId: "org-1",
      name: "CI",
      scopes: [{ type: "platform" }],
    });
    expect(post.mock.calls[0][1]).toMatchObject({ environment: "live" });
  });

  it("honors environment='test' override", async () => {
    const post = vi.fn().mockResolvedValue(ok(FAKE_KEY));
    await createApiKey(mockClient(post), {
      orgId: "org-1",
      name: "CI",
      scopes: [{ type: "platform" }],
      environment: "test",
    });
    expect(post.mock.calls[0][1]).toMatchObject({ environment: "test" });
  });

  it("returns the full CreatedApiKey including rawKey", async () => {
    const post = vi.fn().mockResolvedValue(ok(FAKE_KEY, 201));
    const result = await createApiKey(mockClient(post), {
      orgId: "org-1",
      name: "k",
      scopes: [{ type: "platform" }],
    });
    expect(result).toEqual(FAKE_KEY);
    expect(result.rawKey).toBe("sk_live_abc_xyz_raw");
  });

  it("throws when rawKey is missing from the response, surfacing server error field", async () => {
    const post = vi.fn().mockResolvedValue({
      status: 400,
      data: { error: "Rate limited" } as unknown as CreatedApiKey,
    });
    await expect(
      createApiKey(mockClient(post), {
        orgId: "org-1",
        name: "k",
        scopes: [{ type: "platform" }],
      }),
    ).rejects.toThrow(/Rate limited/);
  });

  it("throws with HTTP status when no error field is present", async () => {
    const post = vi.fn().mockResolvedValue({
      status: 502,
      data: {} as unknown as CreatedApiKey,
    });
    await expect(
      createApiKey(mockClient(post), {
        orgId: "org-1",
        name: "k",
        scopes: [{ type: "platform" }],
      }),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("propagates network errors", async () => {
    const post = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(
      createApiKey(mockClient(post), {
        orgId: "org-1",
        name: "k",
        scopes: [{ type: "platform" }],
      }),
    ).rejects.toThrow("ETIMEDOUT");
  });
});

describe("createProjectApiKey", () => {
  it("wraps createApiKey with a project-scoped key + default name", async () => {
    const post = vi.fn().mockResolvedValue(ok(FAKE_KEY, 201));
    await createProjectApiKey(mockClient(post), "org-1", "proj-1");
    expect(post).toHaveBeenCalledWith("/v1/api-keys", {
      orgId: "org-1",
      name: "CLI generated",
      scopes: [{ type: "project", projectId: "proj-1" }],
      environment: "live",
    });
  });

  it("honors a custom name", async () => {
    const post = vi.fn().mockResolvedValue(ok(FAKE_KEY, 201));
    await createProjectApiKey(
      mockClient(post),
      "org-1",
      "proj-1",
      "Created by polpo create",
    );
    expect(post.mock.calls[0][1]).toMatchObject({
      name: "Created by polpo create",
    });
  });

  it("returns the full CreatedApiKey from the server", async () => {
    const post = vi.fn().mockResolvedValue(ok(FAKE_KEY, 201));
    const result = await createProjectApiKey(mockClient(post), "org-1", "proj-1");
    expect(result.rawKey).toBe("sk_live_abc_xyz_raw");
    expect(result.scopes).toEqual([{ type: "project", projectId: "proj-1" }]);
  });

  it("propagates errors from createApiKey", async () => {
    const post = vi.fn().mockResolvedValue({
      status: 403,
      data: { error: "Forbidden" } as unknown as CreatedApiKey,
    });
    await expect(
      createProjectApiKey(mockClient(post), "org-1", "proj-1"),
    ).rejects.toThrow(/Forbidden/);
  });
});
