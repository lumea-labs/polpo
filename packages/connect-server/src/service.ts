import {
  ConnectError,
  assertConnectorRedirectAllowed,
  assertAllowedScopes,
  assertGrantedScopes,
  connectorHostnameIsUnsafe,
  createConnectorRegistry,
  normalizeScopes,
  resolveConnectorHttpRequest,
  type ConnectPolicy,
  type ConnectStore,
  type ConnectSubject,
  type ConnectionAudience,
  type ConnectionBindingAttributes,
  type ConnectionLinkStore,
  type ConnectionLink,
  type ConnectionLinkListFilter,
  type ConnectionOwner,
  type ConnectionRecord,
  type ConnectionSetupSession,
  type ConnectionSetupSessionStore,
  type ConnectorProviderDefinition,
  type McpConnectionAuth,
  type McpConnectionMetadata,
  type McpConnectionTransport,
  type OAuth2AuthConfig,
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
import {
  MemoryTokenRefreshCoordinator,
  isVersionedConnectionSecretStore,
  type ConnectionSecretStore,
  type TokenRefreshCoordinator,
} from "./secrets.js";
import { createOpaqueToken, createPkcePair, parseScopes, toFormBody } from "./oauth.js";

export interface CreateConnectServiceOptions {
  providers: readonly ConnectorProviderDefinition[];
  store: ConnectStore;
  secrets: ConnectionSecretStore;
  policy?: ConnectPolicy;
  fetch?: typeof fetch;
  now?: () => Date;
  tokenRefreshSkewMs?: number;
  oauthStateTtlMs?: number;
  allowInsecureLocalMcpUrls?: boolean;
  refreshCoordinator?: TokenRefreshCoordinator;
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  oauthClients?: OAuthClientResolver;
  setupSessions?: ConnectionSetupSessionStore;
  links?: ConnectionLinkStore;
  setupSessionTtlMs?: number;
  allowedReturnUrlOrigins?: readonly string[];
}

export interface CreateApiKeyConnectionInput {
  providerId: string;
  apiKey: string;
  scopes?: string[];
  subject?: ConnectSubject;
  name?: string;
  projectId?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
  secretMetadata?: Record<string, unknown>;
}

export interface CreateMcpConnectionInput {
  providerId?: string;
  name?: string;
  url: string;
  transport?: McpConnectionTransport;
  auth?: McpConnectionAuth;
  apiKey?: string;
  bearerToken?: string;
  scopes?: string[];
  subject?: ConnectSubject;
  projectId?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
}

export interface StartOAuthInput {
  providerId: string;
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
}

export interface CreateConnectionSetupSessionInput {
  providerId: string;
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
  listConnections(filter?: Parameters<ConnectStore["listConnections"]>[0]): Promise<ConnectionRecord[]>;
  listConnectionLinks(filter?: ConnectionLinkListFilter): Promise<ConnectionLink[]>;
  linkConnection(input: LinkConnectionInput): Promise<ConnectionLink>;
  unlinkConnection(input: UnlinkConnectionInput): Promise<ConnectionLink>;
  createApiKeyConnection(input: CreateApiKeyConnectionInput): Promise<ConnectionRecord>;
  createMcpConnection(input: CreateMcpConnectionInput): Promise<ConnectionRecord>;
  createSetupSession(input: CreateConnectionSetupSessionInput): Promise<ConnectionSetupSession>;
  startOAuthSetup(input: StartOAuthSetupInput): Promise<StartOAuthResult>;
  startOAuth(input: StartOAuthInput): Promise<StartOAuthResult>;
  completeOAuth(input: CompleteOAuthInput): Promise<ConnectionRecord>;
  resolveCredential(input: ResolveConnectionCredentialInput): Promise<ResolvedConnectionCredential>;
  getToken(input: GetTokenInput): Promise<RuntimeToken>;
  request<T = unknown>(input: ConnectionGatewayRequestInput): Promise<ConnectionResponse<T>>;
  revokeConnection(input: RevokeConnectionInput): Promise<ConnectionRecord>;
}

export function createConnectService(options: CreateConnectServiceOptions): ConnectService {
  const registry = createConnectorRegistry(options.providers);
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const tokenRefreshSkewMs = options.tokenRefreshSkewMs ?? 60_000;
  const oauthStateTtlMs = options.oauthStateTtlMs ?? 10 * 60_000;
  const setupSessionTtlMs = options.setupSessionTtlMs ?? 10 * 60_000;
  const refreshCoordinator = options.refreshCoordinator ?? new MemoryTokenRefreshCoordinator();
  const resolveHostname = options.resolveHostname ?? (async (hostname: string) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));

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
      input.scopes ?? auth.defaultScopes,
    );
    const state = createOpaqueToken();
    const pkce = auth.supportsPkce === false ? undefined : createPkcePair();
    const expiresAt = new Date(now().getTime() + oauthStateTtlMs).toISOString();
    await options.store.saveOAuthState({
      state,
      providerId: input.provider.id,
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
  ): Promise<OAuth2AuthConfig> => {
    if (provider.auth.type !== "oauth2") {
      throw new ConnectError(
        "unsupported_auth",
        `Provider "${provider.id}" does not use OAuth2 auth`,
      );
    }
    if (!oauthClientId || oauthClientId.startsWith("legacy:")) return provider.auth;
    const client = await options.oauthClients?.resolveById(oauthClientId);
    if (!client || client.providerId !== provider.id) {
      throw new ConnectError(
        "refresh_unavailable",
        "OAuth Client is unavailable during token refresh",
      );
    }
    return {
      ...provider.auth,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
    };
  };

  return {
    listProviders() {
      return registry.list();
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
      const provider = registry.require(input.providerId);
      if (provider.auth.type !== "api_key") {
        throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use API-key auth`);
      }
      const apiKey = input.apiKey.trim();
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
      return options.store.upsertConnection({
        id,
        providerId: provider.id,
        name: input.name,
        projectId: input.projectId,
        orgId: input.orgId,
        owner: input.subject,
        authType: "api_key",
        status: "active",
        grantedScopes,
        secretRef,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        metadata: input.metadata,
      });
    },

    async createMcpConnection(input) {
      const provider = registry.require(input.providerId ?? "mcp_url");
      if (provider.auth.type !== "mcp") {
        throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use MCP auth`);
      }

      const transport = input.transport ?? "http";
      if (transport !== "http" && transport !== "sse") {
        throw new ConnectError("invalid_request", "MCP transport must be http or sse");
      }

      const auth = input.auth ?? (provider.auth.auth === "none" ? "none" : "bearer");
      if (auth !== "none" && auth !== "bearer") {
        throw new ConnectError("invalid_request", "MCP auth must be none or bearer");
      }

      const url = normalizeMcpUrl(input.url, options.allowInsecureLocalMcpUrls === true);
      const apiKey = (input.bearerToken ?? input.apiKey ?? "").trim();
      if (auth === "bearer" && !apiKey) {
        throw new ConnectError("invalid_request", "MCP bearer auth requires a token");
      }

      const grantedScopes = assertAllowedScopes(provider, input.scopes ?? provider.auth.defaultScopes);
      const id = createId("conn");
      const secretRef = auth === "bearer" ? createId("connsec") : undefined;
      const metadata: McpConnectionMetadata = {
        ...(input.metadata ?? {}),
        url,
        transport,
        auth,
      };

      if (secretRef) {
        await options.secrets.setSecret(secretRef, {
          kind: "mcp",
          apiKey,
          metadata: { tokenType: "Bearer" },
        });
      }

      return options.store.upsertConnection({
        id,
        providerId: provider.id,
        name: input.name,
        projectId: input.projectId,
        orgId: input.orgId,
        owner: input.subject,
        authType: "mcp",
        status: "active",
        grantedScopes,
        secretRef,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        metadata,
      });
    },

    async createSetupSession(input) {
      if (!options.setupSessions || !options.oauthClients) {
        throw new ConnectError(
          "setup_invalid",
          "Connection setup sessions are not configured on this host",
        );
      }
      const provider = registry.require(requiredText("providerId", input.providerId));
      if (provider.auth.type !== "oauth2") {
        throw new ConnectError(
          "unsupported_auth",
          `Provider "${provider.id}" does not use OAuth2 auth`,
        );
      }
      const projectId = requiredText("projectId", input.projectId);
      if (!["personal", "shared", "end_user"].includes(input.audience)) {
        throw new ConnectError("setup_invalid", "Connection setup audience is invalid");
      }
      const returnUrl = normalizeReturnUrl(input.returnUrl, options.allowedReturnUrlOrigins);
      const scopes = assertAllowedScopes(provider, input.scopes ?? provider.auth.defaultScopes);
      const client = await resolveOAuthClient({
        provider,
        projectId,
        ...(input.orgId ? { orgId: requiredText("orgId", input.orgId) } : {}),
        redirectUri: "",
        mode: input.oauthClientMode,
      });
      if (client.redirectUris.length === 0) {
        throw new ConnectError("setup_invalid", "OAuth Client has no registered redirect URI");
      }
      const timestamp = now().toISOString();
      const setup: ConnectionSetupSession = {
        id: createId("connsetup"),
        providerId: provider.id,
        oauthClientId: client.id,
        projectId,
        ...(input.orgId ? { orgId: requiredText("orgId", input.orgId) } : {}),
        audience: input.audience,
        subject: normalizeConnectionOwner(input.subject),
        ...(input.binding ? { binding: normalizeConnectionBinding(input.binding) } : {}),
        scopes,
        returnUrl,
        expiresAt: new Date(now().getTime() + setupSessionTtlMs).toISOString(),
        createdAt: timestamp,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      await options.setupSessions.saveConnectionSetupSession(setup);
      return setup;
    },

    async startOAuthSetup(input) {
      if (!options.setupSessions || !options.oauthClients) {
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
      if (existing.consumedAt) {
        throw new ConnectError("setup_consumed", "Connection setup session has already been used");
      }
      if (new Date(existing.expiresAt).getTime() <= now().getTime()) {
        throw new ConnectError("setup_expired", "Connection setup session has expired");
      }
      const setup = await options.setupSessions.consumeConnectionSetupSession(
        setupSessionId,
        now().toISOString(),
      );
      if (!setup) {
        throw new ConnectError("setup_consumed", "Connection setup session has already been used");
      }
      const provider = registry.require(setup.providerId);
      const client = await options.oauthClients.resolveById(setup.oauthClientId);
      if (!client || client.providerId !== provider.id) {
        throw new ConnectError("setup_invalid", "Connection setup OAuth Client is unavailable");
      }
      const redirectUri = client.redirectUris[0];
      return beginOAuth({
        provider,
        client,
        scopes: setup.scopes,
        subject: setup.subject,
        redirectUri,
        projectId: setup.projectId,
        orgId: setup.orgId,
        metadata: setup.metadata,
        audience: setup.audience,
        binding: setup.binding,
        returnUrl: setup.returnUrl,
      });
    },

    async startOAuth(input) {
      const provider = registry.require(input.providerId);
      if (provider.auth.type !== "oauth2") {
        throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use OAuth2 auth`);
      }
      const client = await resolveOAuthClient({
        provider,
        projectId: input.projectId,
        orgId: input.orgId,
        redirectUri: input.redirectUri,
        mode: input.oauthClientMode,
      });
      return beginOAuth({ ...input, provider, client });
    },

    async completeOAuth(input) {
      const state = await options.store.consumeOAuthState(input.state);
      if (!state) {
        throw new ConnectError("oauth_state_not_found", "OAuth state was not found or has already been used");
      }
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

      const provider = registry.require(state.providerId);
      if (provider.auth.type !== "oauth2") {
        throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use OAuth2 auth`);
      }
      let oauthAuth = provider.auth;
      if (state.oauthClientId && !state.oauthClientId.startsWith("legacy:")) {
        const client = await options.oauthClients?.resolveById(state.oauthClientId);
        if (!client || client.providerId !== provider.id) {
          throw new ConnectError("setup_invalid", "OAuth Client is unavailable during callback");
        }
        assertOAuthClient(provider.id, state.redirectUri, client);
        oauthAuth = {
          ...provider.auth,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
        };
      }
      const tokenSet = await exchangeCode(
        fetchImpl,
        oauthAuth,
        input.code,
        state.redirectUri,
        state.codeVerifier,
      );
      const grantedScopes = assertAllowedScopes(provider, parseScopes(tokenSet.scope, state.requestedScopes));
      assertGrantedScopes(grantedScopes, state.requestedScopes);
      const id = createId("conn");
      const secretRef = createId("connsec");
      const tokens = normalizeTokenSet(tokenSet, grantedScopes, now());
      await options.secrets.setSecret(secretRef, { kind: "oauth2", tokens });
      let connection: ConnectionRecord | undefined;
      try {
        connection = await options.store.upsertConnection({
        id,
        providerId: provider.id,
        name: state.connectionName,
        projectId: state.audience ? undefined : state.projectId,
        orgId: state.orgId,
        owner: state.subject,
        audience: state.audience,
        oauthClientId: state.oauthClientId,
        binding: state.binding,
        authType: "oauth2",
        status: "active",
        grantedScopes,
        secretRef,
        tokenExpiresAt: tokens.expiresAt,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        metadata: state.metadata,
        });
        if (state.audience && state.projectId) {
          if (!options.links) {
            throw new ConnectError(
              "setup_invalid",
              "Connection link storage is not configured on this host",
            );
          }
          await options.links.upsertConnectionLink({
            id: createId("connlink"),
            connectionId: connection.id,
            projectId: state.projectId,
            status: "active",
            createdAt: now().toISOString(),
            updatedAt: now().toISOString(),
          });
        }
        return connection;
      } catch (error) {
        await options.secrets.deleteSecret(secretRef).catch(() => undefined);
        if (connection) {
          await options.store.updateConnection(connection.id, {
            status: "error",
            secretRef: undefined,
            updatedAt: now().toISOString(),
          }).catch(() => undefined);
        }
        throw error;
      }
    },

    async resolveCredential(input) {
      const connection = await options.store.getConnection(input.connectionId);
      if (!connection) {
        throw new ConnectError("connection_not_found", `Connection not found: ${input.connectionId}`);
      }
      if (connection.status !== "active") {
        throw new ConnectError("connection_revoked", `Connection is not active: ${connection.id}`);
      }

      const scopes = assertGrantedScopes(connection.grantedScopes, input.scopes ?? []);
      const allowed = await options.policy?.canUseConnection({
        connection,
        subject: input.subject,
        scopes,
        actionId: input.actionId,
      });
      if (allowed === false) {
        throw new ConnectError("policy_denied", `Connection use denied by policy: ${connection.id}`);
      }
      if (!connection.secretRef) {
        if (connection.authType === "mcp" && readMcpAuthMode(connection.metadata) === "none") {
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

      if (secret.kind === "api_key") {
        if (!secret.apiKey) throw new ConnectError("token_not_available", "API-key connection secret is empty");
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
        if (!secret.apiKey) throw new ConnectError("token_not_available", "MCP connection secret is empty");
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
      if (input.forceRefresh || shouldRefresh(tokens, now(), tokenRefreshSkewMs)) {
        const initialTokens = tokens;
        try {
          tokens = await refreshCoordinator.runExclusive(connection.id, async () => {
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
            const latestTokens = latestSecret.tokens;
            const refreshedByAnotherCaller = latestTokens.accessToken !== initialTokens.accessToken
              || latestTokens.refreshToken !== initialTokens.refreshToken
              || latestTokens.expiresAt !== initialTokens.expiresAt;
            if (
              refreshedByAnotherCaller
              || (!input.forceRefresh && !shouldRefresh(latestTokens, now(), tokenRefreshSkewMs))
            ) {
              secret = latestSecret;
              return latestTokens;
            }

            const provider = registry.require(connection.providerId);
            const oauthAuth = await oauthAuthForConnection(provider, connection.oauthClientId);
            if (!latestTokens.refreshToken) {
              throw new ConnectError(
                "token_not_available",
                "OAuth access token is expired and no refresh token is available",
              );
            }
            const refreshed = await refreshToken(
              fetchImpl,
              oauthAuth,
              latestTokens.refreshToken,
              connection.grantedScopes,
              now(),
            );
            const nextSecret = { ...latestSecret, tokens: refreshed };
            if (versionedStore && snapshot) {
              const written = await versionedStore.compareAndSet(
                connection.secretRef!,
                snapshot.version,
                nextSecret,
              );
              if (!written) {
                const winner = await versionedStore.getVersioned(connection.secretRef!);
                if (winner?.secret.kind !== "oauth2" || !winner.secret.tokens?.accessToken) {
                  throw new ConnectError(
                    "refresh_unavailable",
                    "OAuth token refresh lost a write race without a valid winner",
                  );
                }
                secret = winner.secret;
                return winner.secret.tokens;
              }
            } else {
              await options.secrets.setSecret(connection.secretRef!, nextSecret);
            }
            secret = nextSecret;
            await options.store.updateConnection(connection.id, {
              tokenExpiresAt: refreshed.expiresAt,
              updatedAt: now().toISOString(),
            });
            return refreshed;
          });
        } catch (error) {
          if (error instanceof ConnectError) throw error;
          throw new ConnectError(
            "refresh_unavailable",
            "OAuth token refresh could not be coordinated",
          );
        }
      }

      return {
        kind: "oauth2",
        accessToken: tokens.accessToken,
        tokenType: tokens.tokenType ?? "Bearer",
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes ?? scopes,
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
      const provider = registry.require(connection.providerId);
      if (!provider.http) {
        throw new ConnectError(
          "policy_denied",
          `Provider "${provider.id}" does not expose an HTTP gateway policy`,
        );
      }

      let resolvedRequest;
      try {
        resolvedRequest = resolveConnectorHttpRequest(provider.http, input.request);
      } catch (error) {
        if (error instanceof ConnectionSelectionError) {
          throw new ConnectError("policy_denied", error.message, {
            status: error.status,
            details: { code: error.code },
          });
        }
        throw error;
      }
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
        if (provider.http.auth.mode === "bearer") {
          headers.set("authorization", `${tokenType} ${authValue}`);
        } else if (provider.http.auth.mode === "header") {
          headers.set(provider.http.auth.name!, authValue);
        } else {
          url.searchParams.set(provider.http.auth.name!, authValue);
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

      for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
        await assertPublicDns(url.hostname, resolveHostname);
        const response = await fetchWithTimeout(fetchImpl, url, {
          method: resolvedRequest.method,
          headers,
          body,
          redirect: "manual",
        }, resolvedRequest.timeoutMs, input.signal);

        if (response.status >= 300 && response.status < 400) {
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
              provider.http,
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

        const responseBytes = await readResponseBytes(response, resolvedRequest.maxResponseBytes);
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
    },

    async revokeConnection(input) {
      const connection = await options.store.getConnection(input.connectionId);
      if (!connection) {
        throw new ConnectError("connection_not_found", `Connection not found: ${input.connectionId}`);
      }
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
  ): Record<string, string> | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ConnectError("setup_invalid", `Connection setup binding ${name} is invalid`);
    }
    if (Object.keys(value).some((key) => !fields.includes(key))) {
      throw new ConnectError(
        "setup_invalid",
        `Connection setup binding ${name} has unsupported fields`,
      );
    }
    return Object.fromEntries(fields.map((field) => [
      field,
      requiredText(`binding.${name}.${field}`, value[field]),
    ]));
  };
  return {
    ...(binding.principal ? {
      principal: normalizePart(
        "principal",
        binding.principal as unknown as Record<string, unknown>,
        ["type", "id"],
      ) as ConnectionBindingAttributes["principal"],
    } : {}),
    ...(binding.tenant ? {
      tenant: normalizePart(
        "tenant",
        binding.tenant as unknown as Record<string, unknown>,
        ["namespace", "id"],
      ) as ConnectionBindingAttributes["tenant"],
    } : {}),
    ...(binding.resource ? {
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

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("connection_gateway_timeout")), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new ConnectError("http_error", controller.signal.aborted
      ? "Provider request was aborted or timed out"
      : "Provider request failed", {
      details: {
        category: controller.signal.aborted ? "aborted" : "transport_failed",
        retryable: true,
      },
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readResponseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new ConnectError("http_error", "Provider response exceeds the Connector limit", {
      details: { category: "response_too_large" },
    });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
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

async function exchangeCode(fetchImpl: typeof fetch, auth: OAuth2AuthConfig, code: string, redirectUri: string, codeVerifier?: string): Promise<ProviderTokenResponse> {
  return requestToken(fetchImpl, auth.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    code_verifier: codeVerifier,
    ...auth.extraTokenParams,
  });
}

async function refreshToken(fetchImpl: typeof fetch, auth: OAuth2AuthConfig, refreshTokenValue: string, fallbackScopes: string[], now: Date): Promise<TokenSet> {
  const tokenSet = await requestToken(fetchImpl, auth.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    ...auth.extraTokenParams,
  });
  return normalizeTokenSet(tokenSet, parseScopes(tokenSet.scope, fallbackScopes), now, refreshTokenValue);
}

async function requestToken(fetchImpl: typeof fetch, tokenUrl: string, body: Record<string, string | undefined>): Promise<ProviderTokenResponse> {
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: toFormBody(body),
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  if (!response.ok) {
    throw new ConnectError("token_exchange_failed", "OAuth token endpoint returned an error", {
      status: response.status,
      details: payload,
    });
  }
  if (!payload || typeof payload !== "object" || typeof (payload as ProviderTokenResponse).access_token !== "string") {
    throw new ConnectError("token_exchange_failed", "OAuth token endpoint did not return access_token", { details: payload });
  }
  return payload as ProviderTokenResponse;
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
  return metadata?.auth === "none" ? "none" : "bearer";
}

function readTokenType(secret: StoredConnectionSecret): string {
  const tokenType = secret.metadata?.tokenType;
  return typeof tokenType === "string" && tokenType.trim() ? tokenType.trim() : "Bearer";
}

function createId(prefix: string): string {
  return `${prefix}_${createOpaqueToken(18)}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ConnectError("token_exchange_failed", "OAuth token endpoint returned invalid JSON", { details: text });
  }
}

interface ProviderTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  [key: string]: unknown;
}
