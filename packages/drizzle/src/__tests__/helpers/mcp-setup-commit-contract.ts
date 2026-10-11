import { expect, it } from "vitest";
import type { ConnectStore, ConnectionLinkStore, ConnectionSetupSessionStore, ConnectionSetupSession, ConnectionRecord, OAuthStateRecord } from "@polpo-ai/connect";
type Stores = ConnectStore & ConnectionLinkStore & ConnectionSetupSessionStore;
export function mcpSetupFixture(suffix: string) {
  const now = new Date().toISOString(), deadline = new Date(Date.now() + 60_000).toISOString();
  const setup: ConnectionSetupSession = { id: `mcp-setup-${suffix}`, flowKind: "mcp", status: "started", consumedAt: now,
    authorizationExpiresAt: deadline, providerId: "mcp_url", oauthClientId: "config", oauthClientFingerprint: "pin", projectId: "project", orgId: "org",
    audience: "end_user", subject: { type: "external_user", namespace: "app", id: "gioia" }, binding: { scopeEpoch: "epoch" }, scopes: ["read"],
    returnUrl: "https://app.example/connected", createdAt: now, expiresAt: deadline };
  const connection: ConnectionRecord = { id: `embedded-account-${suffix}`, providerId: "mcp_url", oauthClientId: "config", oauthClientFingerprint: "pin",
    authType: "mcp", status: "active", credentialVersion: "generation", secretRef: `embedded-secret-${suffix}`, grantedScopes: ["read"], orgId: "org",
    owner: setup.subject, binding: setup.binding, audience: "end_user", createdAt: now, updatedAt: now,
    metadata: { auth: "oauth2", url: "https://mcp.example/mcp", transport: "http", oauthClientMode: "dynamic" } };
  const link = { id: `embedded-link-${suffix}`, connectionId: connection.id, projectId: "project", status: "active" as const, createdAt: now, updatedAt: now };
  const state: OAuthStateRecord = { state: `embedded-state-${suffix}`, flowKind: "mcp", status: "pending", setupSessionRef: setup.id,
    providerId: setup.providerId, oauthClientId: "config", oauthClientFingerprint: "pin", projectId: "project", orgId: "org", audience: "end_user",
    subject: setup.subject, binding: setup.binding, requestedScopes: setup.scopes, returnUrl: setup.returnUrl, temporarySecretRef: connection.secretRef,
    redirectUri: "https://host.example/callback", metadata: { ...connection.metadata, pendingConnectionId: connection.id }, createdAt: now, expiresAt: deadline };
  return { setup, state, input: { state: state.state, claimToken: "lease", now, connection, setupReference: setup.id, link } };
}
export function mcpSetupCommitContract(harness: () => Promise<{ first: Stores; second: Stores }>) {
  const fixture = mcpSetupFixture;
  it("atomically commits embedded MCP account, link and both receipts once across replicas", async () => {
    const { first, second } = await harness(), f = fixture("race");
    await first.saveConnectionSetupSession(f.setup); await first.saveOAuthState(f.state);
    await first.claimOAuthState!(f.state.state, "lease", f.state.expiresAt, f.input.now);
    const results = await Promise.all([first, second].map(store => store.commitMcpOAuthSetup!(f.input)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await second.getConnection(f.input.connection.id)).toEqual(f.input.connection);
    expect(await second.getConnectionLink(f.input.link.id)).toEqual(f.input.link);
    expect(await second.getConnectionSetupSessionByReference!(f.setup.id)).toMatchObject({ status: "completed", resultingConnectionId: f.input.connection.id });
    expect(await second.getOAuthState!(f.state.state)).toMatchObject({ status: "completed", completedConnectionId: f.input.connection.id });
  });
  it.each(["owner", "binding", "config", "return_url", "scope", "cancelled", "link_conflict", "state_reference"])("denies changed embedded authority atomically: %s", async reason => {
    const { first, second } = await harness(), f = fixture(reason);
    await first.saveConnectionSetupSession(f.setup); await first.saveOAuthState(f.state);
    await first.claimOAuthState!(f.state.state, "lease", f.state.expiresAt, f.input.now);
    const changed: ConnectionSetupSession = { ...f.setup,
      ...(reason === "owner" ? { subject: { type: "external_user" as const, namespace: "other", id: "gioia" } } : {}),
      ...(reason === "binding" ? { binding: { scopeEpoch: "new" } } : {}),
      ...(reason === "config" ? { oauthClientFingerprint: "new" } : {}),
      ...(reason === "return_url" ? { returnUrl: "https://other.example" } : {}),
      ...(reason === "scope" ? { scopes: ["admin"] } : {}),
      ...(reason === "cancelled" ? { status: "cancelled" } : {}) };
    await second.saveConnectionSetupSession(changed);
    if (reason === "link_conflict") await second.upsertConnectionLink({ ...f.input.link, status: "revoked" });
    expect(await first.commitMcpOAuthSetup!({ ...f.input, ...(reason === "state_reference" ? { setupReference: "other" } : {}) })).toBeNull();
    expect(await first.getConnection(f.input.connection.id)).toBeNull();
    expect((await first.getOAuthState!(f.state.state))?.status).toBe("processing");
    expect((await first.getConnectionSetupSession(f.setup.id))?.resultingConnectionId).toBeUndefined();
    expect((await first.getConnectionLink(f.input.link.id))?.status ?? null).toBe(reason === "link_conflict" ? "revoked" : null);
  });

  it("provider denial atomically ends both receipts and cannot be reclaimed", async () => {
    const { first, second } = await harness(), f = fixture("denied");
    await first.saveConnectionSetupSession(f.setup); await first.saveOAuthState(f.state);
    await first.claimOAuthState!(f.state.state, "lease", f.state.expiresAt, f.input.now);
    expect(await first.failMcpOAuthSetup!(f.input)).toMatchObject({ status: "error" });
    expect(await second.getOAuthState!(f.state.state)).toMatchObject({ status: "failed", lastErrorCode: "oauth_error" });
    expect(await second.claimOAuthState!(f.state.state, "retry", f.state.expiresAt, f.input.now)).toBeNull();
    expect(await second.commitMcpOAuthSetup!(f.input)).toBeNull();
    expect(await second.getConnection(f.input.connection.id)).toBeNull();
    expect(await second.getConnectionLink(f.input.link.id)).toBeNull();
  });

  it.each(["replaced", "expired", "changed_setup"])("denial cannot overwrite a %s callback authority", async reason => {
    const { first, second } = await harness(), f = fixture(`deny-${reason}`);
    await first.saveConnectionSetupSession(f.setup); await first.saveOAuthState(f.state);
    await first.claimOAuthState!(f.state.state, reason === "replaced" ? "other-worker" : "lease",
      reason === "expired" ? new Date(Date.now() - 1_000).toISOString() : f.state.expiresAt, f.input.now);
    if (reason === "changed_setup") await second.saveConnectionSetupSession({ ...f.setup, binding: { scopeEpoch: "changed" } });
    expect(await first.failMcpOAuthSetup!(f.input)).toBeNull();
    expect(await second.getConnectionSetupSession(f.setup.id)).toMatchObject({ status: "started" });
    expect(await second.getOAuthState!(f.state.state)).toMatchObject({ status: "processing" });
  });
}
