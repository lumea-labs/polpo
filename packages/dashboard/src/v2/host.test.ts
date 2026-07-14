import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelfHostedDashboardApi } from "../self-host-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSelfHostedDashboardApi", () => {
  it("maps data-plane requests to the local runtime proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createSelfHostedDashboardApi();

    await api.fetchDataPlane("local", "/v1/agents");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/polpo/agents",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps project custom-tool routes to the runtime tool API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createSelfHostedDashboardApi();

    await api.fetchControlPlane("/v1/projects/local/tools/example");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/polpo/tools/example",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps managed-only routes explicit", async () => {
    const api = createSelfHostedDashboardApi();

    await expect(api.fetchControlPlane("/v1/orgs")).rejects.toThrow(
      "unavailable in self-hosted mode",
    );
  });

  it("returns local project metadata without a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = createSelfHostedDashboardApi();

    await expect(api.fetchControlPlane("/v1/projects/local")).resolves.toEqual({
      slug: "local",
      orgId: "local",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
