import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ApiClient, ApiResponse } from "../../src/commands/cloud/api.js";
import {
  listProjects,
  getProject,
  createProject,
  waitForProjectActive,
  type CloudProject,
} from "../../src/util/project.js";

function mockClient(): {
  client: ApiClient;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn();
  const post = vi.fn();
  const put = vi.fn();
  const del = vi.fn();
  return {
    get,
    post,
    put,
    del,
    client: { get, post, put, delete: del } as unknown as ApiClient,
  };
}

function ok<T>(data: T, status = 200): ApiResponse<T> {
  return { status, data };
}

describe("listProjects", () => {
  it("returns the array of projects from GET /v1/projects?orgId=...", async () => {
    const { client, get } = mockClient();
    const projects: CloudProject[] = [
      { id: "p1", name: "one" },
      { id: "p2", name: "two" },
    ];
    get.mockResolvedValue(ok(projects));

    const result = await listProjects(client, "org-1");
    expect(result).toEqual(projects);
    expect(get).toHaveBeenCalledWith("/v1/projects?orgId=org-1");
  });

  it("returns empty array when API returns empty array", async () => {
    const { client, get } = mockClient();
    get.mockResolvedValue(ok([]));
    expect(await listProjects(client, "org-1")).toEqual([]);
  });

  it("returns [] when API returns a non-array (graceful)", async () => {
    const { client, get } = mockClient();
    get.mockResolvedValue(ok({ error: "something" } as unknown as CloudProject[]));
    expect(await listProjects(client, "org-1")).toEqual([]);
  });

  it("returns [] when API returns null", async () => {
    const { client, get } = mockClient();
    get.mockResolvedValue(ok(null as unknown as CloudProject[]));
    expect(await listProjects(client, "org-1")).toEqual([]);
  });

  it("propagates network errors", async () => {
    const { client, get } = mockClient();
    get.mockRejectedValue(new Error("boom"));
    await expect(listProjects(client, "org-1")).rejects.toThrow("boom");
  });
});

describe("getProject", () => {
  it("returns the project when found", async () => {
    const { client, get } = mockClient();
    get.mockResolvedValue(ok({ id: "p1", name: "one" } as CloudProject));
    const p = await getProject(client, "p1");
    expect(p).toEqual({ id: "p1", name: "one" });
    expect(get).toHaveBeenCalledWith("/v1/projects/p1");
  });

  it("returns null on 404", async () => {
    const { client, get } = mockClient();
    get.mockResolvedValue({ status: 404, data: { error: "not found" } });
    expect(await getProject(client, "missing")).toBeNull();
  });

  it("returns null when data is null", async () => {
    const { client, get } = mockClient();
    get.mockResolvedValue({ status: 200, data: null });
    expect(await getProject(client, "p1")).toBeNull();
  });
});

describe("createProject", () => {
  it("POSTs to /v1/projects with name + slug + orgId", async () => {
    const { client, post } = mockClient();
    post.mockResolvedValue(ok({ id: "p1", name: "demo", slug: "demo" } as CloudProject));
    await createProject(client, { name: "demo", orgId: "org-1" });
    expect(post).toHaveBeenCalledWith("/v1/projects", {
      name: "demo",
      slug: "demo",
      orgId: "org-1",
    });
  });

  it("auto-derives slug from name", async () => {
    const { client, post } = mockClient();
    post.mockResolvedValue(ok({ id: "p1", name: "My Cool Project" } as CloudProject));
    await createProject(client, { name: "My Cool Project", orgId: "org-1" });
    expect(post).toHaveBeenCalledWith(
      "/v1/projects",
      expect.objectContaining({ slug: "my-cool-project" }),
    );
  });

  it("respects a provided slug", async () => {
    const { client, post } = mockClient();
    post.mockResolvedValue(ok({ id: "p1", name: "demo" } as CloudProject));
    await createProject(client, { name: "demo", orgId: "org-1", slug: "custom-slug" });
    expect(post).toHaveBeenCalledWith(
      "/v1/projects",
      expect.objectContaining({ slug: "custom-slug" }),
    );
  });

  it("returns the created project on success", async () => {
    const { client, post } = mockClient();
    const created: CloudProject = { id: "p1", name: "demo" };
    post.mockResolvedValue(ok(created));
    expect(await createProject(client, { name: "demo", orgId: "o" })).toEqual(created);
  });

  it("throws when the response lacks id, using the error field for the message", async () => {
    const { client, post } = mockClient();
    post.mockResolvedValue({
      status: 400,
      data: { error: "Name already taken" } as unknown as CloudProject,
    });
    await expect(
      createProject(client, { name: "demo", orgId: "o" }),
    ).rejects.toThrow(/Name already taken/);
  });

  it("throws with HTTP status when no error field is present", async () => {
    const { client, post } = mockClient();
    post.mockResolvedValue({
      status: 500,
      data: {} as unknown as CloudProject,
    });
    await expect(
      createProject(client, { name: "demo", orgId: "o" }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("waitForProjectActive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when project is already active", async () => {
    const { client, get } = mockClient();
    get.mockResolvedValue(ok({ id: "p1", name: "demo", status: "active" } as CloudProject));

    const promise = waitForProjectActive(client, "p1", 10_000);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe("active");
  });

  it("polls until project becomes active", async () => {
    const { client, get } = mockClient();
    get
      .mockResolvedValueOnce(ok({ id: "p1", name: "demo", status: "provisioning" } as CloudProject))
      .mockResolvedValueOnce(ok({ id: "p1", name: "demo", status: "provisioning" } as CloudProject))
      .mockResolvedValueOnce(ok({ id: "p1", name: "demo", status: "active" } as CloudProject));

    const promise = waitForProjectActive(client, "p1", 60_000);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe("active");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("throws a friendly timeout error when deadline elapses", async () => {
    const { client, get } = mockClient();
    get.mockResolvedValue(ok({ id: "p1", name: "demo", status: "provisioning" } as CloudProject));

    const promise = waitForProjectActive(client, "p1", 5_000);
    // Attach a noop catch so that timer-driven rejections are not flagged as
    // unhandled before the expect() assertion runs.
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow(/timed out/i);
  });

  it("throws timeout error when getProject returns null forever", async () => {
    const { client, get } = mockClient();
    get.mockResolvedValue({ status: 404, data: null });

    const promise = waitForProjectActive(client, "missing", 5_000);
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow(/timed out/i);
  });
});
