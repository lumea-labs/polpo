import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "@polpo-ai/connect-server";
import { createApp, isPublicApiPath } from "../server/app.js";

const KEY = "selfhost-test-key";
const authHeaders = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "polpo-auth-gate-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function buildApp(apiKeys?: string[]) {
  const connectService = createConnectService({ providers: [], store: new MemoryConnectStore(), secrets: new MemoryConnectionSecretStore() });
  return createApp({ isInitialized: false } as never, {} as never, { apiKeys, workDir, connectService });
}

function json(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): RequestInit {
  return { method: "POST", headers, body: JSON.stringify(body) };
}

describe("self-hosted server — setup routes require the API key when keys are configured", () => {
  it("rejects unauthenticated filesystem writes and does not touch the disk", async () => {
    const app = buildApp([KEY]);
    const target = join(workDir, "created-by-anonymous");

    const res = await app.request("/api/v1/filesystem/mkdir", json({ path: target }));
    expect(res.status).toBe(401);
    expect(existsSync(target)).toBe(false);

    const rename = await app.request("/api/v1/filesystem/rename", json({ path: workDir, newName: "renamed" }));
    expect(rename.status).toBe(401);
    expect((await app.request(`/api/v1/filesystem/browse?path=${encodeURIComponent(workDir)}`)).status).toBe(401);
  });

  it("rejects unauthenticated provider configuration and setup initialization", async () => {
    const app = buildApp([KEY]);
    expect((await app.request("/api/v1/providers")).status).toBe(401);
    expect((await app.request("/api/v1/providers/openai/api-key", json({ apiKey: "sk-attacker" }))).status).toBe(401);
    expect((await app.request("/api/v1/providers/openai/api-key", { method: "DELETE" })).status).toBe(401);
    expect((await app.request("/api/v1/config/status")).status).toBe(401);
    expect((await app.request("/api/v1/config/initialize", json({ workDir: join(workDir, "evil") }))).status).toBe(401);
    expect(existsSync(join(workDir, "evil"))).toBe(false);
  });

  it("still serves the same routes with a valid key (Bearer or X-API-Key)", async () => {
    const app = buildApp([KEY]);
    const target = join(workDir, "created-by-operator");
    const res = await app.request("/api/v1/filesystem/mkdir", json({ path: target }, authHeaders));
    expect(res.status).toBe(200);
    expect(existsSync(target)).toBe(true);

    const status = await app.request("/api/v1/config/status", { headers: { "x-api-key": KEY } });
    expect(status.status).toBe(200);
    expect((await app.request("/api/v1/filesystem/browse", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("keeps health and the OAuth callback public", async () => {
    const app = buildApp([KEY]);
    expect((await app.request("/api/v1/health")).status).toBe(200);
    expect((await app.request("/api/v1/openapi.json")).status).toBe(401);
    // The callback is reachable (it fails on the missing state, not on auth).
    expect((await app.request("/api/v1/connect/oauth/callback")).status).not.toBe(401);
  });

  it("denies every /api route that is not explicitly public (route-table audit)", async () => {
    const app = buildApp([KEY]);
    const routes = new Map<string, { method: string; path: string }>();
    for (const route of app.routes) {
      if (!route.path.startsWith("/api/") || route.path.endsWith("*")) continue;
      const method = route.method === "ALL" ? "GET" : route.method;
      const path = route.path.replace(/:[^/]+/g, "x");
      routes.set(`${method} ${path}`, { method, path });
    }
    expect(routes.size).toBeGreaterThan(50);

    const leaked: string[] = [];
    let client = 0;
    for (const { method, path } of routes.values()) {
      if (isPublicApiPath(method, path, { connectCallbackEnabled: true })) continue;
      // Distinct client addresses so the per-IP rate limiter does not answer first.
      const headers: Record<string, string> = { "x-forwarded-for": `client-${client++}` };
      const init: RequestInit = { method, headers };
      if (!["GET", "HEAD"].includes(method)) {
        headers["content-type"] = "application/json";
        init.body = "{}";
      }
      const res = await app.request(path, init);
      if (res.status !== 401) leaked.push(`${method} ${path} -> ${res.status}`);
    }
    expect(leaked).toEqual([]);
  });

  it("leaves local dev mode (no keys configured) unauthenticated", async () => {
    const app = buildApp(undefined);
    const target = join(workDir, "dev-mode");
    expect((await app.request("/api/v1/filesystem/mkdir", json({ path: target }))).status).toBe(200);
    expect(existsSync(target)).toBe(true);
  });
});

describe("isPublicApiPath", () => {
  it("only allows read-only access to the explicit allowlist", () => {
    const opts = { connectCallbackEnabled: false };
    expect(isPublicApiPath("GET", "/api/v1/health", opts)).toBe(true);
    expect(isPublicApiPath("GET", "/api/v1/health/", opts)).toBe(true);
    expect(isPublicApiPath("POST", "/api/v1/health", opts)).toBe(false);
    expect(isPublicApiPath("GET", "/api/v1/openapi.json", opts)).toBe(false);
    expect(isPublicApiPath("GET", "/api/v1/healthz", opts)).toBe(false);
    expect(isPublicApiPath("GET", "/api/v1/connect/oauth/callback", opts)).toBe(false);
    expect(isPublicApiPath("GET", "/api/v1/connect/oauth/callback", { connectCallbackEnabled: true })).toBe(true);
    expect(isPublicApiPath("GET", "/api/v1/filesystem/browse", opts)).toBe(false);
    expect(isPublicApiPath("GET", "/api/v1/providers", opts)).toBe(false);
  });
});
