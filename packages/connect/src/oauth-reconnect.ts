import type { ConnectionRecord, OAuthReconnectSnapshot } from "./types.js";

/** Canonical host-only snapshot. Benign usage timestamps/name edits do not invalidate consent. */
export function snapshotOAuthReconnect(connection: ConnectionRecord): OAuthReconnectSnapshot {
  const b = connection.binding, i = connection.oauthIdentity, o = connection.owner;
  return { connectionId: connection.id, authorizationFingerprint: JSON.stringify([
    connection.providerId, connection.authenticationId, connection.authType, connection.status,
    connection.projectId, connection.orgId, connection.audience,
    o?.type, o?.id, o?.type === "external_user" ? o.namespace : undefined,
    b?.principal?.type, b?.principal?.id, b?.principal?.namespace, b?.tenant?.namespace, b?.tenant?.id,
    b?.resource?.namespace, b?.resource?.type, b?.resource?.id, b?.scopeEpoch,
    connection.oauthClientId, connection.oauthClientFingerprint, connection.secretRef, connection.credentialVersion,
    [...connection.grantedScopes].sort(), i?.issuer, i?.subject, i?.policyFingerprint,
  ]) };
}

export function matchesOAuthReconnect(connection: ConnectionRecord, expected: OAuthReconnectSnapshot): boolean {
  return connection.id === expected.connectionId && connection.status === "active" && connection.authType === "oauth2"
    && snapshotOAuthReconnect(connection).authorizationFingerprint === expected.authorizationFingerprint;
}
