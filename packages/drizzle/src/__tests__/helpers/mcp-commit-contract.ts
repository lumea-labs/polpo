import { expect, it } from "vitest";
import type { ConnectStore, ConnectionRecord, OAuthStateRecord } from "@polpo-ai/connect";

export function mcpCommitContract(harness: () => Promise<{ first: ConnectStore; second: ConnectStore }>) {
  function fixture(suffix: string) {
    const timestamp = new Date().toISOString();
    const connection: ConnectionRecord = { id: `mcp-account-${suffix}`, providerId: "mcp_url", authType: "mcp", status: "active",
      credentialVersion: "generation", secretRef: `mcp-secret-${suffix}`, grantedScopes: ["read"],
      createdAt: timestamp, updatedAt: timestamp, metadata: { auth: "oauth2", url: "https://mcp.example/mcp", transport: "http", oauthClientMode: "dynamic" } };
    const state: OAuthStateRecord = { state: `mcp-state-${suffix}`, providerId: connection.providerId, flowKind: "mcp", status: "pending",
      requestedScopes: ["read"], temporarySecretRef: connection.secretRef, redirectUri: "https://host.example/callback",
      createdAt: timestamp, expiresAt: new Date(Date.parse(timestamp) + 600_000).toISOString(), metadata: { ...connection.metadata, pendingConnectionId: connection.id } };
    return { connection, state, now: timestamp, claimToken: "lease" };
  }
  it("commits exactly one MCP account and receipt across replicas", async () => {
    const { first, second } = await harness();
    const f = fixture("race");
    await first.saveOAuthState(f.state);
    await first.claimOAuthState!(f.state.state, f.claimToken, new Date(Date.parse(f.now) + 60_000).toISOString(), f.now);
    const input = { ...f, state: f.state.state };
    const attempts = await Promise.all([first, second].map(store => store.commitMcpOAuthConnection!(input)));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await second.getConnection(f.connection.id)).toEqual(f.connection);
    expect(await second.getOAuthState!(f.state.state)).toMatchObject({ status: "completed", completedConnectionId: f.connection.id });
  });
  it.each(["expired", "replaced", "scope", "secret", "revoked", "setup"])("rejects MCP activation without partial writes: %s", async reason => {
    const { first, second } = await harness();
    const f = fixture(reason);
    await first.saveOAuthState({ ...f.state, ...(reason === "setup" ? { setupSessionRef: "setup" } : {}) });
    await first.claimOAuthState!(f.state.state, f.claimToken, new Date(Date.parse(f.now) + 60_000).toISOString(), f.now);
    if (reason === "replaced") await second.claimOAuthState!(f.state.state, "new", new Date(Date.parse(f.now) + 180_000).toISOString(), new Date(Date.parse(f.now) + 120_000).toISOString());
    if (reason === "revoked") await second.upsertConnection({ ...f.connection, status: "revoked" });
    const connection = { ...f.connection,
      ...(reason === "scope" ? { grantedScopes: ["admin"] } : {}), ...(reason === "secret" ? { secretRef: "other" } : {}) };
    expect(await first.commitMcpOAuthConnection!({ state: f.state.state, claimToken: f.claimToken, connection,
      now: reason === "expired" ? new Date(Date.parse(f.now) + 60_000).toISOString() : f.now })).toBeNull();
    expect((await first.getOAuthState!(f.state.state))?.status).not.toBe("completed");
    expect((await first.getConnection(f.connection.id))?.status ?? null).toBe(reason === "revoked" ? "revoked" : null);
  });
}
