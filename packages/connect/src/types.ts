/** Legacy credential discriminator. New definitions separate protocol and authentication. */
export type ConnectorAuthType = "api_key" | "oauth2" | "mcp" | "none";

export type ConnectorProtocol = "http_api" | "mcp";

export type ConnectSubjectType = "user" | "project" | "org" | "agent" | "service";

export interface ConnectSubject {
  type: ConnectSubjectType;
  id: string;
}

export interface ConnectorScopeDefinition {
  id: string;
  label?: string;
  description?: string;
  required?: boolean;
  dangerous?: boolean;
}

export type ConnectorActionRisk = "read" | "write" | "admin";

export interface ConnectorActionDefinition {
  id: string;
  label?: string;
  description?: string;
  scopes?: string[];
  risk?: ConnectorActionRisk;
  inputSchema?: unknown;
  outputSchema?: unknown;
  metadata?: Record<string, unknown>;
}

/** A host binds identity, the Connection and grants; action handlers never receive credentials. */
export interface ConnectorActionRequest {
  actionId: string;
  scopes: string[];
  request: import("@polpo-ai/core").ConnectionRequest;
}

export type ConnectorActionGateway = (input: ConnectorActionRequest) => Promise<import("@polpo-ai/core").ConnectionResponse>;

export interface ConnectorTriggerDefinition {
  id: string;
  label?: string;
  description?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface ApiKeyAuthConfig {
  type: "api_key";
  headerName?: string;
  queryParam?: string;
  instructions?: string;
  defaultScopes?: string[];
}

export interface OAuth2AuthConfig {
  type: "oauth2";
  authorizationUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  /** @deprecated Use an OAuthClientResolver. Retained for legacy instance setup. */
  clientId?: string;
  /** @deprecated Use an OAuthClientResolver. Retained for legacy instance setup. */
  clientSecret?: string;
  defaultScopes?: string[];
  supportsPkce?: boolean;
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  /** Server-only account continuity check. This endpoint is not an agent API. */
  identity?: OAuthUserInfoPolicy;
}

export interface OAuthUserInfoPolicy {
  method: "userinfo";
  issuer: string;
  url: string;
  requiredScopes: string[];
  /** Provider-returned scope spelling to its declared canonical spelling. */
  scopeAliases?: Record<string, string>;
}

export interface OAuthAccountIdentity {
  issuer: string;
  subject: string;
  verifiedAt: string;
  policyFingerprint: string;
}

/** Host-only immutable authorization snapshot, never a tool argument. */
export interface OAuthReconnectSnapshot {
  connectionId: string;
  authorizationFingerprint: string;
}

export interface OAuthCredentialReplacement {
  secretRef: string;
  credentialVersion: string;
  tokenExpiresAt?: string;
  grantedScopes: string[];
  oauthClientFingerprint: string;
  oauthIdentity: OAuthAccountIdentity;
  updatedAt: string;
}

export interface McpAuthConfig {
  type: "mcp";
  auth?: "none" | "bearer" | "header" | "oauth2";
  headerName?: string;
  defaultScopes?: string[];
}

export interface NoAuthConfig {
  type: "none";
  defaultScopes?: string[];
}

export type ConnectorAuthConfig = ApiKeyAuthConfig | OAuth2AuthConfig | McpAuthConfig | NoAuthConfig;

export interface ConnectorHttpAuthPolicy {
  mode: "bearer" | "header" | "query" | "none";
  name?: string;
}

export interface ConnectorHttpPolicy {
  origins: string[];
  allowedMethods?: string[];
  allowedPathPatterns?: string[];
  auth: ConnectorHttpAuthPolicy;
  followRedirects?: boolean;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export interface ConnectorProviderDefinition {
  id: string;
  name: string;
  description?: string;
  auth: ConnectorAuthConfig;
  scopes?: ConnectorScopeDefinition[];
  actions?: ConnectorActionDefinition[];
  triggers?: ConnectorTriggerDefinition[];
  allowCustomScopes?: boolean;
  icon?: string;
  metadata?: Record<string, unknown>;
  http?: ConnectorHttpPolicy;
  verification?: import("./verification.js").ConnectorVerificationProbe;
  /** Normalized execution projection; authored v2 definitions retain all supported methods. */
  protocol?: ConnectorProtocol;
  authenticationId?: string;
  source?: "catalog" | "custom";
}

export type ConnectionStatus = "active" | "pending" | "revoked" | "error";

export type ConnectionAudience = "personal" | "shared" | "end_user";

export type ConnectionOwner =
  | ConnectSubject
  | { type: "external_user"; namespace: string; id: string };

/** Host-authenticated control-plane input, never model/tool arguments.
 * Omitted audience retains the shared default; ownership does not imply audience.
 * Personal/end-user audiences require a matching owner and derive its principal binding.
 */
export interface ConnectionCreationContext {
  audience?: ConnectionAudience;
  subject?: ConnectionOwner;
  binding?: ConnectionBindingAttributes;
}

export type ConnectionLinkStatus = "active" | "revoked";

export interface ConnectionLink {
  id: string;
  connectionId: string;
  projectId: string;
  status: ConnectionLinkStatus;
  createdAt: string;
  updatedAt: string;
}

export type OAuthClientOwner = {
  type: "platform" | "instance" | "org" | "project";
  id: string;
};

export interface OAuthClientRecord {
  id: string;
  providerId: string;
  owner: OAuthClientOwner;
  status: "active" | "disabled" | "error";
  clientId: string;
  secretRef?: string;
  redirectUris: string[];
  metadata?: Record<string, unknown>;
}

export interface ResolvedOAuthClient {
  id: string;
  providerId: string;
  clientId: string;
  clientSecret?: string;
  redirectUris: readonly string[];
  owner: OAuthClientOwner;
}

export interface OAuthClientResolverInput {
  providerId: string;
  authenticationId?: string;
  projectId?: string;
  orgId?: string;
  mode: "managed" | "customer" | "instance";
}

export interface OAuthClientResolver {
  resolve(input: OAuthClientResolverInput): Promise<ResolvedOAuthClient>;
  resolveById(id: string): Promise<ResolvedOAuthClient | null>;
}

export interface ConnectionBindingPrincipal {
  type: string;
  id: string;
  /** Application identity namespace. Required to select an external user's account. */
  namespace?: string;
}

export interface ConnectionBindingTenant {
  namespace: string;
  id: string;
}

export interface ConnectionBindingResource {
  namespace: string;
  type: string;
  id: string;
}

/** Non-secret dimensions used for strict trusted Connection selection. */
export interface ConnectionBindingAttributes {
  principal?: ConnectionBindingPrincipal;
  tenant?: ConnectionBindingTenant;
  resource?: ConnectionBindingResource;
  scopeEpoch?: string;
}

export interface ConnectionSelectionSelector extends ConnectionBindingAttributes {
  projectId: string;
  orgId?: string;
  /** Host-selected audience, never a model argument. Unbound shared access must be explicit. */
  audience?: ConnectionAudience;
}

export interface ConnectionRecord {
  id: string;
  providerId: string;
  authenticationId?: string;
  name?: string;
  projectId?: string;
  orgId?: string;
  owner?: ConnectionOwner;
  audience?: ConnectionAudience;
  oauthClientId?: string;
  /** Registration/endpoint identity; rotating only the client secret keeps this stable. */
  oauthClientFingerprint?: string;
  providerAccountId?: string;
  /** Callback-verified identity only; ordinary probes and caller metadata must never populate this field. */
  oauthIdentity?: OAuthAccountIdentity;
  credentialVersion?: string;
  authType: ConnectorAuthType;
  status: ConnectionStatus;
  grantedScopes: string[];
  secretRef?: string;
  tokenExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  binding?: ConnectionBindingAttributes;
}

export interface OAuthStateRecord {
  /** Assigned only by startOAuthSetup; never accepted from caller metadata. */
  setupSessionRef?: string;
  state: string;
  providerId: string;
  authenticationId?: string;
  subject?: ConnectionOwner;
  requestedScopes: string[];
  redirectUri: string;
  codeVerifier?: string;
  codeChallenge?: string;
  projectId?: string;
  orgId?: string;
  connectionName?: string;
  expiresAt: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  oauthClientId?: string;
  oauthClientFingerprint?: string;
  oauthIdentityPolicyFingerprint?: string;
  reconnect?: OAuthReconnectSnapshot;
  audience?: ConnectionAudience;
  binding?: ConnectionBindingAttributes;
  returnUrl?: string;
  /** Distinguishes static Connector OAuth from protocol-discovered MCP OAuth. */
  flowKind?: "connector" | "mcp";
  /** Encrypted host secret containing transient client/discovery material. */
  temporarySecretRef?: string;
  status?: "pending" | "processing" | "completed" | "failed";
  claimToken?: string;
  claimExpiresAt?: string;
  attempts?: number;
  completedConnectionId?: string;
  lastErrorCode?: string;
}

export interface ConnectionSetupSession {
  id: string;
  /** Missing on existing API-provider sessions. Assigned by the service. */
  flowKind?: "connector" | "mcp";
  /** Private persistence reference, distinct from a hosted bearer token. */
  reference?: string;
  status?: "pending" | "started" | "completed" | "cancelled" | "error";
  resultingConnectionId?: string;
  authorizationExpiresAt?: string;
  /** Private callback intent, assigned by the service before account persistence. */
  completionIntent?: ConnectionSetupCompletionIntent;
  providerId: string;
  authenticationId?: string;
  oauthClientId: string;
  oauthClientFingerprint?: string;
  oauthIdentityPolicyFingerprint?: string;
  projectId: string;
  orgId?: string;
  audience: ConnectionAudience;
  subject: ConnectionOwner;
  binding?: ConnectionBindingAttributes;
  scopes: string[];
  returnUrl: string;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string;
  scopes?: string[];
  raw?: unknown;
}

export interface RuntimeToken {
  accessToken: string;
  tokenType: string;
  expiresAt?: string;
  scopes: string[];
  connectionId: string;
  providerId: string;
}

export type McpConnectionTransport = "http" | "sse";

export type McpConnectionAuth = "none" | "bearer" | "header" | "oauth2";

export type McpOAuthClientMode = "dynamic" | "metadata_document" | "pre_registered";

export interface McpOAuthClientInformation extends Record<string, unknown> {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

/** Host-owned reusable client setup. Never serialize private client information
 * in a browser setup session or accept it from an agent invocation. */
export interface ResolvedMcpOAuthClient {
  id: string;
  providerId: string;
  authenticationId?: string;
  owner: OAuthClientOwner;
  resourceUrl: string;
  transport: McpConnectionTransport;
  redirectUri: string;
  registration:
    | { mode: "dynamic"; clientName: string; clientUri?: string }
    | { mode: "metadata_document"; clientMetadataUrl: string }
    | { mode: "pre_registered"; client: McpOAuthClientInformation };
}

export interface McpOAuthClientResolverInput extends OAuthClientResolverInput {
  /** Optional trusted backend choice. The resolver must still enforce its
   * owner/project/organization scope; ambiguous unselected matches must fail. */
  configurationId?: string;
}

export interface McpOAuthClientResolver {
  resolve(input: McpOAuthClientResolverInput): Promise<ResolvedMcpOAuthClient>;
  resolveById(id: string): Promise<ResolvedMcpOAuthClient | null>;
}

export interface McpOAuthDiscovery extends Record<string, unknown> {
  resource: string;
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  rawAuthorizationServerMetadata?: Record<string, unknown>;
  rawProtectedResourceMetadata?: Record<string, unknown>;
}

export interface McpOAuthSecretMaterial {
  mode: McpOAuthClientMode;
  redirectUri: string;
  discovery: McpOAuthDiscovery;
  client: McpOAuthClientInformation;
  tokens?: TokenSet;
  codeVerifier?: string;
}

export interface McpOAuthInspection {
  url: string;
  transport: McpConnectionTransport;
  auth: "oauth2" | "none" | "unknown";
  discovery?: McpOAuthDiscovery;
  clientModes: McpOAuthClientMode[];
  warnings: string[];
}

export interface McpConnectionMetadata extends Record<string, unknown> {
  url: string;
  transport: McpConnectionTransport;
  auth: McpConnectionAuth;
  headerName?: string;
  serverName?: string;
  oauthClientMode?: McpOAuthClientMode;
}

export type ResolvedConnectionCredential =
  | {
      kind: "none";
      scopes: string[];
      connectionId: string;
      providerId: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "api_key";
      value: string;
      scopes: string[];
      connectionId: string;
      providerId: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "oauth2";
      accessToken: string;
      tokenType: string;
      expiresAt?: string;
      scopes: string[];
      connectionId: string;
      providerId: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "mcp";
      accessToken?: string;
      tokenType?: string;
      expiresAt?: string;
      scopes: string[];
      connectionId: string;
      providerId: string;
      metadata?: McpConnectionMetadata;
    };

export interface StoredConnectionSecret {
  kind: "api_key" | "oauth2" | "mcp";
  apiKey?: string;
  tokens?: TokenSet;
  mcpOAuth?: McpOAuthSecretMaterial;
  metadata?: Record<string, unknown>;
}

export interface ConnectionListFilter {
  providerId?: string;
  projectId?: string;
  orgId?: string;
  owner?: ConnectionOwner;
  status?: ConnectionStatus;
}

export interface ConnectStore {
  // Write exceptions do not imply rollback: a remote commit can outlive its
  // acknowledgement. Only a matching positive read proves a completed write;
  // a missing row must not trigger destructive secret compensation.
  listConnections(filter?: ConnectionListFilter): Promise<ConnectionRecord[]>;
  getConnection(id: string): Promise<ConnectionRecord | null>;
  upsertConnection(record: ConnectionRecord): Promise<ConnectionRecord>;
  updateConnection(id: string, patch: Partial<Omit<ConnectionRecord, "id" | "createdAt">>): Promise<ConnectionRecord>;
  /** Atomic authorization CAS. null confirms no replacement; an exception may
   * mean the outcome is unknown. Unsupported hosts must reject reconnect,
   * never use updateConnection as fallback. */
  replaceOAuthCredential?(expected: OAuthReconnectSnapshot, replacement: OAuthCredentialReplacement): Promise<ConnectionRecord | null>;
  deleteConnection(id: string): Promise<void>;
  saveOAuthState(record: OAuthStateRecord): Promise<void>;
  consumeOAuthState(state: string): Promise<OAuthStateRecord | null>;
  getOAuthState?(state: string): Promise<OAuthStateRecord | null>;
  /** Insert a new MCP account and complete its OAuth receipt atomically under
   * the current unexpired claim. Never upsert/reactivate a conflicting account.
   * null proves rejection; a write exception may have committed. No fallback
   * to separate account/receipt writes is safe. */
  commitMcpOAuthConnection?(input: McpOAuthConnectionCommit): Promise<ConnectionRecord | null>;
  /** Atomic embedded activation: account, active project link, setup receipt
   * and OAuth receipt. All must match the saved, consumed setup authority. */
  commitMcpOAuthSetup?(input: McpOAuthSetupCommit): Promise<ConnectionRecord | null>;
  /** End a provider-denied embedded flow and its OAuth receipt atomically,
   * only while the matching callback still owns an unexpired claim. */
  failMcpOAuthSetup?(input: McpOAuthSetupFailure): Promise<ConnectionSetupSession | null>;
  claimOAuthState?(
    state: string,
    claimToken: string,
    claimExpiresAt: string,
    now: string,
  ): Promise<OAuthStateRecord | null>;
  completeOAuthState?(
    state: string,
    claimToken: string,
    connectionId: string,
  ): Promise<OAuthStateRecord | null>;
  releaseOAuthState?(
    state: string,
    claimToken: string,
    errorCode: string,
  ): Promise<OAuthStateRecord | null>;
}

export interface McpOAuthConnectionCommit {
  state: string;
  claimToken: string;
  now: string;
  connection: ConnectionRecord;
}

export interface McpOAuthSetupCommit extends McpOAuthConnectionCommit {
  setupReference: string;
  link: ConnectionLink;
}

export interface McpOAuthSetupFailure {
  state: string;
  setupReference: string;
  claimToken: string;
  now: string;
}

export interface ConnectionLinkListFilter {
  connectionId?: string;
  projectId?: string;
  status?: ConnectionLinkStatus;
}

export interface ConnectionLinkStore {
  listConnectionLinks(filter?: ConnectionLinkListFilter): Promise<ConnectionLink[]>;
  getConnectionLink(id: string): Promise<ConnectionLink | null>;
  upsertConnectionLink(link: ConnectionLink): Promise<ConnectionLink>;
  updateConnectionLink(
    id: string,
    patch: Partial<Omit<ConnectionLink, "id" | "createdAt">>,
  ): Promise<ConnectionLink>;
}

export interface ConnectionSetupSessionStore {
  saveConnectionSetupSession(session: ConnectionSetupSession): Promise<void>;
  getConnectionSetupSession(id: string): Promise<ConnectionSetupSession | null>;
  /** Host-only lookup by persisted reference, never exposed as a public token. */
  getConnectionSetupSessionByReference?(reference: string): Promise<ConnectionSetupSession | null>;
  /** CAS pending/unconsumed/unexpired; returns the PRE-consumption snapshot. */
  consumeConnectionSetupSession(id: string, consumedAt: string, authorizationExpiresAt?: string): Promise<ConnectionSetupSession | null>;
  /** CAS with the same pending/expiry predicate as consume. */
  cancelConnectionSetupSession?(id: string, cancelledAt: string): Promise<ConnectionSetupSession | null>;
  /** Terminal outcome for a server-owned OAuth state reference. A completed
   * receipt must never be replaced by error or another Connection ID. Hosts
   * committing atomically may verify their receipt here without another write. */
  finishConnectionSetupSession?(reference: string, outcome: ConnectionSetupOutcome, finishedAt: string): Promise<ConnectionSetupSession | null>;
  /** Optional recovery for hosts whose account/link/receipt writes are separate.
   * Pin once, idempotent only for the exact same server-owned intent. */
  prepareConnectionSetupCompletion?(reference: string, intent: ConnectionSetupCompletionIntent): Promise<ConnectionSetupSession | null>;
  /** Verify only the pinned account generation and existing active project link.
   * Never create or reactivate an account/link while reconciling. */
  reconcileConnectionSetupSession?(reference: string): Promise<ConnectionSetupSession | null>;
}

export type ConnectionSetupOutcome = { status: "completed"; connectionId: string } | { status: "error" };

export interface ConnectionSetupCompletionIntent {
  connection: OAuthReconnectSnapshot;
  link: Pick<ConnectionLink, "id" | "connectionId" | "projectId">;
}

export interface ConnectionSetupStatus {
  providerId: string;
  providerName?: string;
  projectId: string;
  status: "pending" | "started" | "completed" | "cancelled" | "expired" | "error";
  resultingConnectionId?: string;
  expiresAt: string;
  consumedAt?: string;
  scopes: string[];
  permissions?: { id: string; label: string; description?: string }[];
  application?: { name: string; url?: string };
}

export interface ConnectPolicyDecisionInput {
  connection: ConnectionRecord;
  subject?: ConnectSubject;
  scopes: string[];
  actionId?: string;
}

export interface ConnectPolicy {
  canUseConnection(input: ConnectPolicyDecisionInput): Promise<boolean> | boolean;
}
