import { describe, expect, it, vi } from "vitest";

import { PolpoConnectClient } from "../client/index.js";

describe("PolpoConnectClient", () => {
  it("unwraps server envelopes for setup and gateway requests", async () => {
    const responses = [
      ok({
        id: "connsetup_1",
        providerId: "github",
        oauthClientId: "oauth_1",
        projectId: "project-1",
        audience: "end_user",
        subject: { type: "external_user", namespace: "app", id: "user-1" },
        scopes: ["repo"],
        returnUrl: "https://app.example/settings",
        createdAt: "2026-08-31T00:00:00.000Z",
        expiresAt: "2026-08-31T00:10:00.000Z",
      }),
      ok({ authorizationUrl: "https://github.com/login/oauth/authorize", state: "state-1", expiresAt: "soon" }),
      ok({ status: 200, headers: {}, body: { login: "octocat" } }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });

    await expect(client.createSetupSession({
      providerId: "github",
      projectId: "project-1",
      audience: "end_user",
      subject: { type: "external_user", namespace: "app", id: "user-1" },
      scopes: ["repo"],
      returnUrl: "https://app.example/settings",
      oauthClientMode: "managed",
    })).resolves.toMatchObject({ id: "connsetup_1" });
    await expect(client.startOAuthSetup("connsetup_1")).resolves.toMatchObject({ state: "state-1" });
    await expect(client.gatewayRequest("connection/one", {
      request: { method: "GET", path: "/user" },
    })).resolves.toMatchObject({ status: 200, body: { login: "octocat" } });

    expect(fetchImpl.mock.calls[2]![0]).toBe(
      "https://api.polpo.test/v1/connect/connections/connection%2Fone/request",
    );
  });

  it("keeps compatibility with endpoints that return raw JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ id: "github" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new PolpoConnectClient({ baseUrl: "https://api.polpo.test", fetch: fetchImpl as typeof fetch });
    await expect(client.listProviders()).resolves.toEqual([{ id: "github" }]);
  });
});

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
