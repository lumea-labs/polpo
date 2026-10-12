import { describe, expect, it, vi } from "vitest";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "@polpo-ai/connect-server";
import { connectCallbackRoutes } from "./connect-callback.js";

function harness() {
  const store = new MemoryConnectStore();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ access_token: "private-test-token", scope: "read" }));
  const service = createConnectService({
    providers: [{ id: "example", name: "Example", auth: {
      type: "oauth2", clientId: "client", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", defaultScopes: ["read"],
    }, scopes: [{ id: "read" }] }],
    store, secrets: new MemoryConnectionSecretStore(), fetch, resolveHostname: async () => ["8.8.8.8"],
  });
  return { service, store, fetch, app: connectCallbackRoutes(() => ({ connectService: service })) };
}

describe("public OAuth callback", () => {
  it("completes only a valid stored authorization and never exposes the account or token", async () => {
    const { service, app, store } = harness();
    const start = await service.startOAuth({ providerId: "example", redirectUri: "https://host.example/callback" });
    const callback = `/oauth/callback?state=${start.state}&code=test-code&returnUrl=https://attacker.example`;
    const response = await app.request(callback);
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("Connection complete");
    expect(html).not.toContain("private-test-token");
    expect(html).not.toContain("conn_");
    expect(response.headers.get("location")).toBeNull();
    expect(await store.listConnections()).toHaveLength(1);
    expect((await app.request(callback)).status).toBe(400);
  });

  it("redirects only to the approved destination stored before provider authorization", async () => {
    const { service, app, store } = harness();
    const start = await service.startOAuth({ providerId: "example", redirectUri: "https://host.example/callback" });
    // Emulate an already-validated setup session's immutable OAuth state.
    const state = await store.getOAuthState(start.state);
    await store.saveOAuthState({ ...state!, returnUrl: "https://app.example/connected" });
    const response = await app.request(`/oauth/callback?state=${start.state}&code=test-code&returnUrl=https://attacker.example`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://app.example/connected");
  });

  it("does not reflect provider error descriptions or accept an unknown state", async () => {
    const { service, app, fetch } = harness();
    const start = await service.startOAuth({ providerId: "example", redirectUri: "https://host.example/callback" });
    const response = await app.request(`/oauth/callback?state=${start.state}&error=access_denied&error_description=private-provider-error`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-provider-error");
    expect((await app.request("/oauth/callback?state=unknown&code=test")).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
