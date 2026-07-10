import { describe, expect, it, vi } from "vitest";
import type { ConnectorProviderDefinition } from "@polpo-ai/connect";
import { MemoryConnectStore, MemoryConnectionSecretStore, createConnectService } from "@polpo-ai/connect-server";
import { connectRoutes } from "./connect.js";

const apiKeyProvider: ConnectorProviderDefinition = {
  id: "custom_api",
  name: "Custom API",
  auth: { type: "api_key", defaultScopes: ["use"] },
  scopes: [{ id: "use" }],
};

const oauthProvider: ConnectorProviderDefinition = {
  id: "test_oauth",
  name: "Test OAuth",
  auth: {
    type: "oauth2",
    authorizationUrl: "https://auth.example/authorize",
    tokenUrl: "https://auth.example/token",
    clientId: "client_id",
    clientSecret: "client_secret",
    defaultScopes: ["read"],
  },
  scopes: [{ id: "read" }, { id: "write" }],
};

describe("connectRoutes", () => {
  it("returns 501 when connect service is not wired", async () => {
    const app = connectRoutes(() => ({}));
    const res = await app.request("/providers");
    const body = await res.json();

    expect(res.status).toBe(501);
    expect(body).toMatchObject({ ok: false, code: "CONNECT_SERVICE_UNAVAILABLE" });
  });

  it("creates API-key connections without returning secret values and can issue runtime tokens", async () => {
    const harness = createHarness();
    const app = connectRoutes(() => ({ connectService: harness.service }));
    const createRes = await app.request("/connections/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "custom_api",
        apiKey: "sk_test_123",
        scopes: ["use"],
        subject: { type: "agent", id: "support" },
      }),
    });
    const created = await createRes.json();

    expect(createRes.status).toBe(200);
    expect(created.data).toMatchObject({ providerId: "custom_api", status: "active" });
    expect(JSON.stringify(created)).not.toContain("sk_test_123");

    const tokenRes = await app.request(`/connections/${created.data.id}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["use"], subject: { type: "agent", id: "support" } }),
    });
    const token = await tokenRes.json();

    expect(tokenRes.status).toBe(200);
    expect(token.data).toMatchObject({
      accessToken: "sk_test_123",
      tokenType: "ApiKey",
      providerId: "custom_api",
    });
  });

  it("maps connect errors to structured HTTP errors", async () => {
    const app = connectRoutes(() => ({ connectService: createHarness().service }));
    const res = await app.request("/connections/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "custom_api", apiKey: "sk", scopes: ["admin"] }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "invalid_scope" });
  });

  it("supports OAuth start and callback through the HTTP contract", async () => {
    const harness = createHarness({
      fetchImpl: queueFetch([
        jsonResponse(200, {
          access_token: "oauth_access",
          refresh_token: "oauth_refresh",
          expires_in: 3600,
          scope: "read write",
        }),
      ]),
    });
    const app = connectRoutes(() => ({ connectService: harness.service }));
    const startRes = await app.request("/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "test_oauth",
        scopes: ["read", "write"],
        redirectUri: "https://app.example/callback",
      }),
    });
    const started = await startRes.json();

    expect(startRes.status).toBe(200);
    expect(started.data.authorizationUrl).toContain("https://auth.example/authorize");
    expect(started.data.state).toBeTruthy();

    const callbackRes = await app.request("/oauth/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: started.data.state, code: "code_123" }),
    });
    const callback = await callbackRes.json();

    expect(callbackRes.status).toBe(200);
    expect(callback.data).toMatchObject({
      providerId: "test_oauth",
      status: "active",
      grantedScopes: ["read", "write"],
    });
    expect(harness.fetchImpl.calls[0]!.bodyString).toContain("grant_type=authorization_code");
  });

  it("filters listed connections by provider, status, and owner", async () => {
    const harness = createHarness();
    const app = connectRoutes(() => ({ connectService: harness.service }));
    await harness.service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "sk_1",
      scopes: ["use"],
      subject: { type: "agent", id: "support" },
    });
    await harness.service.createApiKeyConnection({
      providerId: "custom_api",
      apiKey: "sk_2",
      scopes: ["use"],
      subject: { type: "agent", id: "sales" },
    });

    const res = await app.request("/connections?providerId=custom_api&status=active&ownerType=agent&ownerId=support");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].owner).toEqual({ type: "agent", id: "support" });
  });
});

function createHarness(input: { fetchImpl?: MockFetch } = {}) {
  const store = new MemoryConnectStore();
  const secrets = new MemoryConnectionSecretStore();
  const fetchImpl = input.fetchImpl ?? queueFetch([]);
  const service = createConnectService({
    providers: [apiKeyProvider, oauthProvider],
    store,
    secrets,
    fetch: fetchImpl,
    now: () => new Date(Date.UTC(2026, 0, 1, 10, 0, 0)),
  });
  return { service, store, secrets, fetchImpl };
}

interface MockFetchCall {
  url: string;
  init: RequestInit;
  bodyString: string;
}

type MockFetch = ReturnType<typeof queueFetch>;

function queueFetch(responses: Response[]) {
  const calls: MockFetchCall[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, bodyString: String(init.body ?? "") });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch call");
    return next;
  });
  return Object.assign(fetchImpl, { calls });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
