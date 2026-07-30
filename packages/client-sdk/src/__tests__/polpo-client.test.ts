import { describe, expect, it, vi } from "vitest";
import { PolpoClient } from "../client/polpo-client.js";

describe("PolpoClient approvals", () => {
  it("lists pending approvals through the status filter supported by the server", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, data: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const client = new PolpoClient({
      baseUrl: "http://localhost:3890",
      apiKey: "test-key",
      fetch,
    });

    await client.getPendingApprovals();

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3890/api/v1/approvals?status=pending",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });
});

describe("PolpoClient schedules v2", () => {
  function clientWith(responseData: unknown = {}) {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () => new Response(
        JSON.stringify({ ok: true, data: responseData }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new PolpoClient({
      baseUrl: "http://localhost:3890",
      apiKey: "test-key",
      fetch,
    });
    return { client, fetch };
  }

  it("lists schedules with bounded typed filters", async () => {
    const { client, fetch } = clientWith([]);

    await client.listSchedules({
      status: "active",
      surface: "agent",
      includeDeleted: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3890/api/v1/schedules?status=active&surface=agent&includeDeleted=true",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends optimistic revisions for mutations", async () => {
    const { client, fetch } = clientWith({ id: "daily" });

    await client.updateScheduleV2(
      "daily",
      { name: "Updated" },
      { expectedRevision: 7 },
    );
    await client.pauseSchedule("daily", { expectedRevision: 8 });
    await client.resumeSchedule("daily", { expectedRevision: 9 });
    await client.deleteScheduleV2("daily", { expectedRevision: 10 });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3890/api/v1/schedules/daily",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "If-Match": "\"7\"" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3890/api/v1/schedules/daily/pause",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "If-Match": "\"8\"" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:3890/api/v1/schedules/daily/resume",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "If-Match": "\"9\"" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "http://localhost:3890/api/v1/schedules/daily",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "If-Match": "\"10\"" }),
      }),
    );
  });

  it("creates manual runs with a caller idempotency key", async () => {
    const { client, fetch } = clientWith({ id: "run-1" });

    await client.triggerSchedule("daily", {
      idempotencyKey: "manual-2026-07-28",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3890/api/v1/schedules/daily/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idempotencyKey: "manual-2026-07-28" }),
      }),
    );
  });

  it("lists run history with deterministic query serialization", async () => {
    const { client, fetch } = clientWith([]);

    await client.listScheduleRuns("daily", {
      status: "failed",
      order: "asc",
      limit: 25,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3890/api/v1/schedules/daily/runs?status=failed&limit=25&order=asc",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects invalid client-side revision and run limits before fetch", async () => {
    const { client, fetch } = clientWith([]);

    await expect(client.pauseSchedule("daily", {
      expectedRevision: 0,
    })).rejects.toThrow(/revision/i);
    await expect(client.listScheduleRuns("daily", {
      limit: 1001,
    })).rejects.toThrow(/limit/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("PolpoClient Brain", () => {
  function setup() {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () => new Response(
        JSON.stringify({ ok: true, data: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new PolpoClient({
      baseUrl: "https://api.polpo.sh",
      apiKey: "test-key",
      fetch,
    });
    return { client, fetch };
  }

  it("encodes list filters and exact scopes", async () => {
    const { client, fetch } = setup();

    await client.listBrainSources({
      scope: { kind: "project", subjectId: "project/a" },
      statuses: ["indexed", "failed"],
      types: ["paste", "url"],
      limit: 25,
      cursor: "next page",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.polpo.sh/v1/brain/sources?scopeKind=project&scopeId=project%2Fa&status=indexed%2Cfailed&type=paste%2Curl&limit=25&cursor=next+page",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses typed request bodies for create, update, reindex, and search", async () => {
    const { client, fetch } = setup();
    const scope = { kind: "project", subjectId: "project-a" } as const;

    await client.createBrainSource({
      scope,
      label: "Runbook",
      trust: "user_provided",
      content: { kind: "paste", text: "Support policy." },
    });
    await client.updateBrainSource(
      "source/1",
      { label: "Updated" },
      scope,
    );
    await client.reindexBrainSource(
      "source/1",
      { content: { kind: "url", url: "https://example.com/runbook" } },
      scope,
    );
    await client.searchBrain({
      query: "refund",
      scopes: [scope],
      limit: 3,
      tokenBudget: 500,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.polpo.sh/v1/brain/sources",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scope,
          label: "Runbook",
          trust: "user_provided",
          content: { kind: "paste", text: "Support policy." },
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/brain/sources/source%2F1?scopeKind=project&scopeId=project-a",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ label: "Updated" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://api.polpo.sh/v1/brain/sources/source%2F1/reindex?scopeKind=project&scopeId=project-a",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: { kind: "url", url: "https://example.com/runbook" },
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "https://api.polpo.sh/v1/brain/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          query: "refund",
          scopes: [scope],
          limit: 3,
          tokenBudget: 500,
        }),
      }),
    );
  });

  it("uses exact source paths for get and delete", async () => {
    const { client, fetch } = setup();

    await client.getBrainSource("source 1");
    await client.deleteBrainSource("source 1", {
      kind: "org",
      subjectId: "org-1",
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.polpo.sh/v1/brain/sources/source%201",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/brain/sources/source%201?scopeKind=org&scopeId=org-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("lists versions and reads bounded chunks using encoded source paths", async () => {
    const { client, fetch } = setup();
    const scope = { kind: "project", subjectId: "project/a" } as const;

    await client.listBrainSourceVersions("source/1", scope);
    await client.readBrainSource("source/1", {
      scope,
      version: "v 2",
      offset: 3,
      limit: 8,
      tokenBudget: 1200,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.polpo.sh/v1/brain/sources/source%2F1/versions?scopeKind=project&scopeId=project%2Fa",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/brain/sources/source%2F1/read?scopeKind=project&scopeId=project%2Fa&version=v+2&offset=3&limit=8&tokenBudget=1200",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects invalid Brain read pagination without making a request", async () => {
    const { client, fetch } = setup();

    expect(() => client.readBrainSource("source-1", {
      offset: -1,
    })).toThrow(/offset/i);
    expect(() => client.readBrainSource("source-1", {
      limit: 101,
    })).toThrow(/limit/i);
    expect(() => client.readBrainSource("source-1", {
      tokenBudget: 0,
    })).toThrow(/tokenBudget/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
