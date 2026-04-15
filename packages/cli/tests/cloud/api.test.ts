import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApiClient } from "../../src/commands/cloud/api.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeTextResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

describe("createApiClient — URL + headers", () => {
  it("sets Authorization + Content-Type headers from credentials", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ ok: true }));
    const client = createApiClient({ apiKey: "sk_live_abc", baseUrl: "https://api.test" });
    await client.get("/v1/me");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk_live_abc",
      "Content-Type": "application/json",
    });
  });

  it("adds x-project-id header only when projectId is passed", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ ok: true }));
    const client = createApiClient(
      { apiKey: "sk", baseUrl: "https://api.test" },
      "proj-123",
    );
    await client.get("/v1/projects/proj-123");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({ "x-project-id": "proj-123" });
  });

  it("omits x-project-id when no projectId passed", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ ok: true }));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    await client.get("/v1/me");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).not.toHaveProperty("x-project-id");
  });

  it("concatenates baseUrl and path correctly", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ ok: true }));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    await client.get("/v1/projects");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.test/v1/projects");
  });

  it("strips a trailing slash from baseUrl", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ ok: true }));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test/" });
    await client.get("/v1/projects");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.test/v1/projects");
  });
});

describe("HTTP methods", () => {
  it("GET: no body, method='GET'", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ hello: "world" }));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    const res = await client.get("/v1/me");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ hello: "world" });
  });

  it("POST: JSON-stringified body", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ id: "proj-1" }, 201));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    const res = await client.post("/v1/projects", { name: "demo" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "demo" }));
    expect(res.status).toBe(201);
  });

  it("POST with no body sends undefined body", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ ok: true }));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    await client.post("/v1/ping");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it("PUT: method='PUT'", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ ok: true }));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    await client.put("/v1/me", { name: "Alessio" });
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
  });

  it("DELETE: method='DELETE'", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ ok: true }));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    await client.delete("/v1/api-keys/k1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});

describe("response parsing", () => {
  it("returns parsed JSON when content-type is application/json", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ id: "x" }));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    const res = await client.get("/v1/me");
    expect(res.data).toEqual({ id: "x" });
  });

  it("returns raw text when content-type is not JSON", async () => {
    fetchMock.mockResolvedValue(makeTextResponse("plain body"));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    const res = await client.get("/v1/raw");
    expect(res.data).toBe("plain body");
  });

  it("returns text when server omits content-type header", async () => {
    fetchMock.mockResolvedValue(new Response("hello", { status: 200 }));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    const res = await client.get("/v1/raw");
    expect(res.data).toBe("hello");
  });

  it("preserves non-2xx status codes", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    const res = await client.get("/v1/nope");
    expect(res.status).toBe(404);
    expect(res.data).toEqual({ error: "not found" });
  });

  it("preserves 500 status + body on server errors", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    const res = await client.get("/v1/err");
    expect(res.status).toBe(500);
  });
});

describe("network failure propagation", () => {
  it("propagates fetch rejection", async () => {
    fetchMock.mockRejectedValue(new TypeError("ECONNREFUSED"));
    const client = createApiClient({ apiKey: "sk", baseUrl: "https://api.test" });
    await expect(client.get("/v1/me")).rejects.toThrow("ECONNREFUSED");
  });
});
