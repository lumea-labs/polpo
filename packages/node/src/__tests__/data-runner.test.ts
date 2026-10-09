import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});
describe("Hosted runner Data capability", () => {
  it("consumes the scoped token before tool code runs and rejects other agents", async () => {
    vi.stubEnv(
      "POLPO_DATA_CAPABILITY",
      Buffer.from(
        JSON.stringify({
          url: "https://gateway.example.test",
          token: "temporary",
          sandboxId: "sandbox-one",
          agentName: "support",
        }),
      ).toString("base64"),
    );
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, data: [] }));
    vi.stubGlobal("fetch", fetcher);
    const { runnerDataClient } = await import("../data/index.js");
    const client = runnerDataClient("project", "support")!;
    expect(process.env.POLPO_DATA_CAPABILITY).toBeUndefined();
    expect(Object.keys(client).sort()).toEqual([
      "describe",
      "execute",
      "list",
      "query",
    ]);
    expect(await client.list()).toEqual([]);
    fetcher.mockResolvedValueOnce(
      Response.json({
        ok: true,
        data: { rows: [{ total: 1 }], rowCount: 1, truncated: false },
      }),
    );
    expect(
      await client.query!("crm", {
        sql: "SELECT count(*) AS total FROM customers",
      }),
    ).toMatchObject({ rows: [{ total: 1 }] });
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({
      operation: "query",
      resource: "crm",
      query: { sql: "SELECT count(*) AS total FROM customers" },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://gateway.example.test/",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer temporary",
          "x-polpo-sandbox-id": "sandbox-one",
        }),
      }),
    );
    expect(() => runnerDataClient("project", "other")).toThrow(
      expect.objectContaining({ code: "data_forbidden" }),
    );
  });
  it("fails closed on malformed bindings and does not expose provider setup", async () => {
    vi.stubEnv("POLPO_DATA_CAPABILITY", "not-json");
    const { runnerDataClient } = await import("../data/index.js");
    expect(() => runnerDataClient("project", "support")).toThrow(
      expect.objectContaining({ code: "data_invalid" }),
    );
    expect(process.env.POLPO_DATA_CAPABILITY).toBeUndefined();
  });
});
