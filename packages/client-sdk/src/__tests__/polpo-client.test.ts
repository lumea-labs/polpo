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
