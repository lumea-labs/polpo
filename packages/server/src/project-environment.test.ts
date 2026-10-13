import { describe, expect, it, vi } from "vitest";
import { routeProjectEnvironment } from "./project-environment.js";

describe("fixed runtime environment", () => {
  it.each(["development", "production"] as const)("unwraps %s without changing body, auth, query or abort", async environment => {
    const controller = new AbortController();
    const request = new Request(`https://local.test/environments/${environment}/api/v1/files/upload?x=1`, {
      method: "POST", body: new Uint8Array([0, 1, 255]),
      headers: { authorization: "Bearer own-key", "content-type": "application/octet-stream" },
      signal: controller.signal,
    });
    const forward = vi.fn(async (inner: Request) => {
      expect(inner.url).toBe("https://local.test/api/v1/files/upload?x=1");
      expect(inner.method).toBe("POST");
      expect(inner.headers.get("authorization")).toBe("Bearer own-key");
      expect(new Uint8Array(await inner.arrayBuffer())).toEqual(new Uint8Array([0, 1, 255]));
      controller.abort();
      expect(inner.signal.aborted).toBe(true);
      return new Response("uploaded", { status: 201 });
    });
    expect((await routeProjectEnvironment(request, environment, forward)).status).toBe(201);
    expect(forward).toHaveBeenCalledOnce();
  });

  it("supports the /api origin prefix used by CLI self-hosted URLs", async () => {
    const forward = vi.fn(async (request: Request) => Response.json({ url: request.url }));
    const response = await routeProjectEnvironment(new Request("http://local/api/environments/development/v1/data"), "development", forward);
    expect(await response.json()).toEqual({ url: "http://local/api/v1/data" });
  });

  it.each([
    ["/environments", "development", 400],
    ["/environments/", "development", 400],
    ["/api/environments", "development", 400],
    ["/environments/production/v1/tasks", "development", 404],
    ["/environments/development/v1/tasks", undefined, 404],
    ["/environments/test/v1/tasks", "development", 400],
    ["/environments/development/environments/production/v1/tasks", "development", 400],
    ["/environments/development/api/environments/development/v1/tasks", "development", 400],
  ] as const)("rejects %s on a runtime bound to %s before dispatch", async (path, environment, status) => {
    const forward = vi.fn();
    expect((await routeProjectEnvironment(new Request(`http://local${path}`, { method: "POST" }), environment, forward)).status).toBe(status);
    expect(forward).not.toHaveBeenCalled();
  });

  it("preserves existing unscoped endpoints and the downstream authorization response", async () => {
    const request = new Request("http://local/api/v1/tasks");
    const forward = vi.fn(async (inner: Request) => {
      expect(inner).toBe(request);
      return new Response("unauthorized", { status: 401 });
    });
    expect((await routeProjectEnvironment(request, "development", forward)).status).toBe(401);
  });

  it("returns the original streaming response without waiting for it to finish", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const result = await routeProjectEnvironment(new Request("http://local/environments/development/v1/runs/run-1/events?after=7"), "development", async () => response);
    expect(result).toBe(response);
    source.enqueue(new TextEncoder().encode("id: 8\ndata: {}\n\n"));
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("id: 8");
    await reader.cancel();
  });
});
