import {
  ConnectError,
  connectionRequiresSecret,
  connectionSetupState,
  type ConnectionSetupStatus,
  snapshotOAuthReconnect,
  matchesOAuthReconnect,
  matchesMcpOAuthSetup,
  type OAuthReconnectSnapshot,
  assertConnectorRedirectAllowed,
  assertAllowedScopes,
  assertGrantedScopes,
  connectorHostnameIsUnsafe,
  createConnectorRegistry,
  compileConnectorDefinition,
  describeConnector,
  normalizeConnectorDefinition,
  normalizeConnectorAuthPolicy,
  normalizeScopes,
  resolveConnectorHttpRequest,
  type ConnectPolicy,
  type ConnectStore,
  type ConnectSubject,
  type ConnectionAudience,
  type ConnectionBindingAttributes,
  type ConnectionCreationContext,
  type ConnectionLinkStore,
  type ConnectionLink,
  type ConnectionLinkListFilter,
  type ConnectionOwner,
  type ConnectionRecord,
  type ConnectionSetupSession,
  type ConnectionSetupSessionStore,
  type ConnectorProviderDefinition,
  type ConnectorDefinition,
  type ConnectorCatalogEntry,
  type ConnectorDefinitionStore,
  type StoredConnectorDefinition,
  type ConnectorSetupReadinessInput,
  type ConnectorSetupReadinessResult,
  type ConnectionVerificationResult,
  type ConnectionVerificationStore,
  type McpConnectionAuth,
  type McpConnectionMetadata,
  type McpConnectionTransport,
  type McpOAuthClientInformation,
  type McpOAuthClientResolver,
  type McpOAuthClientMode,
  type McpOAuthInspection,
  type McpOAuthSecretMaterial,
  type OAuth2AuthConfig,
  type OAuthStateRecord,
  type OAuthClientResolver,
  type ResolvedOAuthClient,
  type ResolvedConnectionCredential,
  type RuntimeToken,
  type StoredConnectionSecret,
  type TokenSet,
} from "@polpo-ai/connect";
import {
  ConnectionSelectionError,
  type ConnectionRequest,
  type ConnectionResponse,
} from "@polpo-ai/core";
import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import {
  MemoryTokenRefreshCoordinator,
  isVersionedConnectionSecretStore,
  type ConnectionSecretStore,
  type TokenRefreshCoordinator,
} from "./secrets.js";
import { createOpaqueToken, createPkcePair, parseScopes } from "./oauth.js";
import { requestOAuthToken, type ProviderTokenResponse } from "./oauth-token-transport.js";
import { verifyConnectionProbe } from "./verification.js";
import { assertRefreshAvailable, hasPendingRefresh, refreshConnectionSecret } from "./refresh-lineage.js";
import { normalizeOAuthTokenScopes, oauthIdentityPolicyFingerprint, resolveOAuthAccountIdentity } from "./oauth-identity.js";
import { publicNetworkFetch } from "./public-network.js";
import { resolveMcpOAuthSetupClient, verifyMcpOAuthSetupClient } from "./mcp-setup-clients.js";
import { observeConnectionSetupSession, cancelConnectionSetupSession } from "./setup-lifecycle.js";
import {
  createMcpOAuthProtocol,
  type McpOAuthClientRegistrationStore,
} from "./mcp-oauth.js";

/** Host authorization only. No provider credentials, callback codes or metadata. */
export interface OAuthOperationContext {
  operation: "setup" | "authorize" | "callback" | "credential" | "refresh";
  protocol: "api" | "mcp";
  providerId: string;
  authenticationId?: string;
  projectId?: string;
  orgId?: string;
  connectionId?: string;
}

export interface CreateConnectServiceOptions {
  providers: readonly (ConnectorProviderDefinition | ConnectorDefinition)[];
  store: ConnectStore;
  secrets: ConnectionSecretStore;
  policy?: ConnectPolicy;
  /** Deny by throwing. Omitted on self-hosted instances without a host gate. */
  authorizeOAuth?: (input: Readonly<OAuthOperationContext>) => void | Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
  tokenRefreshSkewMs?: number;
  oauthStateTtlMs?: number;
  allowInsecureLocalMcpUrls?: boolean;
  refreshCoordinator?: TokenRefreshCoordinator;
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  oauthClients?: OAuthClientResolver;
  mcpOAuthClients?: McpOAuthClientResolver;
  setupSessions?: ConnectionSetupSessionStore;
  links?: ConnectionLinkStore;
  setupSessionTtlMs?: number;
  allowedReturnUrlOrigins?: readonly string[];
  mcpOAuthRegistrations?: McpOAuthClientRegistrationStore;
  mcpOAuthCallbackClaimTtlMs?: number;
  verifyMcp?: VerifyMcpConnectionProbe;
  /** Host dispatch quota for direct requests and verification. Runtime callers
   * can replace this with an invocation-scoped request hook; never both. */
  beforeDispatch?: (connection: ConnectionRecord) => Promise<void>;
  verifications?: ConnectionVerificationStore;
  definitions?: ConnectorDefinitionStore;
}

export interface VerifyConnectionInput {
  connectionId: string;
  subject?: ConnectSubject;
  signal?: AbortSignal;
}

export type VerifyMcpConnectionProbe = (input: {
  connection: ConnectionRecord;
  credential: ResolvedConnectionCredential;
  signal?: AbortSignal;
  /** The adapter must call this immediately before each provider request. */
  beforeDispatch?: () => Promise<void>;
}) => Promise<{ toolCount: number }>;

export interface CreateApiKeyConnectionInput extends ConnectionCreationContext {
  providerId: string;
  authenticationId?: string;
  apiKey: string;
  scopes?: string[];
  name?: string;
  projectId?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
  secretMetadata?: Record<string, unknown>;
}

export type CreatePublicConnectionInput = Omit<CreateApiKeyConnectionInput, "apiKey" | "secretMetadata">;

export interface CreateMcpConnectionInput extends ConnectionCreationContext {
  providerId?: string;
  authenticationId?: string;
  name?: string;
  url: string;
  transport?: McpConnectionTransport;
  auth?: McpConnectionAuth;
  /** Generic MCP only; a selected Connector's header always takes precedence. */
  headerName?: string;
  apiKey?: string;
  bearerToken?: string;
  scopes?: string[];
  projectId?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
}

export interface StartOAuthInput {
  providerId: string;
  authenticationId?: string;
  scopes?: string[];
  subject?: ConnectionOwner;
  redirectUri: string;
  projectId?: string;
  orgId?: string;
  connectionName?: string;
  metadata?: Record<string, unknown>;
  oauthClientMode?: "managed" | "customer" | "instance";
}

export interface StartOAuthResult {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
}

/** Reauthorize an existing Connection without changing its app or identity. */
export interface ReconnectOAuthInput {
  connectionId: string;
  redirectUri: string;
  projectId?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
}

export interface InspectMcpOAuthConnectionInput {
  url: string;
  transport?: McpConnectionTransport;
}

export interface StartMcpOAuthInput extends ConnectionCreationContext {
  providerId?: string;
  authenticationId?: string;
  name?: string;
  url: string;
  transport?: McpConnectionTransport;
  scopes?: string[];
  projectId?: string;
  orgId?: string;
  redirectUri: string;
  mode: McpOAuthClientMode;
  clientName?: string;
  clientUri?: string;
  clientMetadataUrl?: string;
  preRegisteredClient?: McpOAuthClientInformation;
  metadata?: Record<string, unknown>;
}

export interface CompleteOAuthInput {
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

export interface GetTokenInput {
  connectionId: string;
  scopes?: string[];
  subject?: ConnectSubject;
  actionId?: string;
  forceRefresh?: boolean;
}

export type ResolveConnectionCredentialInput = GetTokenInput;

export interface RevokeConnectionInput {
  connectionId: string;
}

export interface ConnectionGatewayRequestInput extends GetTokenInput {
  request: ConnectionRequest;
  signal?: AbortSignal;
  /** Host-only live authorization for the acquired invocation. Never accept
   * this from tool arguments. Called after refresh/DNS and on every redirect. */
  authorizeDispatch?: () => Promise<void>;
  /** Host-only budget debit, after live authorization and once per HTTP send.
   * Unlike authorizeDispatch this is never a preflight or credential lookup. */
  beforeDispatch?: (input: { method: string }) => Promise<void>;
}

export interface CreateConnectionSetupSessionInput {
  /** Host-scoped reusable MCP client configuration; ambiguity is rejected. */
  configurationId?: string;
  providerId: string;
  authenticationId?: string;
  projectId: string;
  orgId?: string;
  audience: ConnectionAudience;
  subject: ConnectionOwner;
  binding?: ConnectionBindingAttributes;
  scopes?: string[];
  returnUrl: string;
  oauthClientMode: "managed" | "customer" | "instance";
  metadata?: Record<string, unknown>;
}

export interface StartOAuthSetupInput {
  setupSessionId: string;
}

export interface LinkConnectionInput {
  connectionId: string;
  projectId: string;
}

export interface UnlinkConnectionInput {
  linkId: string;
}

export interface ConnectService {
  listProviders(): ConnectorProviderDefinition[];
  listCatalog(): Promise<ConnectorCatalogEntry[]>;
  getSetupReadiness(input: ConnectorSetupReadinessInput): Promise<ConnectorSetupReadinessResult>;
  registerConnectorDefinition(input: unknown): Promise<StoredConnectorDefinition>;
  disableConnectorDefinition(id: string): Promise<StoredConnectorDefinition>;
  listConnections(filter?: Parameters<ConnectStore["listConnections"]>[0]): Promise<ConnectionRecord[]>;
  listConnectionLinks(filter?: ConnectionLinkListFilter): Promise<ConnectionLink[]>;
  linkConnection(input: LinkConnectionInput): Promise<ConnectionLink>;
  unlinkConnection(input: UnlinkConnectionInput): Promise<ConnectionLink>;
  createApiKeyConnection(input: CreateApiKeyConnectionInput): Promise<ConnectionRecord>;
  createPublicConnection(input: CreatePublicConnectionInput): Promise<ConnectionRecord>;
  createMcpConnection(input: CreateMcpConnectionInput): Promise<ConnectionRecord>;
  inspectMcpOAuth(input: InspectMcpOAuthConnectionInput): Promise<McpOAuthInspection>;
  startMcpOAuth(input: StartMcpOAuthInput): Promise<StartOAuthResult>;
  completeMcpOAuth(input: CompleteOAuthInput): Promise<ConnectionRecord>;
  createSetupSession(input: CreateConnectionSetupSessionInput): Promise<ConnectionSetupSession>;
  getSetupStatus(id: string): Promise<ConnectionSetupStatus | null>;
  cancelSetupSession(id: string): Promise<ConnectionSetupStatus | null>;
  startOAuthSetup(input: StartOAuthSetupInput): Promise<StartOAuthResult>;
  startOAuth(input: StartOAuthInput): Promise<StartOAuthResult>;
  reconnectOAuth(input: ReconnectOAuthInput): Promise<StartOAuthResult>;
  completeOAuth(input: CompleteOAuthInput): Promise<ConnectionRecord>;
  /** Browser callback adapter: return destination comes only from previously validated OAuth state. */
  completeOAuthCallback(input: CompleteOAuthInput): Promise<{ connection: ConnectionRecord; returnUrl?: string }>;
  resolveCredential(input: ResolveConnectionCredentialInput): Promise<ResolvedConnectionCredential>;
  getToken(input: GetTokenInput): Promise<RuntimeToken>;
  verifyConnection(input: VerifyConnectionInput): Promise<ConnectionVerificationResult>;
  request<T = unknown>(input: ConnectionGatewayRequestInput): Promise<ConnectionResponse<T>>;
  revokeConnection(input: RevokeConnectionInput): Promise<ConnectionRecord>;
}

export function createConnectService(options: CreateConnectServiceOptions): ConnectService {
  const registry = createConnectorRegistry(options.providers);
  const requireProvider = async (id: string, authenticationId?: string): Promise<ConnectorProviderDefinition> => {
    if (registry.get(id)) return registry.require(id, authenticationId);
    const stored = await options.definitions?.getConnectorDefinition(id);
    if (!stored || stored.disabledAt) throw new ConnectError("provider_not_found", "Active Connector not found");
    return compileConnectorDefinition(stored.definition, authenticationId);
  };
  const fetchImpl = options.fetch ?? publicNetworkFetch;
  const now = options.now ?? (() => new Date());
  const tokenRefreshSkewMs = options.tokenRefreshSkewMs ?? 60_000;
  const oauthStateTtlMs = options.oauthStateTtlMs ?? 10 * 60_000;
  const setupSessionTtlMs = options.setupSessionTtlMs ?? 10 * 60_000;
  const refreshCoordinator = options.refreshCoordinator ?? new MemoryTokenRefreshCoordinator();
  const resolveHostname = options.resolveHostname ?? (async (hostname: string) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
  const mcpOAuthFetch: typeof fetch = async (request, init) => withGatewayDeadline(10_000, init?.signal ?? undefined, async signal => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    if (url.protocol !== "https:") {
      throw new ConnectError("oauth_discovery_failed", "MCP OAuth network requests must use HTTPS");
    }
    await assertPublicDns(url.hostname, resolveHostname);
    signal.throwIfAborted();
    const response = await fetchImpl(request, { ...init, signal, redirect: "error" });
    const bytes = await readResponseBytes(response, 256 * 1024, signal);
    return new Response(bytes.byteLength ? Uint8Array.from(bytes) : null, { status: response.status, headers: response.headers });
  });
  const mcpOAuth = createMcpOAuthProtocol({
    fetch: mcpOAuthFetch,
    registrations: options.mcpOAuthRegistrations,
    now,
  });
  const mcpOAuthCallbackClaimTtlMs = options.mcpOAuthCallbackClaimTtlMs ?? 30_000;

  const authorizeOAuth = async (operation: OAuthOperationContext["operation"], protocol: OAuthOperationContext["protocol"],
    context: { providerId: string; authenticationId?: string; projectId?: string; orgId?: string; connectionId?: string }) => {
    // Pick fields explicitly: callers also hold secret-bearing states/inputs.
    await options.authorizeOAuth?.(Object.freeze({ operation, protocol, providerId: context.providerId,
      authenticationId: context.authenticationId, projectId: context.projectId, orgId: context.orgId,
      connectionId: context.connectionId }));
  };
  const authorizeConnection = async (operation: "credential" | "refresh", connection: ConnectionRecord, mcpOAuth = false) => {
    if (connection.authType === "mcp" && (connection.oauthClientId || connection.oauthClientFingerprint)) {
      await verifyMcpClient(connection.oauthClientId, connection.oauthClientFingerprint);
    }
    if (connection.authType === "oauth2" || (connection.authType === "mcp"
      && (mcpOAuth || readMcpAuthMode(connection.metadata) === "oauth2"))) {
      await authorizeOAuth(operation, connection.authType === "oauth2" ? "api" : "mcp",
        { ...connection, connectionId: connection.id });
    }
  };

  const assertConnectionCurrent = async (connection: ConnectionRecord, scopes: string[], authorize = true): Promise<ConnectionRecord> => {
    const current = await options.store.getConnection(connection.id);
    if (!current || current.status !== "active" || current.secretRef !== connection.secretRef
      || current.credentialVersion !== connection.credentialVersion) {
      throw new ConnectError("connection_revoked", "Connection changed while resolving its credential");
    }
    assertGrantedScopes(current.grantedScopes, scopes);
    if (authorize) await authorizeConnection("credential", current);
    return current;
  };

  const recoverConnectionWrite = async (expected: ConnectionRecord): Promise<ConnectionRecord | undefined> => {
    const current = await options.store.getConnection(expected.id).catch(() => null);
    // Only a positive read of our exact generation/authority proves the write.
    // A missing row (or failed read) does not prove a timed-out write rolled back.
    if (current?.status === "active" && snapshotOAuthReconnect(current).authorizationFingerprint
      === snapshotOAuthReconnect(expected).authorizationFingerprint) return current;
    return undefined;
  };

  const persistNewConnection = async (connection: ConnectionRecord): Promise<ConnectionRecord> => {
    try {
      return await options.store.upsertConnection(connection);
    } catch (error) {
      const committed = await recoverConnectionWrite(connection);
      if (committed) return committed;
      // Preserve potentially referenced secrets. Host reconciliation must establish
      // that an uncertain write has finished before reclaiming an actual orphan.
      throw error;
    }
  };

  const resolveOAuthClient = async (input: {
    provider: ConnectorProviderDefinition;
    projectId?: string;
    orgId?: string;
    redirectUri: string;
    mode?: "managed" | "customer" | "instance";
  }): Promise<ResolvedOAuthClient> => {
    if (options.oauthClients) {
      const client = await options.oauthClients.resolve({
        providerId: input.provider.id,
        authenticationId: input.provider.authenticationId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.orgId ? { orgId: input.orgId } : {}),
        mode: input.mode ?? "managed",
      });
      if (input.redirectUri) assertOAuthClient(input.provider.id, input.redirectUri, client);
      else if (client.providerId !== input.provider.id) {
        throw new ConnectError("invalid_provider", "OAuth Client provider does not match Connector");
      }
      return client;
    }
    if (input.mode === "customer") {
      throw new ConnectError("setup_invalid", "Customer OAuth Client resolution is not configured on this host");
    }
    if (input.provider.auth.type !== "oauth2" || !input.provider.auth.clientId) {
      throw new ConnectError(
        "invalid_provider",
        `OAuth provider "${input.provider.id}" is missing an OAuth Client resolver`,
      );
    }
    return {
      id: `legacy:${input.provider.id}`,
      providerId: input.provider.id,
      clientId: input.provider.auth.clientId,
      clientSecret: input.provider.auth.clientSecret,
      redirectUris: [input.redirectUri],
      owner: { type: "instance", id: "legacy" },
    };
  };

  const beginOAuth = async (input: {
    provider: ConnectorProviderDefinition;
    client: ResolvedOAuthClient;
    scopes?: string[];
    subject?: ConnectionOwner;
    redirectUri: string;
    projectId?: string;
    orgId?: string;
    connectionName?: string;
    metadata?: Record<string, unknown>;
    audience?: ConnectionAudience;
    binding?: ConnectionBindingAttributes;
    returnUrl?: string;
    reconnect?: OAuthReconnectSnapshot;
    setupSessionRef?: string;
    authorizationExpiresAt?: string;
    onStateWriteAttempt?: () => void;
  }): Promise<StartOAuthResult> => {
    if (input.provider.auth.type !== "oauth2") {
      throw new ConnectError(
        "unsupported_auth",
        `Provider "${input.provider.id}" does not use OAuth2 auth`,
      );
    }
    assertOAuthClient(input.provider.id, input.redirectUri, input.client);
    const auth = input.provider.auth;
    const requestedScopes = assertAllowedScopes(
      input.provider,
      [...(input.scopes ?? auth.defaultScopes ?? []), ...(auth.identity?.requiredScopes ?? [])],
    );
    const state = createOpaqueToken();
    const pkce = auth.supportsPkce === false ? undefined : createPkcePair();
    await authorizeOAuth("authorize", "api", { ...input, providerId: input.provider.id,
      authenticationId: input.provider.authenticationId, connectionId: input.reconnect?.connectionId });
    const expiresAt = input.authorizationExpiresAt ?? new Date(now().getTime() + oauthStateTtlMs).toISOString();
    if (Date.parse(expiresAt) <= now().getTime()) throw new ConnectError("setup_expired", "OAuth authorization window has expired");
    input.onStateWriteAttempt?.();
    await options.store.saveOAuthState({
      setupSessionRef: input.setupSessionRef,
      state,
      providerId: input.provider.id,
      authenticationId: input.provider.authenticationId,
      subject: input.subject,
      requestedScopes,
      redirectUri: input.redirectUri,
      codeVerifier: pkce?.verifier,
      codeChallenge: pkce?.challenge,
      projectId: input.projectId,
      orgId: input.orgId,
      connectionName: input.connectionName,
      expiresAt,
      createdAt: now().toISOString(),
      metadata: input.metadata,
      oauthClientId: input.client.id,
      oauthClientFingerprint: oauthClientFingerprint(input.provider, input.client.clientId),
      oauthIdentityPolicyFingerprint: oauthIdentityPolicyFingerprint(auth.identity),
      reconnect: input.reconnect,
      audience: input.audience,
      binding: input.binding,
      returnUrl: input.returnUrl,
    });

    const url = new URL(auth.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", input.client.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", state);
    if (requestedScopes.length > 0) url.searchParams.set("scope", requestedScopes.join(" "));
    if (pkce) {
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    for (const [key, value] of Object.entries(auth.extraAuthorizeParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return { authorizationUrl: url.toString(), state, expiresAt };
  };

  const oauthAuthForConnection = async (
    provider: ConnectorProviderDefinition,
    oauthClientId: string | undefined,
    fingerprint?: string,
  ): Promise<OAuth2AuthConfig> => {
    if (provider.auth.type !== "oauth2") {
      throw new ConnectError(
        "unsupported_auth",
        `Provider "${provider.id}" does not use OAuth2 auth`,
      );
    }
    if (!oauthClientId || oauthClientId.startsWith("legacy:")) {
      assertOAuthClientFingerprint(provider, provider.auth.clientId, fingerprint);
      return provider.auth;
    }
    const client = await options.oauthClients?.resolveById(oauthClientId);
    if (!client || client.id !== oauthClientId || client.providerId !== provider.id) {
      throw new ConnectError(
        "refresh_unavailable",
        "OAuth Client is unavailable during token refresh",
      );
    }
    assertOAuthClientFingerprint(provider, client.clientId, fingerprint);
    return {
      ...provider.auth,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
    };
  };

  const configurationForOAuthState = async (state: OAuthStateRecord) => {
    const provider = await requireProvider(state.providerId, state.authenticationId);
    if (provider.auth.type !== "oauth2") {
      throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use OAuth2 auth`);
    }
    if (state.oauthIdentityPolicyFingerprint !== oauthIdentityPolicyFingerprint(provider.auth.identity)) {
      throw new ConnectError("setup_invalid", "OAuth identity policy changed; restart authorization");
    }
    let oauthAuth = provider.auth;
    if (state.oauthClientId && !state.oauthClientId.startsWith("legacy:")) {
      const client = await options.oauthClients?.resolveById(state.oauthClientId);
      if (!client || client.id !== state.oauthClientId || client.providerId !== provider.id) {
        throw new ConnectError("setup_invalid", "OAuth Client is unavailable during callback");
      }
      assertOAuthClient(provider.id, state.redirectUri, client);
      assertOAuthClientFingerprint(provider, client.clientId, state.oauthClientFingerprint);
      oauthAuth = {
        ...provider.auth,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      };
    } else {
      assertOAuthClientFingerprint(provider, provider.auth.clientId, state.oauthClientFingerprint);
    }
    return { provider: { ...provider, auth: provider.auth }, oauthAuth };
  };

  const requireMcpSetupHost = () => {
    if (!options.mcpOAuthClients || !options.setupSessions?.getConnectionSetupSessionByReference
      || !options.setupSessions.finishConnectionSetupSession || !options.store.failMcpOAuthSetup
      || !options.store.commitMcpOAuthSetup || !options.store.getOAuthState || !options.store.claimOAuthState
      || !options.store.releaseOAuthState || !options.links || !isVersionedConnectionSecretStore(options.secrets)) {
      throw new ConnectError("setup_invalid", "Host does not support atomic embedded MCP OAuth setup");
    }
  };
  const verifyMcpClient = async (id?: string, fingerprint?: string) => {
    if (!options.mcpOAuthClients || !id || !fingerprint) throw new ConnectError("setup_invalid", "MCP client configuration is unavailable");
    return verifyMcpOAuthSetupClient(options.mcpOAuthClients, { id, fingerprint });
  };
  const setupForMcpState = async (state: OAuthStateRecord) => {
    requireMcpSetupHost();
    const setup = await options.setupSessions!.getConnectionSetupSessionByReference!(state.setupSessionRef!);
    if (!setup || !matchesMcpOAuthSetup(state, setup)) throw new ConnectError("setup_invalid", "MCP setup authorization changed");
    const { client } = await verifyMcpClient(state.oauthClientId, state.oauthClientFingerprint);
    if (state.metadata?.url !== client.resourceUrl || state.metadata?.transport !== client.transport
      || state.metadata?.oauthClientMode !== client.registration.mode || state.redirectUri !== client.redirectUri) {
      throw new ConnectError("setup_invalid", "MCP OAuth state does not match its client configuration");
    }
    return setup;
  };
  const currentMcpMaterial = async (material: McpOAuthSecretMaterial, id?: string, fingerprint?: string) => {
    if (!id && !fingerprint) return material;
    const { client } = await verifyMcpClient(id, fingerprint);
    return client.registration.mode === "pre_registered" ? { ...material, client: client.registration.client } : material;
  };
  const beginMcpOAuth = async (input: StartMcpOAuthInput, setupContext?: {
    reference: string; clientId: string; fingerprint: string; returnUrl: string; authorizationExpiresAt: string;
    onStateWriteAttempt: () => void;
  }): Promise<StartOAuthResult> => {
    if (!options.store.getOAuthState || !options.store.claimOAuthState || !options.store.releaseOAuthState
      || !(setupContext ? options.store.commitMcpOAuthSetup : options.store.commitMcpOAuthConnection)
      || !isVersionedConnectionSecretStore(options.secrets)) {
      throw new ConnectError("setup_invalid", "Host must support atomic MCP OAuth activation and versioned secrets");
    }
    const identity = normalizeCreationIdentity(input);
    const provider = await requireProvider(input.providerId ?? "mcp_url", input.authenticationId);
    if (provider.auth.type !== "mcp") {
      throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use MCP auth`);
    }
    if (provider.authenticationId && provider.auth.auth !== "oauth2") {
      throw new ConnectError("unsupported_auth", "Selected MCP authentication does not support OAuth");
    }
    await authorizeOAuth("authorize", "mcp", { ...input, providerId: provider.id });
    const url = normalizeMcpUrl(input.url, false);
    const transport = input.transport ?? "http";
    const requestedScopes = assertAllowedScopes(provider, input.scopes ?? provider.auth.defaultScopes);
    const state = createOpaqueToken();
    const pendingConnectionId = createId("conn");
    const temporarySecretRef = createId("connsec");
    const started = await mcpOAuth.start({
      url,
      transport,
      redirectUri: input.redirectUri,
      state,
      scopes: requestedScopes,
      mode: input.mode,
      clientName: input.clientName,
      clientUri: input.clientUri,
      clientMetadataUrl: input.clientMetadataUrl,
      preRegisteredClient: input.preRegisteredClient,
      registrationNamespace: setupContext?.fingerprint,
    });
    const createdAt = now();
    const expiresAt = new Date(setupContext?.authorizationExpiresAt ?? createdAt.getTime() + oauthStateTtlMs);
    if (!(expiresAt.getTime() > createdAt.getTime())) throw new ConnectError("setup_expired", "Setup authorization expired during discovery");
    if (setupContext) await verifyMcpClient(setupContext.clientId, setupContext.fingerprint);
    await authorizeOAuth("authorize", "mcp", { ...input, providerId: provider.id });
    await options.secrets.setSecret(temporarySecretRef, {
      kind: "mcp",
      mcpOAuth: started.material,
    });
    try {
      setupContext?.onStateWriteAttempt();
      await options.store.saveOAuthState({
        ...(setupContext ? { setupSessionRef: setupContext.reference, oauthClientId: setupContext.clientId,
          oauthClientFingerprint: setupContext.fingerprint, returnUrl: setupContext.returnUrl } : {}),
        state,
        providerId: provider.id,
        authenticationId: provider.authenticationId,
        flowKind: "mcp",
        status: "pending",
        subject: identity.subject,
        audience: identity.audience,
        binding: identity.binding,
        requestedScopes,
        redirectUri: started.material.redirectUri,
        projectId: input.projectId,
        orgId: input.orgId,
        connectionName: input.name,
        temporarySecretRef,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        metadata: {
          ...omitMcpDiscoveryMetadata(input.metadata),
          url,
          transport,
          auth: "oauth2",
          oauthClientMode: input.mode,
          pendingConnectionId,
        },
      });
    } catch (error) {
      const committed = await options.store.getOAuthState?.(state).catch(() => null);
      if (committed?.status !== "pending" || committed.temporarySecretRef !== temporarySecretRef
        || committed.metadata?.pendingConnectionId !== pendingConnectionId) throw error;
    }
    return { authorizationUrl: started.authorizationUrl, state, expiresAt: expiresAt.toISOString() };
  };

  return {
    listProviders() {
      return registry.list();
    },

    async listCatalog() {
      const custom = await options.definitions?.listConnectorDefinitions() ?? [];
      return [...registry.catalog(), ...custom.filter((record) => !record.disabledAt && !registry.get(record.definition.id))
        .map((record) => describeConnector(record.definition))];
    },

    async getSetupReadiness(input) {
      const provider = await requireProvider(input.providerId, input.authenticationId);
      const catalog = describeConnector(provider);
      const base: ConnectorSetupReadinessResult = {
        providerId: provider.id,
        authenticationId: provider.authenticationId ?? catalog.defaultAuthenticationId,
        check: "configuration", outcome: "passed", code: "ready", checkedAt: now().toISOString(),
        configurationVersion: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
      };
      if (catalog.kind === "credential") return { ...base, outcome: "unsupported", code: "credential_only" };
      if (provider.auth.type === "mcp") {
        return { ...base, outcome: "inconclusive", code: "discovery_required", nextStep: "mcp_discovery" };
      }
      if (provider.auth.type === "none") return { ...base, nextStep: "create" };
      if (provider.auth.type === "api_key") return { ...base, code: "credentials_required", nextStep: "credentials" };
      if (!input.redirectUri) return { ...base, outcome: "failed", code: "callback_required" };
      try {
        const client = await resolveOAuthClient({
          provider, projectId: input.projectId, orgId: input.orgId,
          redirectUri: input.redirectUri, mode: input.oauthClientMode,
        });
        return {
          ...base, code: "consent_required", nextStep: "oauth_consent",
          configurationVersion: createHash("sha256").update(JSON.stringify([
            base.configurationVersion, oauthClientFingerprint(provider, client.clientId), input.redirectUri, input.oauthClientMode,
          ])).digest("hex"),
        };
      } catch (error) {
        return { ...base, outcome: error instanceof ConnectError ? "failed" : "inconclusive",
          code: error instanceof ConnectError ? error.code : "configuration_unavailable" };
      }
    },

    async registerConnectorDefinition(input) {
      if (!options.definitions) throw new ConnectError("setup_invalid", "Custom Connector storage is not configured on this host");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConnectError("invalid_provider", "Connector definition must be an object");
      let definition: ConnectorDefinition;
      try { definition = normalizeConnectorDefinition({ ...input, source: "custom" }); }
      catch (error) {
        if (error instanceof ConnectError) throw error;
        throw new ConnectError("invalid_provider", "Connector definition has an invalid HTTP policy or configuration");
      }
      if (registry.get(definition.id)) throw new ConnectError("invalid_provider", "Connector id is reserved by the host catalog");
      const record = { definition, createdAt: now().toISOString() };
      await options.definitions.createConnectorDefinition(record);
      return record;
    },

    async disableConnectorDefinition(id) {
      if (!options.definitions) throw new ConnectError("setup_invalid", "Custom Connector storage is not configured on this host");
      if (registry.get(id)) throw new ConnectError("invalid_provider", "Host catalog Connectors cannot be disabled through custom registration");
      return options.definitions.disableConnectorDefinition(id, now().toISOString());
    },

    async verifyConnection(input) {
      const connection = await options.store.getConnection(input.connectionId);
      if (!connection) throw new ConnectError("connection_not_found", "Connection not found");
      const provider = await requireProvider(connection.providerId, connection.authenticationId);
      let result = await verifyConnectionProbe(this, input, connection, provider, {
        checkedAt: now().toISOString(),
        configurationVersion: createHash("sha256").update(JSON.stringify([
          describeConnector(provider), provider.authenticationId,
        ])).digest("hex"),
      }, options.verifyMcp ? (probe) => withGatewayDeadline(30_000, probe.signal,
        (signal) => options.verifyMcp!({ ...probe, signal, beforeDispatch: async () => {
          signal.throwIfAborted();
          const current = await assertConnectionCurrent(probe.connection, probe.credential.scopes);
          await options.beforeDispatch?.(current);
          await assertConnectionCurrent(probe.connection, probe.credential.scopes);
          signal.throwIfAborted();
        } })) : undefined);
      const current = await options.store.getConnection(connection.id);
      if (!current || current.status !== connection.status || current.secretRef !== connection.secretRef
        || (current.credentialVersion ?? current.updatedAt) !== result.credentialVersion) {
        result = { ...result, outcome: "inconclusive", code: "connection_changed", account: undefined, toolCount: undefined };
      }
      if (result.outcome === "passed" && result.account) {
        await options.store.updateConnection(connection.id, { providerAccountId: result.account.id });
      }
      await options.verifications?.saveConnectionVerification(result);
      return result;
    },

    listConnections(filter) {
      return options.store.listConnections(filter);
    },

    async listConnectionLinks(filter) {
      if (!options.links) {
        throw new ConnectError("setup_invalid", "Connection link storage is not configured on this host");
      }
      return options.links.listConnectionLinks(filter);
    },

    async linkConnection(input) {
      if (!options.links) {
        throw new ConnectError("setup_invalid", "Connection link storage is not configured on this host");
      }
      const connectionId = requiredText("connectionId", input.connectionId);
      const projectId = requiredText("projectId", input.projectId);
      const connection = await options.store.getConnection(connectionId);
      if (!connection || connection.status !== "active") {
        throw new ConnectError("connection_not_found", `Active Connection not found: ${connectionId}`);
      }
      const existing = (await options.links.listConnectionLinks({ connectionId, projectId }))
        .find((link) => link.status === "active");
      if (existing) return existing;
      const timestamp = now().toISOString();
      return options.links.upsertConnectionLink({
        id: createId("connlink"),
        connectionId,
        projectId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },

    async unlinkConnection(input) {
      if (!options.links) {
        throw new ConnectError("setup_invalid", "Connection link storage is not configured on this host");
      }
      const linkId = requiredText("linkId", input.linkId);
      const link = await options.links.getConnectionLink(linkId);
      if (!link) {
        throw new ConnectError("connection_not_found", `Connection link not found: ${linkId}`);
      }
      if (link.status === "revoked") return link;
      return options.links.updateConnectionLink(linkId, {
        status: "revoked",
        updatedAt: now().toISOString(),
      });
    },

    async createApiKeyConnection(input) {
      const identity = normalizeCreationIdentity(input);
      const provider = await requireProvider(input.providerId, input.authenticationId);
      if (provider.auth.type !== "api_key") {
        throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use API-key auth`);
      }
      const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
      if (!apiKey) {
        throw new ConnectError("invalid_request", "API key cannot be empty");
      }
      const grantedScopes = assertAllowedScopes(provider, input.scopes ?? provider.auth.defaultScopes);
      const id = createId("conn");
      const secretRef = createId("connsec");
      await options.secrets.setSecret(secretRef, {
        kind: "api_key",
        apiKey,
        ...(input.secretMetadata ? { metadata: input.secretMetadata } : {}),
      });
      return persistNewConnection({
        id,
        providerId: provider.id,
        authenticationId: provider.authenticationId,
        name: input.name,
        projectId: input.projectId,
        orgId: input.orgId,
        owner: identity.subject,
        audience: identity.audience,
        binding: identity.binding,
        authType: "api_key",
        status: "active",
        credentialVersion: createId("credver"),
        grantedScopes,
        secretRef,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        metadata: input.metadata,
      });
    },

    async createPublicConnection(input) {
      const identity = normalizeCreationIdentity(input);
      const provider = await requireProvider(input.providerId, input.authenticationId);
      if (provider.auth.type !== "none" || !provider.http) {
        throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not support public HTTP access`);
      }
      const grantedScopes = assertAllowedScopes(provider, input.scopes ?? provider.auth.defaultScopes);
      const timestamp = now().toISOString();
      return options.store.upsertConnection({
        id: createId("conn"), providerId: provider.id, authenticationId: provider.authenticationId,
        name: input.name, projectId: input.projectId, orgId: input.orgId, owner: identity.subject,
        audience: identity.audience, binding: identity.binding,
        authType: "none", status: "active", grantedScopes,
        credentialVersion: createId("credver"),
        createdAt: timestamp, updatedAt: timestamp, metadata: input.metadata,
      });
    },

    async createMcpConnection(input) {
      const identity = normalizeCreationIdentity(input);
      const provider = await requireProvider(input.providerId ?? "mcp_url", input.authenticationId);
      if (provider.auth.type !== "mcp") {
        throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use MCP auth`);
      }

      const transport = input.transport ?? "http";
      if (transport !== "http" && transport !== "sse") {
        throw new ConnectError("invalid_request", "MCP transport must be http or sse");
      }

      const selectedAuth = provider.auth.auth ?? "bearer";
      const auth = input.auth ?? selectedAuth;
      if (provider.authenticationId && auth !== selectedAuth) {
        throw new ConnectError("unsupported_auth", "MCP authentication does not match the selected method");
      }
      if (auth !== "none" && auth !== "bearer" && auth !== "header") {
        throw new ConnectError("unsupported_auth", "MCP OAuth must use the OAuth authorization flow");
      }
      const headerName = auth === "header" ? normalizeConnectorAuthPolicy({
        mode: "header", name: provider.auth.headerName ?? (!provider.authenticationId ? input.headerName : undefined),
      }).name : undefined;

      const url = normalizeMcpUrl(input.url, options.allowInsecureLocalMcpUrls === true);
      const apiKey = (input.bearerToken ?? input.apiKey ?? "").trim();
      if (auth !== "none" && !apiKey) {
        throw new ConnectError("invalid_request", "MCP authenticated access requires a token");
      }

      const grantedScopes = assertAllowedScopes(provider, input.scopes ?? provider.auth.defaultScopes);
      const id = createId("conn");
      const secretRef = auth !== "none" ? createId("connsec") : undefined;
      const metadata: McpConnectionMetadata = {
        ...omitMcpDiscoveryMetadata(input.metadata),
        url,
        transport,
        auth,
        headerName,
      };

      if (secretRef) {
        await options.secrets.setSecret(secretRef, {
          kind: "mcp",
          apiKey,
          metadata: { tokenType: "Bearer" },
        });
      }

      return persistNewConnection({
        id,
        providerId: provider.id,
        authenticationId: provider.authenticationId,
        name: input.name,
        projectId: input.projectId,
        orgId: input.orgId,
        owner: identity.subject,
        audience: identity.audience,
        binding: identity.binding,
        authType: "mcp",
        status: "active",
        credentialVersion: createId("credver"),
        grantedScopes,
        secretRef,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        metadata,
      });
    },

    async inspectMcpOAuth(input) {
      return mcpOAuth.inspect({ url: input.url, transport: input.transport });
    },

    async startMcpOAuth(input) {
      // Private setup context is a separate argument: spreading runtime extras
      // or metadata into direct-start input cannot establish setup authority.
      return beginMcpOAuth(input);
    },

    async completeMcpOAuth(input) {
      const store = options.store;
      if (!store.getOAuthState || !store.claimOAuthState || !store.releaseOAuthState
        || !isVersionedConnectionSecretStore(options.secrets)) {
        throw new ConnectError("setup_invalid", "Host store does not support retry-safe MCP OAuth callbacks");
      }
      const current = await store.getOAuthState(input.state);
      if (!current || current.flowKind !== "mcp") {
        throw new ConnectError("oauth_state_not_found", "MCP OAuth state was not found");
      }
      await authorizeOAuth("callback", "mcp", current);
      const setup = current.setupSessionRef ? await setupForMcpState(current) : undefined;
      if (!setup && !store.commitMcpOAuthConnection) throw new ConnectError("setup_invalid", "Host does not support atomic MCP OAuth activation");
      if (current.status === "completed" && current.completedConnectionId) {
        const completed = await store.getConnection(current.completedConnectionId);
        if (setup) {
          const links = await options.links!.listConnectionLinks({ connectionId: current.completedConnectionId, projectId: setup.projectId, status: "active" });
          if (setup.status !== "completed" || setup.resultingConnectionId !== current.completedConnectionId || !links.length) {
            throw new ConnectError("setup_invalid", "Completed MCP setup link is no longer active");
          }
        }
        if (completed?.status === "active") return completed;
        throw new ConnectError("connection_revoked", "Completed MCP account is no longer active");
      }
      if (new Date(current.expiresAt).getTime() <= now().getTime()) {
        throw new ConnectError("oauth_state_expired", "MCP OAuth state has expired");
      }
      if (setup && connectionSetupState(setup) !== "started") throw new ConnectError("setup_invalid", "MCP setup is no longer active");
      if (!input.error && !input.code) throw new ConnectError("invalid_request", "OAuth callback is missing code");
      const provider = await requireProvider(current.providerId, current.authenticationId);
      if (provider.auth.type !== "mcp" || (provider.authenticationId && provider.auth.auth !== "oauth2")) {
        throw new ConnectError("unsupported_auth", "MCP OAuth authentication is no longer supported");
      }

      const claimToken = createOpaqueToken();
      const claimed = await store.claimOAuthState(
        input.state,
        claimToken,
        new Date(now().getTime() + mcpOAuthCallbackClaimTtlMs).toISOString(),
        now().toISOString(),
      );
      if (!claimed) {
        throw new ConnectError("oauth_callback_in_progress", "MCP OAuth callback is already being processed");
      }
      const pendingConnectionId = typeof claimed.metadata?.pendingConnectionId === "string"
        ? claimed.metadata.pendingConnectionId
        : undefined;
      try {
        if (input.error) {
          if (claimed.setupSessionRef && !await store.failMcpOAuthSetup!({ state: input.state, setupReference: claimed.setupSessionRef,
            claimToken, now: now().toISOString() })) {
            throw new ConnectError("oauth_callback_in_progress", "MCP OAuth callback no longer owns the setup");
          }
          throw new ConnectError("oauth_error", input.errorDescription ?? input.error);
        }
        if (!claimed.temporarySecretRef) {
          throw new ConnectError("secret_not_found", "MCP OAuth transient secret is missing");
        }
        const generation = await options.secrets.getVersioned(claimed.temporarySecretRef);
        const transient = generation?.secret;
        if (!transient?.mcpOAuth) {
          throw new ConnectError("secret_not_found", "MCP OAuth transient material is unavailable");
        }
        // The authorization code is one-time. If persistence failed after
        // exchange, reuse the staged encrypted tokens when retrying the claim.
        await authorizeOAuth("callback", "mcp", claimed);
        const currentMaterial = await currentMcpMaterial(transient.mcpOAuth, claimed.oauthClientId, claimed.oauthClientFingerprint);
        const tokens = transient.mcpOAuth.tokens ?? await mcpOAuth.complete({
          material: currentMaterial,
          code: input.code!,
          requestedScopes: claimed.requestedScopes,
        });
        assertGrantedScopes(tokens.scopes ?? claimed.requestedScopes, claimed.requestedScopes);
        const grantedScopes = assertAllowedScopes(provider, claimed.requestedScopes);
        const material: McpOAuthSecretMaterial = {
          ...currentMaterial,
          codeVerifier: undefined,
          tokens,
        };
        if (!transient.mcpOAuth.tokens && !await options.secrets.compareAndSet(
          claimed.temporarySecretRef, generation!.version, { kind: "mcp", mcpOAuth: material },
        )) throw new ConnectError("oauth_callback_in_progress", "MCP OAuth token generation changed; retry callback");
        // Keep the spent code's result encrypted for retry, but never activate
        // an account when the host disabled OAuth while exchanging/staging it.
        await authorizeOAuth("callback", "mcp", claimed);
        const id = pendingConnectionId ?? createId("conn");
        if (claimed.setupSessionRef) await setupForMcpState(claimed);
        const record: ConnectionRecord = {
          id,
          providerId: claimed.providerId,
          authenticationId: claimed.authenticationId,
          name: claimed.connectionName,
          projectId: claimed.setupSessionRef ? undefined : claimed.projectId,
          oauthClientId: claimed.oauthClientId,
          oauthClientFingerprint: claimed.oauthClientFingerprint,
          orgId: claimed.orgId,
          owner: claimed.subject,
          audience: claimed.audience,
          binding: claimed.binding,
          authType: "mcp",
          status: "active",
          credentialVersion: createId("credver"),
          grantedScopes,
          secretRef: claimed.temporarySecretRef,
          tokenExpiresAt: tokens.expiresAt,
          createdAt: now().toISOString(),
          updatedAt: now().toISOString(),
          metadata: omitInternalMcpStateMetadata(claimed.metadata),
        };
        const commit = { state: input.state, claimToken, now: now().toISOString(), connection: record };
        const connection = claimed.setupSessionRef
          ? await store.commitMcpOAuthSetup!({ ...commit, setupReference: claimed.setupSessionRef,
            link: { id: `connlink_${id}`, connectionId: id, projectId: claimed.projectId!, status: "active",
              createdAt: record.createdAt, updatedAt: record.updatedAt } })
          : await store.commitMcpOAuthConnection!(commit);
        if (!connection) throw new ConnectError("oauth_callback_in_progress", "MCP OAuth claim changed before activation; retry callback");
        return connection;
      } catch (error) {
        const code = error instanceof ConnectError ? error.code : "oauth_error";
        await store.releaseOAuthState(input.state, claimToken, code).catch(() => undefined);
        throw error;
      }
    },

    async createSetupSession(input) {
      if (!options.setupSessions) {
        throw new ConnectError(
          "setup_invalid",
          "Connection setup sessions are not configured on this host",
        );
      }
      const provider = await requireProvider(requiredText("providerId", input.providerId), input.authenticationId);
      const mcp = provider.auth.type === "mcp";
      if (provider.auth.type !== "oauth2" && (!mcp || (provider.authenticationId && provider.auth.type === "mcp" && provider.auth.auth !== "oauth2"))) {
        throw new ConnectError(
          "unsupported_auth",
          `Provider "${provider.id}" does not use OAuth2 auth`,
        );
      }
      const projectId = requiredText("projectId", input.projectId);
      if (mcp) requireMcpSetupHost();
      else if (!options.oauthClients) throw new ConnectError("setup_invalid", "OAuth Clients are not configured");
      await authorizeOAuth("setup", mcp ? "mcp" : "api", { ...input, projectId });
      if (!["personal", "shared", "end_user"].includes(input.audience)) {
        throw new ConnectError("setup_invalid", "Connection setup audience is invalid");
      }
      const identity = normalizeSetupIdentity(input.audience, input.subject, input.binding);
      const returnUrl = normalizeReturnUrl(input.returnUrl, options.allowedReturnUrlOrigins);
      const scopes = assertAllowedScopes(provider, [...(input.scopes ?? provider.auth.defaultScopes ?? []), ...(provider.auth.type === "oauth2" ? provider.auth.identity?.requiredScopes ?? [] : [])]);
      const mcpClient = mcp ? await resolveMcpOAuthSetupClient(options.mcpOAuthClients!, {
        providerId: provider.id, authenticationId: provider.authenticationId, projectId, orgId: input.orgId,
        configurationId: input.configurationId, mode: input.oauthClientMode,
      }) : undefined;
      const client = mcp ? undefined : await resolveOAuthClient({ provider, projectId,
        ...(input.orgId ? { orgId: requiredText("orgId", input.orgId) } : {}), redirectUri: "", mode: input.oauthClientMode });
      if (client && client.redirectUris.length === 0) throw new ConnectError("setup_invalid", "OAuth Client has no registered redirect URI");
      const timestamp = now().toISOString();
      const setup: ConnectionSetupSession = {
        id: createId("connsetup"),
        providerId: provider.id,
        authenticationId: provider.authenticationId,
        ...(mcp ? { flowKind: "mcp" as const } : {}),
        oauthClientId: mcpClient?.reference.id ?? client!.id,
        oauthClientFingerprint: mcpClient?.reference.fingerprint ?? oauthClientFingerprint(provider, client!.clientId),
        oauthIdentityPolicyFingerprint: oauthIdentityPolicyFingerprint(provider.auth.type === "oauth2" ? provider.auth.identity : undefined),
        projectId,
        ...(input.orgId ? { orgId: requiredText("orgId", input.orgId) } : {}),
        audience: input.audience,
        ...identity,
        scopes,
        returnUrl,
        expiresAt: new Date(now().getTime() + setupSessionTtlMs).toISOString(),
        createdAt: timestamp,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      await authorizeOAuth("setup", mcp ? "mcp" : "api", setup);
      await options.setupSessions.saveConnectionSetupSession(setup);
      return setup;
    },

    async getSetupStatus(id) {
      if (!options.setupSessions) throw new ConnectError("setup_invalid", "Connection setup sessions are not configured on this host");
      return observeConnectionSetupSession(options.setupSessions, id, now);
    },

    async cancelSetupSession(id) {
      if (!options.setupSessions) throw new ConnectError("setup_invalid", "Connection setup sessions are not configured on this host");
      return cancelConnectionSetupSession(options.setupSessions, id, now);
    },

    async startOAuthSetup(input) {
      if (!options.setupSessions) {
        throw new ConnectError(
          "setup_invalid",
          "Connection setup sessions are not configured on this host",
        );
      }
      const setupSessionId = requiredText("setupSessionId", input.setupSessionId);
      const existing = await options.setupSessions.getConnectionSetupSession(setupSessionId);
      if (!existing) {
        throw new ConnectError("setup_invalid", "Connection setup session was not found");
      }
      if (existing.consumedAt || connectionSetupState(existing) !== "pending") {
        throw new ConnectError("setup_consumed", "Connection setup session has already been used");
      }
      if (new Date(existing.expiresAt).getTime() <= now().getTime()) {
        throw new ConnectError("setup_expired", "Connection setup session has expired");
      }
      if (existing.flowKind === "mcp") requireMcpSetupHost();
      else if (!options.oauthClients) throw new ConnectError("setup_invalid", "OAuth Clients are not configured");
      await authorizeOAuth("authorize", existing.flowKind === "mcp" ? "mcp" : "api", existing);
      const consumedAt = now();
      const authorizationExpiresAt = new Date(consumedAt.getTime() + oauthStateTtlMs).toISOString();
      const setup = await options.setupSessions.consumeConnectionSetupSession(
        setupSessionId, consumedAt.toISOString(), authorizationExpiresAt,
      );
      if (!setup) {
        if (Date.parse(existing.expiresAt) <= now().getTime()) throw new ConnectError("setup_expired", "Connection setup session has expired");
        throw new ConnectError("setup_consumed", "Connection setup session has already been used");
      }
      let stateWriteAttempted = false;
      try {
        const provider = await requireProvider(setup.providerId, setup.authenticationId);
        if (setup.flowKind === "mcp") {
          if (provider.auth.type !== "mcp") throw new ConnectError("setup_invalid", "MCP Connector changed");
          const { client, reference } = await verifyMcpClient(setup.oauthClientId, setup.oauthClientFingerprint);
          const registration = client.registration;
          return await beginMcpOAuth({ providerId: setup.providerId, authenticationId: setup.authenticationId,
            projectId: setup.projectId, orgId: setup.orgId, audience: setup.audience, subject: setup.subject, binding: setup.binding,
            url: client.resourceUrl, transport: client.transport, redirectUri: client.redirectUri, scopes: setup.scopes,
            mode: registration.mode, metadata: setup.metadata,
            ...(registration.mode === "dynamic" ? { clientName: registration.clientName, clientUri: registration.clientUri }
              : registration.mode === "metadata_document" ? { clientMetadataUrl: registration.clientMetadataUrl }
              : { preRegisteredClient: registration.client }),
          }, { reference: setup.reference ?? setup.id, clientId: reference.id, fingerprint: reference.fingerprint,
            returnUrl: setup.returnUrl, authorizationExpiresAt, onStateWriteAttempt: () => { stateWriteAttempted = true; } });
        }
        if (setup.oauthIdentityPolicyFingerprint !== oauthIdentityPolicyFingerprint(provider.auth.type === "oauth2" ? provider.auth.identity : undefined)) {
          throw new ConnectError("setup_invalid", "OAuth identity policy changed; restart setup");
        }
        const client = await options.oauthClients!.resolveById(setup.oauthClientId);
        if (!client || client.providerId !== provider.id) {
          throw new ConnectError("setup_invalid", "Connection setup OAuth Client is unavailable");
        }
        assertOAuthClientFingerprint(provider, client.clientId, setup.oauthClientFingerprint);
        const identity = normalizeSetupIdentity(setup.audience, setup.subject, setup.binding);
        const redirectUri = client.redirectUris[0];
        return await beginOAuth({
          onStateWriteAttempt: () => { stateWriteAttempted = true; },
          setupSessionRef: setup.reference ?? setup.id,
          authorizationExpiresAt,
          provider,
          client,
          scopes: setup.scopes,
          subject: identity.subject,
          redirectUri,
          projectId: setup.projectId,
          orgId: setup.orgId,
          metadata: setup.metadata,
          audience: setup.audience,
          binding: identity.binding,
          returnUrl: setup.returnUrl,
        });
      } catch (error) {
        // A lost OAuth-state write acknowledgement is not proof no state exists.
        if (!stateWriteAttempted) await options.setupSessions.finishConnectionSetupSession?.(setup.reference ?? setup.id, { status: "error" }, now().toISOString()).catch(() => undefined);
        throw error;
      }
    },

    async startOAuth(input) {
      const provider = await requireProvider(input.providerId, input.authenticationId);
      if (provider.auth.type !== "oauth2") {
        throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use OAuth2 auth`);
      }
      await authorizeOAuth("authorize", "api", input);
      const client = await resolveOAuthClient({
        provider,
        projectId: input.projectId,
        orgId: input.orgId,
        redirectUri: input.redirectUri,
        mode: input.oauthClientMode,
      });
      return beginOAuth({ ...input, provider, client, setupSessionRef: undefined, authorizationExpiresAt: undefined, onStateWriteAttempt: undefined });
    },

    async reconnectOAuth(input) {
      const connection = await options.store.getConnection(input.connectionId);
      if (!connection) throw new ConnectError("connection_not_found", "Connection not found");
      if (connection.authType !== "oauth2") {
        throw new ConnectError("unsupported_auth", "Only OAuth2 Connections can use OAuth reconnect");
      }
      if ((input.orgId && connection.orgId && input.orgId !== connection.orgId)
        || (input.projectId && connection.projectId && input.projectId !== connection.projectId)) {
        throw new ConnectError("policy_denied", "Connection belongs to a different organization or project");
      }
      if (!connection.oauthClientId || connection.oauthClientId.startsWith("legacy:")) {
        throw new ConnectError("setup_invalid", "The original OAuth Client is not recorded; create a new Connection with an explicit OAuth app");
      }
      const provider = await requireProvider(connection.providerId, connection.authenticationId);
      if (provider.auth.type !== "oauth2" || !provider.auth.identity || !connection.oauthIdentity
        || connection.oauthIdentity.policyFingerprint !== oauthIdentityPolicyFingerprint(provider.auth.identity)
        || provider.auth.identity.requiredScopes.some(scope => !connection.grantedScopes.includes(scope))) {
        throw new ConnectError("setup_invalid", "Same-account reconnect requires a verified account identity; create a new Connection");
      }
      if (!options.store.replaceOAuthCredential) {
        throw new ConnectError("setup_invalid", "This host does not support atomic OAuth reconnect");
      }
      if (connection.status !== "active") throw new ConnectError("connection_revoked", "A revoked Connection cannot be reconnected");
      await authorizeOAuth("authorize", "api", { ...connection, connectionId: connection.id,
        projectId: input.projectId ?? connection.projectId, orgId: connection.orgId ?? input.orgId });
      const client = await options.oauthClients?.resolveById(connection.oauthClientId);
      if (!client || client.id !== connection.oauthClientId || client.providerId !== connection.providerId) {
        throw new ConnectError("setup_invalid", "The original OAuth Client is unavailable; restore it or create a new Connection");
      }
      assertOAuthClientFingerprint(provider, client.clientId, connection.oauthClientFingerprint);
      return beginOAuth({
        provider,
        client,
        scopes: connection.grantedScopes,
        subject: connection.owner,
        redirectUri: input.redirectUri,
        projectId: input.projectId ?? connection.projectId,
        orgId: connection.orgId ?? input.orgId,
        connectionName: connection.name,
        audience: connection.audience,
        binding: connection.binding,
        metadata: { ...connection.metadata, ...input.metadata },
        reconnect: snapshotOAuthReconnect(connection),
      });
    },

    async completeOAuth(input) {
      const state = await options.store.consumeOAuthState(input.state);
      if (!state) {
        throw new ConnectError("oauth_state_not_found", "OAuth state was not found or has already been used");
      }
      let credentialWriteAttempted = false;
      try {
        if (new Date(state.expiresAt).getTime() <= now().getTime()) {
          throw new ConnectError("oauth_state_expired", "OAuth state has expired");
        }
        if (input.error) {
          throw new ConnectError("oauth_error", input.errorDescription ?? input.error, {
            details: { error: input.error, errorDescription: input.errorDescription },
          });
        }
        if (!input.code) {
          throw new ConnectError("invalid_request", "OAuth callback is missing code");
        }

        await authorizeOAuth("callback", "api", state);
        const { provider, oauthAuth } = await configurationForOAuthState(state);
        const original = state.reconnect ? await options.store.getConnection(state.reconnect.connectionId) : null;
        if (state.reconnect && (!original || !options.store.replaceOAuthCredential || !matchesOAuthReconnect(original, state.reconnect))) {
          throw new ConnectError("policy_denied", "Connection changed while reconnecting");
        }
        await authorizeOAuth("callback", "api", state);
        const tokenSet = await exchangeCode(
          fetchImpl,
          resolveHostname,
          oauthAuth,
          input.code,
          state.redirectUri,
          state.codeVerifier,
        );
        const tokenScopes = normalizeOAuthTokenScopes(provider.auth, parseScopes(tokenSet.scope, state.requestedScopes));
        // A provider may include grants from a previous consent on the same OAuth
        // app. Record actual token scopes without expanding this Connection.
        assertGrantedScopes(tokenScopes, state.requestedScopes);
        const grantedScopes = assertAllowedScopes(provider, state.requestedScopes);
        await authorizeOAuth("callback", "api", state);
        const oauthIdentity = provider.auth.identity ? await resolveOAuthAccountIdentity(
          { fetch: fetchImpl, resolveHostname }, provider.auth.identity, tokenSet.access_token, now(),
        ) : undefined;
        if (state.reconnect && (!oauthIdentity || !original?.oauthIdentity
          || oauthIdentity.issuer !== original.oauthIdentity.issuer || oauthIdentity.subject !== original.oauthIdentity.subject
          || oauthIdentity.policyFingerprint !== original.oauthIdentity.policyFingerprint)) {
          throw new ConnectError("policy_denied", "The authorized account differs from the original Connection; connect it separately");
        }
        // Recheck changes made while the provider exchange/identity request was in flight.
        // Durable hosts must additionally pin their OAuth Client row in the atomic commit.
        await configurationForOAuthState(state);
        await authorizeOAuth("callback", "api", state);
        const id = createId("conn");
        const secretRef = createId("connsec");
        const tokens = normalizeTokenSet(tokenSet, tokenScopes, now());
        await options.secrets.setSecret(secretRef, { kind: "oauth2", tokens });
        let connection: ConnectionRecord | undefined;
        try {
          if (state.reconnect) {
            const committed: { connection?: ConnectionRecord | null } = {};
            const replacement = {
              secretRef, credentialVersion: createId("credver"), tokenExpiresAt: tokens.expiresAt,
              grantedScopes, oauthClientFingerprint: state.oauthClientFingerprint!, oauthIdentity: oauthIdentity!, updatedAt: now().toISOString(),
            };
            try {
              await refreshCoordinator.runExclusive(state.reconnect.connectionId, async () => {
                await configurationForOAuthState(state);
                await authorizeOAuth("callback", "api", state);
                credentialWriteAttempted = true;
                committed.connection = await options.store.replaceOAuthCredential!(state.reconnect!, replacement);
                // An explicit CAS miss proves this operation did not store its reference.
                if (committed.connection === null) credentialWriteAttempted = false;
              });
            } catch (error) {
              // A coordinator release failure cannot roll back a confirmed commit.
              if (!committed.connection && credentialWriteAttempted) {
                committed.connection = await recoverConnectionWrite({ ...original!, ...replacement });
              }
              if (!committed.connection) throw error;
            }
            const saved = committed.connection;
            if (!saved) throw new ConnectError("policy_denied", "Connection changed while reconnecting");
            // A failed old-secret cleanup cannot undo a committed rotation or invite token exchange replay.
            if (original?.secretRef) await options.secrets.deleteSecret(original.secretRef).catch(() => undefined);
            return saved;
          }
          await configurationForOAuthState(state);
          await authorizeOAuth("callback", "api", state);
          const pendingConnection: ConnectionRecord = {
            id,
            providerId: provider.id,
            authenticationId: provider.authenticationId,
            name: state.connectionName,
            projectId: state.audience ? undefined : state.projectId,
            orgId: state.orgId,
            owner: state.subject,
            audience: state.audience,
            oauthClientId: state.oauthClientId,
            oauthClientFingerprint: state.oauthClientFingerprint,
            oauthIdentity,
            binding: state.binding,
            authType: "oauth2",
            status: "active",
            credentialVersion: createId("credver"),
            grantedScopes,
            secretRef,
            tokenExpiresAt: tokens.expiresAt,
            createdAt: now().toISOString(),
            updatedAt: now().toISOString(),
            metadata: state.metadata,
          };
          const pendingLink: ConnectionLink | undefined = state.audience && state.projectId ? {
            id: createId("connlink"), connectionId: id, projectId: state.projectId, status: "active",
            createdAt: now().toISOString(), updatedAt: now().toISOString(),
          } : undefined;
          if (state.setupSessionRef && pendingLink && options.setupSessions?.prepareConnectionSetupCompletion) {
            const intent = { connection: snapshotOAuthReconnect(pendingConnection),
              link: { id: pendingLink.id, connectionId: id, projectId: pendingLink.projectId } };
            const prepare = () => options.setupSessions!.prepareConnectionSetupCompletion!(state.setupSessionRef!, intent);
            // A committed intent is idempotent; do not start account persistence
            // until its exact private recovery target has been confirmed.
            const prepared = await prepare().catch(() => prepare());
            if (!prepared) throw new ConnectError("setup_invalid", "Connection setup completion intent could not be confirmed");
          }
          credentialWriteAttempted = true;
          connection = await persistNewConnection(pendingConnection);
          if (pendingLink) {
            if (!options.links) {
              throw new ConnectError(
                "setup_invalid",
                "Connection link storage is not configured on this host",
              );
            }
            await options.links.upsertConnectionLink(pendingLink);
          }
          if (state.setupSessionRef && options.setupSessions?.finishConnectionSetupSession) {
            const receipt = await options.setupSessions.finishConnectionSetupSession(state.setupSessionRef,
              { status: "completed", connectionId: connection.id }, now().toISOString()).catch(async error => {
                const recovered = await options.setupSessions?.reconcileConnectionSetupSession?.(state.setupSessionRef!).catch(() => null);
                if (recovered?.status === "completed" && recovered.resultingConnectionId === connection!.id) return recovered;
                throw error;
              });
            if (!receipt) throw new ConnectError("setup_invalid", "Connection setup completion receipt could not be confirmed");
          }
          return connection;
        } catch (error) {
          // Cleanup is safe only before attempting the reference write, or after
          // an explicit CAS miss. Never invalidate a committed account because a
          // later link/acknowledgement failed; that would also race with reconnect.
          if (!credentialWriteAttempted) await options.secrets.deleteSecret(secretRef).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (state.setupSessionRef && !credentialWriteAttempted) {
          await options.setupSessions?.finishConnectionSetupSession?.(state.setupSessionRef, { status: "error" }, now().toISOString()).catch(() => undefined);
        }
        throw error;
      }
    },

    async completeOAuthCallback(input) {
      const state = await options.store.getOAuthState?.(input.state);
      const connection = state?.flowKind === "mcp"
        ? await this.completeMcpOAuth(input)
        : await this.completeOAuth(input);
      return { connection, ...(state?.returnUrl ? { returnUrl: state.returnUrl } : {}) };
    },

    async resolveCredential(input) {
      const connection = await options.store.getConnection(input.connectionId);
      if (!connection) {
        throw new ConnectError("connection_not_found", `Connection not found: ${input.connectionId}`);
      }
      if (connection.status !== "active") {
        throw new ConnectError("connection_revoked", `Connection is not active: ${connection.id}`);
      }

      const provider = await requireProvider(connection.providerId, connection.authenticationId);
      if (connection.oauthIdentity && (provider.auth.type !== "oauth2"
        || connection.oauthIdentity.policyFingerprint !== oauthIdentityPolicyFingerprint(provider.auth.identity))) {
        throw new ConnectError("setup_invalid", "OAuth identity policy changed; create a new Connection");
      }
      if (provider.auth.type !== connection.authType) {
        throw new ConnectError("unsupported_auth", "Connection authentication no longer matches its Connector");
      }
      if (provider.authenticationId && provider.auth.type === "mcp"
        && readMcpAuthMode(connection.metadata) !== (provider.auth.auth ?? "bearer")) {
        throw new ConnectError("unsupported_auth", "Connection MCP authentication no longer matches its Connector");
      }

      const action = input.actionId ? provider.actions?.find((candidate) => candidate.id === input.actionId) : undefined;
      // Hosts may also use actionId as an audit label for a custom tool. Its
      // operation policy remains enforced by that tool's capability/grant.
      const scopes = assertGrantedScopes(connection.grantedScopes, [...(input.scopes ?? []), ...(action?.scopes ?? [])]);
      const allowed = await options.policy?.canUseConnection({
        connection,
        subject: input.subject,
        scopes,
        actionId: input.actionId,
      });
      if (allowed === false) {
        throw new ConnectError("policy_denied", `Connection use denied by policy: ${connection.id}`);
      }
      await authorizeConnection("credential", connection);
      if (connection.authType === "oauth2" && connection.oauthClientFingerprint) {
        await oauthAuthForConnection(provider, connection.oauthClientId, connection.oauthClientFingerprint);
      }
      if (!connection.secretRef) {
        if (!connectionRequiresSecret(connection)) {
          await assertConnectionCurrent(connection, scopes);
          return {
            kind: "none",
            scopes,
            connectionId: connection.id,
            providerId: connection.providerId,
            metadata: connection.metadata,
          };
        }
        throw new ConnectError("secret_not_found", `Connection has no secret reference: ${connection.id}`);
      }

      let secret = await options.secrets.getSecret(connection.secretRef);
      if (!secret) {
        throw new ConnectError("secret_not_found", `Connection secret not found: ${connection.secretRef}`);
      }
      if (secret.kind !== connection.authType) {
        throw new ConnectError("unsupported_auth", "Connection credential kind does not match its authentication");
      }

      if (secret.kind === "api_key") {
        if (!secret.apiKey) throw new ConnectError("token_not_available", "API-key connection secret is empty");
        await assertConnectionCurrent(connection, scopes);
        return {
          kind: "api_key",
          value: secret.apiKey,
          scopes,
          connectionId: connection.id,
          providerId: connection.providerId,
          metadata: connection.metadata,
        };
      }

      if (secret.kind === "mcp") {
        if (secret.mcpOAuth?.tokens?.accessToken) {
          await authorizeConnection("credential", connection, true);
          let material = secret.mcpOAuth;
          if (input.forceRefresh || hasPendingRefresh(secret) || shouldRefresh(material.tokens!, now(), tokenRefreshSkewMs)) {
            const initialTokens = material.tokens!;
            try {
              material = await refreshCoordinator.runExclusive(connection.id, async () => {
                await assertConnectionCurrent(connection, scopes);
                const versionedStore = isVersionedConnectionSecretStore(options.secrets) ? options.secrets : undefined;
                const snapshot = await versionedStore?.getVersioned(connection.secretRef!);
                const latest = snapshot?.secret ?? await options.secrets.getSecret(connection.secretRef!);
                if (latest?.kind !== "mcp" || !latest.mcpOAuth?.tokens?.accessToken) {
                  throw new ConnectError("token_not_available", "MCP OAuth connection secret is empty");
                }
                assertRefreshAvailable(latest);
                const latestTokens = latest.mcpOAuth.tokens;
                if (tokensChanged(initialTokens, latestTokens)
                  || (!input.forceRefresh && !shouldRefresh(latestTokens, now(), tokenRefreshSkewMs))) {
                  return latest.mcpOAuth;
                }
                await authorizeConnection("refresh", connection, true);
                let currentMaterial = latest.mcpOAuth;
                const saved = await refreshConnectionSecret({
                  store: options.secrets, ref: connection.secretRef!, previous: latest, snapshot, now,
                  beforeRefresh: async () => {
                    await assertConnectionCurrent(connection, scopes);
                    await authorizeConnection("refresh", connection, true);
                    currentMaterial = await currentMcpMaterial(latest.mcpOAuth!, connection.oauthClientId, connection.oauthClientFingerprint);
                  },
                  refresh: async () => {
                    const tokens = await mcpOAuth.refresh({
                      material: currentMaterial,
                      fallbackScopes: latestTokens.scopes ?? connection.grantedScopes,
                    });
                    // Versioned stores fence deletion/replacement at commit.
                    // Persist known rotated material before any fallible read.
                    if (!versionedStore) await assertConnectionCurrent(connection, scopes, false);
                    return { ...latest, mcpOAuth: { ...latest.mcpOAuth!, tokens } };
                  },
                });
                // Preserve rotated refresh tokens durably before denying delivery
                // if the host gate changed while the provider request was in flight.
                const current = await assertConnectionCurrent(connection, scopes, false);
                const refreshed = saved.mcpOAuth!;
                const tokens = refreshed.tokens!;
                await options.store.updateConnection(connection.id, {
                  tokenExpiresAt: tokens.expiresAt,
                  grantedScopes: current.grantedScopes.filter((scope) => tokens.scopes?.includes(scope)),
                  updatedAt: now().toISOString(),
                });
                return refreshed;
              });
            } catch (error) {
              if (error instanceof ConnectError && error.code === "refresh_unavailable") {
                await assertConnectionCurrent(connection, scopes, false);
              }
              if (error instanceof ConnectError) throw error;
              throw new ConnectError("refresh_unavailable", "MCP OAuth token refresh could not be coordinated");
            }
          }
          assertGrantedScopes(material.tokens!.scopes ?? connection.grantedScopes, scopes);
          const current = await assertConnectionCurrent(connection, scopes);
          await authorizeConnection("credential", current, true);
          return {
            kind: "mcp",
            accessToken: material.tokens!.accessToken,
            tokenType: material.tokens!.tokenType ?? "Bearer",
            expiresAt: material.tokens!.expiresAt,
            scopes: current.grantedScopes.filter((scope) => (material.tokens!.scopes ?? current.grantedScopes).includes(scope)),
            connectionId: connection.id,
            providerId: connection.providerId,
            metadata: connection.metadata as McpConnectionMetadata | undefined,
          };
        }
        if (!secret.apiKey) throw new ConnectError("token_not_available", "MCP connection secret is empty");
        await assertConnectionCurrent(connection, scopes);
        return {
          kind: "mcp",
          accessToken: secret.apiKey,
          tokenType: readTokenType(secret),
          scopes,
          connectionId: connection.id,
          providerId: connection.providerId,
          metadata: connection.metadata as McpConnectionMetadata | undefined,
        };
      }

      if (secret.kind !== "oauth2" || !secret.tokens?.accessToken) {
        throw new ConnectError("token_not_available", "Connection does not contain an OAuth access token");
      }

      let tokens = secret.tokens;
      if (input.forceRefresh || hasPendingRefresh(secret) || shouldRefresh(tokens, now(), tokenRefreshSkewMs)) {
        const initialTokens = tokens;
        try {
          tokens = await refreshCoordinator.runExclusive(connection.id, async () => {
            await assertConnectionCurrent(connection, scopes);
            const versionedStore = isVersionedConnectionSecretStore(options.secrets)
              ? options.secrets
              : undefined;
            const snapshot = versionedStore
              ? await versionedStore.getVersioned(connection.secretRef!)
              : undefined;
            const latestSecret = snapshot?.secret
              ?? await options.secrets.getSecret(connection.secretRef!);
            if (latestSecret?.kind !== "oauth2" || !latestSecret.tokens?.accessToken) {
              throw new ConnectError(
                "token_not_available",
                "Connection does not contain an OAuth access token",
              );
            }
            assertRefreshAvailable(latestSecret);
            const latestTokens = latestSecret.tokens;
            const refreshedByAnotherCaller = tokensChanged(initialTokens, latestTokens);
            if (
              refreshedByAnotherCaller
              || (!input.forceRefresh && !shouldRefresh(latestTokens, now(), tokenRefreshSkewMs))
            ) {
              secret = latestSecret;
              return latestTokens;
            }

            const provider = await requireProvider(connection.providerId, connection.authenticationId);
            const oauthAuth = await oauthAuthForConnection(provider, connection.oauthClientId, connection.oauthClientFingerprint);
            if (!latestTokens.refreshToken) {
              throw new ConnectError(
                "token_not_available",
                "OAuth access token is expired and no refresh token is available",
              );
            }
            await authorizeConnection("refresh", connection);
            const nextSecret = await refreshConnectionSecret({
              store: options.secrets, ref: connection.secretRef!, previous: latestSecret, snapshot, now,
              beforeRefresh: async () => {
                await assertConnectionCurrent(connection, scopes);
                await authorizeConnection("refresh", connection);
              },
              refresh: async () => {
                const refreshed = await refreshToken(fetchImpl, resolveHostname, oauthAuth, latestTokens.refreshToken!,
                  latestTokens.scopes ?? connection.grantedScopes, now());
                if (!versionedStore) await assertConnectionCurrent(connection, scopes, false);
                return { ...latestSecret, tokens: refreshed };
              },
            });
            const refreshed = nextSecret.tokens!;
            const current = await assertConnectionCurrent(connection, scopes, false);
            secret = nextSecret;
            await options.store.updateConnection(connection.id, {
              tokenExpiresAt: refreshed.expiresAt,
              grantedScopes: current.grantedScopes.filter((scope) => refreshed.scopes?.includes(scope)),
              updatedAt: now().toISOString(),
            });
            return refreshed;
          });
        } catch (error) {
          if (error instanceof ConnectError && error.code === "refresh_unavailable") {
            await assertConnectionCurrent(connection, scopes, false);
          }
          if (error instanceof ConnectError) throw error;
          throw new ConnectError(
            "refresh_unavailable",
            "OAuth token refresh could not be coordinated",
          );
        }
      }

      assertGrantedScopes(tokens.scopes ?? connection.grantedScopes, scopes);
      const current = await assertConnectionCurrent(connection, scopes);
      return {
        kind: "oauth2",
        accessToken: tokens.accessToken,
        tokenType: tokens.tokenType ?? "Bearer",
        expiresAt: tokens.expiresAt,
        scopes: current.grantedScopes.filter((scope) => (tokens.scopes ?? current.grantedScopes).includes(scope)),
        connectionId: connection.id,
        providerId: connection.providerId,
        metadata: connection.metadata,
      };
    },

    async getToken(input) {
      const credential = await this.resolveCredential(input);
      if (credential.kind === "none") {
        throw new ConnectError("token_not_available", "Connection does not require a runtime token");
      }
      if (credential.kind === "api_key") {
        return {
          accessToken: credential.value,
          tokenType: "ApiKey",
          scopes: credential.scopes,
          connectionId: credential.connectionId,
          providerId: credential.providerId,
        };
      }
      if (credential.kind === "mcp") {
        if (!credential.accessToken) {
          throw new ConnectError("token_not_available", "MCP connection does not contain a bearer token");
        }
        return {
          accessToken: credential.accessToken,
          tokenType: credential.tokenType ?? "Bearer",
          scopes: credential.scopes,
          connectionId: credential.connectionId,
          providerId: credential.providerId,
        };
      }
      return {
        accessToken: credential.accessToken,
        tokenType: credential.tokenType,
        expiresAt: credential.expiresAt,
        scopes: credential.scopes,
        connectionId: credential.connectionId,
        providerId: credential.providerId,
      };
    },

    async request<T = unknown>(input: ConnectionGatewayRequestInput): Promise<ConnectionResponse<T>> {
      const connection = await options.store.getConnection(input.connectionId);
      if (!connection) {
        throw new ConnectError("connection_not_found", `Connection not found: ${input.connectionId}`);
      }
      const provider = await requireProvider(connection.providerId, connection.authenticationId);
      if (!provider.http) {
        throw new ConnectError(
          "policy_denied",
          `Provider "${provider.id}" does not expose an HTTP gateway policy`,
        );
      }
      const httpPolicy = provider.http;

      let resolvedRequest;
      try {
        resolvedRequest = resolveConnectorHttpRequest(httpPolicy, input.request);
      } catch (error) {
        if (error instanceof ConnectionSelectionError) {
          throw new ConnectError("policy_denied", error.message, {
            status: error.status,
            details: { code: error.code },
          });
        }
        throw error;
      }
      return withGatewayDeadline(resolvedRequest.timeoutMs, input.signal, async (signal) => {
        const credential = await this.resolveCredential(input);
        const authValue = credential.kind === "api_key"
          ? credential.value
          : credential.kind === "oauth2" || credential.kind === "mcp"
            ? credential.accessToken
            : undefined;
        const tokenType = credential.kind === "oauth2" || credential.kind === "mcp"
          ? credential.tokenType ?? "Bearer"
          : "Bearer";

        let url = new URL(resolvedRequest.url);
        const headers = new Headers(resolvedRequest.headers);
        if (authValue) {
          if (httpPolicy.auth.mode === "bearer") {
            headers.set("authorization", `${tokenType} ${authValue}`);
          } else if (httpPolicy.auth.mode === "header") {
            headers.set(httpPolicy.auth.name!, authValue);
          } else if (httpPolicy.auth.mode === "query") {
            url.searchParams.set(httpPolicy.auth.name!, authValue);
          }
        }
        if (resolvedRequest.idempotencyKey) {
          headers.set("idempotency-key", resolvedRequest.idempotencyKey);
        }
        const body = resolvedRequest.body === undefined
          ? undefined
          : JSON.stringify(resolvedRequest.body);
        if (body !== undefined && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }

        const authorizeSend = async () => {
          await assertConnectionCurrent(connection, credential.scopes);
          try {
            await input.authorizeDispatch?.();
          } catch (error) {
            if (error instanceof ConnectError) throw error;
            throw new ConnectError("policy_denied", "Invocation authorization is no longer available", {
              status: error instanceof ConnectionSelectionError ? error.status : 503,
              ...(error instanceof ConnectionSelectionError ? { details: { code: error.code } } : {}),
            });
          }
        };
        for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
          signal.throwIfAborted();
          await assertPublicDns(url.hostname, resolveHostname);
          signal.throwIfAborted();
          await authorizeSend();
          signal.throwIfAborted();
          if (input.beforeDispatch || options.beforeDispatch) {
            if (input.beforeDispatch) await input.beforeDispatch({ method: resolvedRequest.method });
            else await options.beforeDispatch!(connection);
            // Waiting on a distributed quota is an authorization boundary too.
            // A revoked grant/account must not send previously resolved headers.
            await authorizeSend();
          }
          signal.throwIfAborted();
          const response = await fetchImpl(url, {
            method: resolvedRequest.method,
            headers,
            body,
            redirect: "manual",
            signal,
          });

          if (response.status >= 300 && response.status < 400) {
            void response.body?.cancel().catch(() => undefined);
            const location = response.headers.get("location");
            if (!location) {
              throw new ConnectError("http_error", "Provider returned a redirect without a location");
            }
            if (redirectCount === 3) {
              throw new ConnectError("http_error", "Provider exceeded the Connector redirect limit");
            }
            if (
              resolvedRequest.method !== "GET"
              && resolvedRequest.method !== "HEAD"
              && response.status !== 307
              && response.status !== 308
            ) {
              throw new ConnectError(
                "http_error",
                "Provider attempted an unsafe method-changing redirect",
              );
            }
            try {
              url = new URL(assertConnectorRedirectAllowed(
                httpPolicy,
                new URL(location, url).toString(),
              ));
            } catch (error) {
              if (error instanceof ConnectionSelectionError) {
                throw new ConnectError("http_error", "Provider redirect was denied by policy", {
                  details: { category: "redirect_denied" },
                });
              }
              throw error;
            }
            continue;
          }

          const responseBytes = await readResponseBytes(response, resolvedRequest.maxResponseBytes, signal);
          const responseHeaders = sanitizedResponseHeaders(response.headers);
          const requestId = response.headers.get("x-request-id")
            ?? response.headers.get("request-id")
            ?? undefined;
          return {
            status: response.status,
            headers: Object.freeze(responseHeaders),
            body: parseResponseBody<T>(responseBytes, response.headers.get("content-type")),
            ...(requestId ? { requestId } : {}),
          };
        }
        throw new ConnectError("http_error", "Provider request did not produce a response");
      });
    },

    async revokeConnection(input) {
      const connection = await options.store.getConnection(input.connectionId);
      if (!connection) {
        throw new ConnectError("connection_not_found", `Connection not found: ${input.connectionId}`);
      }
      // Deny new use before touching the vault. Retain the ref until deletion
      // succeeds so a transient vault failure can be retried safely.
      await options.store.updateConnection(connection.id, {
        status: "revoked",
        updatedAt: now().toISOString(),
      });
      if (connection.secretRef) {
        await options.secrets.deleteSecret(connection.secretRef);
      }
      return options.store.updateConnection(connection.id, {
        status: "revoked",
        secretRef: undefined,
        updatedAt: now().toISOString(),
      });
    },
  };
}

function tokensChanged(before: TokenSet, after: TokenSet): boolean {
  return before.accessToken !== after.accessToken
    || before.refreshToken !== after.refreshToken
    || before.expiresAt !== after.expiresAt;
}

function oauthClientFingerprint(provider: ConnectorProviderDefinition, clientId: string | undefined): string {
  if (provider.auth.type !== "oauth2" || !clientId) {
    throw new ConnectError("setup_invalid", "OAuth Client registration is unavailable; reconnect the Connection");
  }
  return createHash("sha256").update(JSON.stringify([
    provider.id, provider.authenticationId ?? null, clientId,
    provider.auth.authorizationUrl, provider.auth.tokenUrl,
  ])).digest("hex");
}

function assertOAuthClientFingerprint(provider: ConnectorProviderDefinition, clientId: string | undefined, expected: string | undefined): void {
  if (expected && oauthClientFingerprint(provider, clientId) !== expected) {
    throw new ConnectError("setup_invalid", "OAuth Client registration changed; reconnect the Connection");
  }
}

function assertOAuthClient(
  providerId: string,
  redirectUri: string,
  client: ResolvedOAuthClient,
): void {
  if (
    !client
    || client.providerId !== providerId
    || typeof client.clientId !== "string"
    || !client.clientId.trim()
  ) {
    throw new ConnectError("invalid_provider", "OAuth Client does not match Connector");
  }
  if (!client.redirectUris.includes(redirectUri)) {
    throw new ConnectError(
      "invalid_request",
      "OAuth redirect URI is not registered for the selected OAuth Client",
    );
  }
}

function requiredText(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new ConnectError("setup_invalid", `Connection setup ${name} is invalid`);
  }
  return value.trim();
}

function normalizeReturnUrl(
  value: string,
  allowedOrigins: readonly string[] | undefined,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectError("setup_invalid", "Connection setup return URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || !allowedOrigins?.includes(url.origin)
  ) {
    throw new ConnectError(
      "setup_invalid",
      "Connection setup return URL is not on an allowed HTTPS origin",
    );
  }
  return url.toString();
}

function normalizeCreationIdentity(input: ConnectionCreationContext): ConnectionCreationContext & { audience: ConnectionAudience } {
  const audience = input.audience === undefined ? "shared" : input.audience;
  if (!["personal", "shared", "end_user"].includes(audience)) {
    throw new ConnectError("setup_invalid", "Connection audience is invalid");
  }
  // Agent-owned static credentials predate audience selection. Preserve that
  // explicit shared ownership, without allowing it to satisfy a user audience.
  if (audience === "shared" && input.subject?.type === "agent") {
    const subject = { type: "agent" as const, id: requiredText("owner.id", input.subject.id) };
    return { audience, subject, ...(input.binding === undefined ? {} : { binding: normalizeConnectionBinding(input.binding) }) };
  }
  if (input.subject !== undefined || audience !== "shared") {
    return { audience, ...normalizeSetupIdentity(audience, input.subject!, input.binding) };
  }
  return { audience, ...(input.binding === undefined ? {} : { binding: normalizeConnectionBinding(input.binding) }) };
}

/** Inventory is host-observed evidence, never caller-authored configuration. */
function omitMcpDiscoveryMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const { discoveredTools: _tools, lastDiscoveredAt: _timestamp, ...rest } = metadata ?? {};
  return rest;
}

function normalizeSetupIdentity(
  audience: ConnectionAudience,
  owner: ConnectionOwner,
  suppliedBinding?: ConnectionBindingAttributes,
): { subject: ConnectionOwner; binding?: ConnectionBindingAttributes } {
  const subject = normalizeConnectionOwner(owner);
  const binding = suppliedBinding === undefined ? undefined : normalizeConnectionBinding(suppliedBinding);
  const principalType = audience === "end_user" ? "external_user" : audience === "personal" ? "user" : undefined;
  if (!principalType) return { subject, ...(binding ? { binding } : {}) };
  if (subject.type !== principalType) throw new ConnectError("setup_invalid", "Connection setup subject does not match its audience");
  const principal = { type: principalType, id: subject.id,
    ...(subject.type === "external_user" ? { namespace: subject.namespace } : {}) };
  if (binding?.principal && (binding.principal.type !== principal.type || binding.principal.id !== principal.id
    || (binding.principal.namespace !== undefined && binding.principal.namespace !== principal.namespace))) {
    throw new ConnectError("setup_invalid", "Connection setup binding does not match its subject");
  }
  return { subject, binding: { ...binding, principal } };
}

function normalizeConnectionOwner(owner: ConnectionOwner): ConnectionOwner {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw new ConnectError("setup_invalid", "Connection setup owner is invalid");
  }
  const record = owner as unknown as Record<string, unknown>;
  const allowed = record.type === "external_user"
    ? ["type", "namespace", "id"]
    : ["type", "id"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new ConnectError("setup_invalid", "Connection setup owner has unsupported fields");
  }
  if (!["user", "project", "org", "external_user", "service"].includes(String(record.type))) {
    throw new ConnectError("setup_invalid", "Connection setup owner type is invalid");
  }
  const id = requiredText("owner.id", record.id);
  if (record.type === "external_user") {
    return {
      type: "external_user",
      namespace: requiredText("owner.namespace", record.namespace),
      id,
    };
  }
  return { type: record.type as "user" | "project" | "org" | "service", id };
}

function normalizeConnectionBinding(
  binding: ConnectionBindingAttributes,
): ConnectionBindingAttributes {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new ConnectError("setup_invalid", "Connection setup binding is invalid");
  }
  const unsupported = Object.keys(binding).filter((key) =>
    !["principal", "tenant", "resource", "scopeEpoch"].includes(key));
  if (unsupported.length > 0) {
    throw new ConnectError("setup_invalid", "Connection setup binding has unsupported fields");
  }
  const normalizePart = (
    name: string,
    value: Record<string, unknown> | undefined,
    fields: readonly string[],
    optionalFields: readonly string[] = [],
  ): Record<string, string> | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ConnectError("setup_invalid", `Connection setup binding ${name} is invalid`);
    }
    if (Object.keys(value).some((key) => !fields.includes(key) && !optionalFields.includes(key))) {
      throw new ConnectError(
        "setup_invalid",
        `Connection setup binding ${name} has unsupported fields`,
      );
    }
    return Object.fromEntries([...fields, ...optionalFields.filter(field => value[field] !== undefined)].map((field) => [
      field,
      requiredText(`binding.${name}.${field}`, value[field]),
    ]));
  };
  return {
    ...(binding.principal !== undefined ? {
      principal: normalizePart(
        "principal",
        binding.principal as unknown as Record<string, unknown>,
        ["type", "id"],
        ["namespace"],
      ) as ConnectionBindingAttributes["principal"],
    } : {}),
    ...(binding.tenant !== undefined ? {
      tenant: normalizePart(
        "tenant",
        binding.tenant as unknown as Record<string, unknown>,
        ["namespace", "id"],
      ) as ConnectionBindingAttributes["tenant"],
    } : {}),
    ...(binding.resource !== undefined ? {
      resource: normalizePart(
        "resource",
        binding.resource as unknown as Record<string, unknown>,
        ["namespace", "type", "id"],
      ) as ConnectionBindingAttributes["resource"],
    } : {}),
    ...(binding.scopeEpoch === undefined
      ? {}
      : { scopeEpoch: requiredText("binding.scopeEpoch", binding.scopeEpoch) }),
  };
}

async function assertPublicDns(
  hostname: string,
  resolveHostname: (hostname: string) => Promise<readonly string[]>,
): Promise<void> {
  let addresses: readonly string[];
  try {
    addresses = await resolveHostname(hostname);
  } catch {
    throw new ConnectError("http_error", "Provider hostname could not be resolved", {
      details: { category: "dns_failed" },
    });
  }
  if (addresses.length === 0 || addresses.some(connectorHostnameIsUnsafe)) {
    throw new ConnectError("http_error", "Provider hostname resolved to a forbidden network", {
      details: { category: "network_denied" },
    });
  }
}

async function withGatewayDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const aborted = () => new ConnectError("http_error", "Provider request was aborted or timed out", {
    details: { category: "aborted", retryable: true },
  });
  if (signal?.aborted) throw aborted();
  const controller = new AbortController();
  let rejectAbort: (reason: unknown) => void;
  const deadline = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { controller.abort(); rejectAbort(aborted()); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(onAbort, timeoutMs);
  try {
    return await Promise.race([deadline, run(controller.signal)]);
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    if (controller.signal.aborted) throw aborted();
    throw new ConnectError("http_error", "Provider request failed", {
      details: { category: "transport_failed", retryable: true },
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readResponseBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    void response.body?.cancel().catch(() => undefined);
    throw new ConnectError("http_error", "Provider response exceeds the Connector limit", {
      details: { category: "response_too_large" },
    });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); signal.throwIfAborted(); }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ConnectError("http_error", "Provider response exceeds the Connector limit", {
          details: { category: "response_too_large" },
        });
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function parseResponseBody<T>(bytes: Uint8Array, contentType: string | null): T {
  if (bytes.byteLength === 0) return null as T;
  const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedType === "application/json" || normalizedType?.endsWith("+json")) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
      throw new ConnectError("http_error", "Provider returned malformed JSON", {
        details: { category: "invalid_response" },
      });
    }
  }
  if (normalizedType?.startsWith("text/") || normalizedType === undefined) {
    return new TextDecoder().decode(bytes) as T;
  }
  return {
    encoding: "base64",
    contentType: normalizedType ?? "application/octet-stream",
    data: Buffer.from(bytes).toString("base64"),
  } as T;
}

function sanitizedResponseHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization"
      || normalized === "proxy-authorization"
      || normalized === "set-cookie"
      || normalized === "cookie"
    ) continue;
    safe[normalized] = value;
  }
  return safe;
}

async function exchangeCode(fetchImpl: typeof fetch, resolveHostname: CreateConnectServiceOptions["resolveHostname"] & {}, auth: OAuth2AuthConfig, code: string, redirectUri: string, codeVerifier?: string): Promise<ProviderTokenResponse> {
  return requestOAuthToken({ fetch: fetchImpl, resolveHostname }, auth.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    code_verifier: codeVerifier,
    ...auth.extraTokenParams,
  });
}

async function refreshToken(fetchImpl: typeof fetch, resolveHostname: CreateConnectServiceOptions["resolveHostname"] & {}, auth: OAuth2AuthConfig, refreshTokenValue: string, fallbackScopes: string[], now: Date): Promise<TokenSet> {
  const tokenSet = await requestOAuthToken({ fetch: fetchImpl, resolveHostname }, auth.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    ...auth.extraTokenParams,
  });
  return normalizeTokenSet(tokenSet, normalizeOAuthTokenScopes(auth, parseScopes(tokenSet.scope, fallbackScopes)), now, refreshTokenValue);
}

function normalizeTokenSet(payload: ProviderTokenResponse, scopes: string[], now: Date, fallbackRefreshToken?: string): TokenSet {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? fallbackRefreshToken,
    tokenType: payload.token_type ?? "Bearer",
    expiresAt: typeof payload.expires_in === "number" ? new Date(now.getTime() + payload.expires_in * 1000).toISOString() : undefined,
    scopes: normalizeScopes(scopes),
    raw: payload,
  };
}

function shouldRefresh(tokens: TokenSet, now: Date, skewMs: number): boolean {
  if (!tokens.expiresAt) return false;
  return new Date(tokens.expiresAt).getTime() - skewMs <= now.getTime();
}

function normalizeMcpUrl(input: string, allowInsecureLocal: boolean): string {
  const value = input.trim();
  if (!value) {
    throw new ConnectError("invalid_request", "MCP server URL is required");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectError("invalid_request", "MCP server URL must be absolute");
  }
  if (url.username || url.password) {
    throw new ConnectError("invalid_request", "MCP server URL cannot contain inline credentials");
  }
  if (url.protocol === "https:") return url.toString();
  if (allowInsecureLocal && url.protocol === "http:" && isLocalHost(url.hostname)) {
    return url.toString();
  }
  throw new ConnectError("invalid_request", "MCP server URL must use HTTPS");
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
}

function readMcpAuthMode(metadata: Record<string, unknown> | undefined): McpConnectionAuth {
  if (metadata?.auth === "none") return "none";
  if (metadata?.auth === "oauth2") return "oauth2";
  if (metadata?.auth === "header") return "header";
  return "bearer";
}

function omitInternalMcpStateMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const { pendingConnectionId: _pendingConnectionId, ...publicMetadata } = omitMcpDiscoveryMetadata(metadata);
  return publicMetadata;
}

function readTokenType(secret: StoredConnectionSecret): string {
  const tokenType = secret.metadata?.tokenType;
  return typeof tokenType === "string" && tokenType.trim() ? tokenType.trim() : "Bearer";
}

function createId(prefix: string): string {
  return `${prefix}_${createOpaqueToken(18)}`;
}
