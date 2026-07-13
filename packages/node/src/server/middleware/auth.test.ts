import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "./auth.js";

function appWithKey(key = "test-secret") {
  const app = new Hono();
  app.use("*", authMiddleware([key]));
  app.get("/private", (c) => c.json({ ok: true }));
  return app;
}

describe("authMiddleware", () => {
  it("accepts the SDK-standard bearer token", async () => {
    const response = await appWithKey().request("/private", {
      headers: { authorization: "Bearer test-secret" },
    });
    expect(response.status).toBe(200);
  });

  it("keeps the legacy x-api-key header working", async () => {
    const response = await appWithKey().request("/private", {
      headers: { "x-api-key": "test-secret" },
    });
    expect(response.status).toBe(200);
  });

  it("rejects missing and malformed bearer tokens", async () => {
    const app = appWithKey();
    expect((await app.request("/private")).status).toBe(401);
    expect((await app.request("/private", { headers: { authorization: "Basic test-secret" } })).status).toBe(401);
    expect((await app.request("/private", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("allows local development when no keys are configured", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = new Hono();
    app.use("*", authMiddleware([]));
    app.get("/public", (c) => c.text("ok"));
    expect((await app.request("/public")).status).toBe(200);
    warning.mockRestore();
  });
});
