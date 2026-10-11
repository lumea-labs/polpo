import { describe, expect, it, vi } from "vitest";
import { createConnectService, MemoryConnectStore, MemoryConnectionSecretStore } from "../index.js";
import { executeGoogleAction, gmailDefinition, GMAIL_READ_SCOPE } from "../../../connectors/src/google.js";

describe("Google actions through the shared Connection runtime", () => {
  it("authorizes, verifies, executes and revokes without handing the action a token", async () => {
    const responses = [
      Response.json({ access_token: "private-google-token", scope: `${GMAIL_READ_SCOPE} openid https://www.googleapis.com/auth/userinfo.email` }),
      Response.json({ sub: "google-subject-1", email: "fixture@example.com" }),
      Response.json({ emailAddress: "fixture@example.com" }),
      Response.json({ messages: [{ id: "message1", threadId: "thread1" }] }),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!);
    const client = { id: "instance-google", providerId: "gmail", clientId: "fixture-app", clientSecret: "fixture-app-secret",
      redirectUris: ["https://host.example.com/callback"], owner: { type: "instance" as const, id: "self-hosted" } };
    const store = new MemoryConnectStore();
    const service = createConnectService({
      providers: [gmailDefinition], store, secrets: new MemoryConnectionSecretStore(), fetch,
      resolveHostname: async () => ["8.8.8.8"], oauthClients: { resolve: async () => client, resolveById: async () => client },
    });
    const start = await service.startOAuth({ providerId: "gmail", oauthClientMode: "instance", redirectUri: client.redirectUris[0] });
    const connection = await service.completeOAuth({ state: start.state, code: "fixture-code" });
    expect(connection.oauthIdentity).toMatchObject({ issuer: "https://accounts.google.com", subject: "google-subject-1" });
    expect(connection.grantedScopes).toEqual([GMAIL_READ_SCOPE, "openid", "email"].sort());
    expect(await service.verifyConnection({ connectionId: connection.id })).toMatchObject({ outcome: "passed", account: { id: "fixture@example.com" } });
    expect((await store.getConnection(connection.id))?.oauthIdentity).toEqual(connection.oauthIdentity);
    const request = vi.fn((input) => service.request({ ...input, connectionId: connection.id }));
    expect(await executeGoogleAction("gmail_search_messages", { query: "is:unread" }, { request }))
      .toEqual({ messages: [{ id: "message1", threadId: "thread1" }] });
    expect(JSON.stringify(request.mock.calls)).not.toContain("private-google-token");
    expect(new Headers(fetch.mock.calls[3][1]?.headers).get("authorization")).toBe("Bearer private-google-token");
    await service.revokeConnection({ connectionId: connection.id });
    await expect(executeGoogleAction("gmail_search_messages", {}, { request })).rejects.toMatchObject({ code: "connection_revoked" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
