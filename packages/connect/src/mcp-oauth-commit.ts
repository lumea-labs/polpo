import { snapshotOAuthReconnect } from "./oauth-reconnect.js";
import { connectionSetupState } from "./setup-lifecycle.js";
import type { ConnectionSetupSession, McpOAuthConnectionCommit, McpOAuthSetupCommit, McpOAuthSetupFailure, OAuthStateRecord } from "./types.js";

/** Shared activation invariant. Hosts additionally fence the database version
 * and their own tenant/principal authorization in the atomic write. */
export function canCommitMcpOAuthConnection(state: OAuthStateRecord, input: McpOAuthConnectionCommit): boolean {
  return !state.setupSessionRef && canActivate(state, input, false);
}

function canActivate(state: OAuthStateRecord, input: McpOAuthConnectionCommit, embedded: boolean): boolean {
  const c = input.connection, metadata = state.metadata;
  if (state.state !== input.state || state.flowKind !== "mcp" || state.status !== "processing"
    || state.claimToken !== input.claimToken || !state.claimExpiresAt
    || !(Date.parse(state.claimExpiresAt) > Date.parse(input.now))
    || !(Date.parse(state.expiresAt) > Date.parse(input.now))
    || !metadata?.pendingConnectionId || metadata.pendingConnectionId !== c.id
    || !state.temporarySecretRef || !c.credentialVersion || c.authType !== "mcp" || c.status !== "active"
    || metadata.auth !== "oauth2" || c.metadata?.auth !== "oauth2"
    || typeof metadata.url !== "string" || metadata.url !== c.metadata?.url
    || metadata.transport !== c.metadata?.transport || metadata.oauthClientMode !== c.metadata?.oauthClientMode) return false;
  const expected = { ...c, providerId: state.providerId, authenticationId: state.authenticationId,
    projectId: embedded ? undefined : state.projectId, orgId: state.orgId, audience: state.audience, owner: state.subject,
    binding: state.binding, secretRef: state.temporarySecretRef, grantedScopes: state.requestedScopes,
    oauthClientId: state.oauthClientId, oauthClientFingerprint: state.oauthClientFingerprint };
  return snapshotOAuthReconnect(c).authorizationFingerprint === snapshotOAuthReconnect(expected).authorizationFingerprint;
}

function canonical(value: unknown): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sort(v)])) : value;
  return JSON.stringify(sort(value)) ?? "";
}

/** Stable setup authority comparison, also usable for idempotent receipt reads. */
export function matchesMcpOAuthSetup(state: OAuthStateRecord, setup: ConnectionSetupSession): boolean {
  return setup.flowKind === "mcp" && state.flowKind === "mcp"
    && Boolean(state.setupSessionRef) && state.setupSessionRef === (setup.reference ?? setup.id)
    && state.providerId === setup.providerId && state.authenticationId === setup.authenticationId
    && Boolean(state.oauthClientFingerprint) && state.oauthClientFingerprint === setup.oauthClientFingerprint
    && state.oauthClientId === setup.oauthClientId && state.projectId === setup.projectId && state.orgId === setup.orgId
    && state.audience === setup.audience && canonical(state.subject) === canonical(setup.subject)
    && canonical(state.binding) === canonical(setup.binding) && state.returnUrl === setup.returnUrl
    && canonical([...state.requestedScopes].sort()) === canonical([...setup.scopes].sort())
    && state.expiresAt === setup.authorizationExpiresAt && Boolean(setup.consumedAt);
}

export function canCommitMcpOAuthSetup(state: OAuthStateRecord, setup: ConnectionSetupSession, input: McpOAuthSetupCommit): boolean {
  return input.setupReference === state.setupSessionRef && matchesMcpOAuthSetup(state, setup)
    && connectionSetupState(setup) === "started" && !setup.resultingConnectionId
    && Date.parse(setup.authorizationExpiresAt!) > Date.parse(input.now) && canActivate(state, input, true)
    && input.link.status === "active" && input.link.projectId === setup.projectId && input.link.connectionId === input.connection.id;
}

export function canFailMcpOAuthSetup(state: OAuthStateRecord, setup: ConnectionSetupSession, input: McpOAuthSetupFailure): boolean {
  return input.state === state.state && input.setupReference === state.setupSessionRef && matchesMcpOAuthSetup(state, setup)
    && connectionSetupState(setup) === "started" && !setup.resultingConnectionId
    && state.status === "processing" && state.claimToken === input.claimToken
    && Date.parse(state.claimExpiresAt ?? "") > Date.parse(input.now)
    && Date.parse(state.expiresAt) > Date.parse(input.now)
    && Date.parse(setup.authorizationExpiresAt!) > Date.parse(input.now);
}

export function failedMcpOAuthState(state: OAuthStateRecord): OAuthStateRecord {
  return { ...state, status: "failed", claimToken: undefined, claimExpiresAt: undefined, lastErrorCode: "oauth_error" };
}

export function completedMcpOAuthState(state: OAuthStateRecord, connectionId: string): OAuthStateRecord {
  return { ...state, status: "completed", completedConnectionId: connectionId,
    claimToken: undefined, claimExpiresAt: undefined, lastErrorCode: undefined };
}
