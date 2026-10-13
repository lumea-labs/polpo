import { describe, expect, it, vi } from "vitest";
import { PolpoClient, type PolpoClientConfig } from "../client/polpo-client.js";

function transport() {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async input => {
    const url = String(input);
    if (url.includes("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    return Response.json({ ok: true, data: {}, choices: [] });
  });
}

describe("immutable project environment transport", () => {
  it("releases failed reads without an unhandled rejection or a poisoned request cache", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false, code: "NOT_FOUND", error: "Task not found" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { id: "task-a" } }));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", environment: "development", fetch });
    await expect(client.getTask("task-a")).rejects.toMatchObject({ status: 404 });
    await expect(client.getTask("task-a")).resolves.toEqual({ id: "task-a" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["development", "production"] as const)("targets %s on every API surface", async environment => {
    const fetch = transport();
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", apiKey: "test-credential", environment, fetch });
    await client.getAgents();
    await client.createTask({ title: "isolated", description: "isolated", assignTo: "support" });
    await client.listData();
    await client.data("contacts").table("notes").list({ limit: 1 });
    await client.chatCompletions({ messages: [{ role: "user", content: "hi" }] });
    await client.cancelRun("same-run");
    for await (const _event of client.streamRunEvents("same-run", { after: "42" })) { /* empty stream */ }
    await client.readFile("/report.txt", true);
    await client.uploadFile("/", new Blob(["hello"]), "report.txt");
    await client.getHealth();
    expect(fetch).toHaveBeenCalledTimes(10);
    for (const [url] of fetch.mock.calls) {
      expect(String(url)).toMatch(new RegExp(`^https://api\\.polpo\\.sh/environments/${environment}/`));
      expect(String(url)).not.toContain("test-credential");
    }
    const upload = fetch.mock.calls.find(([url]) => String(url).endsWith("/files/upload"))!;
    expect(new Headers(upload[1]?.headers).has("content-type")).toBe(false);
    expect(new Headers(upload[1]?.headers).get("authorization")).toBe("Bearer test-credential");
    expect(new URL(client.getEventsUrl(["task:created"])).pathname)
      .toBe(`/environments/${environment}/v1/events`);
  });

  it("keeps selection on chat start, durable reconnect and cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith("/cancel")) return Response.json({ ok: true });
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream", "x-polpo-run-id": "run-a", "x-session-id": "session-a" },
      });
    });
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", environment: "development", fetch });
    const stream = client.chatCompletionsStream({ messages: [{ role: "user", content: "hi" }] });
    await stream.start();
    expect(stream.runId).toBe("run-a");
    stream.detach();
    stream.resume({ after: "17" });
    await stream.start();
    await stream.cancel();
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.polpo.sh/environments/development/v1/chat/completions",
      "https://api.polpo.sh/environments/development/v1/runs/run-a/events?cursor=17",
      "https://api.polpo.sh/environments/development/v1/runs/run-a/cancel",
    ]);
  });

  it("separates concurrent clients with the same resource IDs and preserves legacy key routing", async () => {
    const fetch = transport();
    const base = { baseUrl: "https://api.polpo.sh", fetch };
    const dev = new PolpoClient({ ...base, environment: "development" });
    const prod = new PolpoClient({ ...base, environment: "production" });
    const legacy = new PolpoClient(base);
    await Promise.all([dev.getAgents(), prod.getAgents(), legacy.getAgents()]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.polpo.sh/environments/development/v1/agents",
      "https://api.polpo.sh/environments/production/v1/agents",
      "https://api.polpo.sh/v1/agents",
    ]);
  });

  it("rejects invalid targets before any request", () => {
    const fetch = transport();
    expect(() => new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch, environment: "test" } as unknown as PolpoClientConfig))
      .toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("binds file preview links to the same proxy and environment", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true, data: {
      type: "image", url: "/api/v1/files/read?path=%2Flogo.png", mimeType: "image/png",
    } }));
    const client = new PolpoClient({ baseUrl: "/api/projects/project-a", apiPrefix: "/api/v1", environment: "development", fetch });
    expect((await client.previewFile("/logo.png")).url)
      .toBe("/api/projects/project-a/environments/development/api/v1/files/read?path=%2Flogo.png");
  });
});
