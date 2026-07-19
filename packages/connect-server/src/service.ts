import {
  ConnectError,
  assertAllowedScopes,
  assertGrantedScopes,
  createConnectorRegistry,
  normalizeScopes,
  type ConnectPolicy,
  type ConnectStore,
  type ConnectSubject,
  type ConnectionRecord,
  type ConnectorProviderDefinition,
  type McpConnectionAuth,
  type McpConnectionMetadata,
  type McpConnectionTransport,
  type OAuth2AuthConfig,
  type ResolvedConnectionCredential,
  type RuntimeToken,
  type StoredConnectionSecret,
  type TokenSet,
} from "@polpo-ai/connect";
import type { ConnectionSecretStore } from "./secrets.js";
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
  subject?: ConnectSubject;
  redirectUri: string;
  projectId?: string;
  orgId?: string;
  connectionName?: string;
  metadata?: Record<string, unknown>;
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

export interface ConnectService {
  listProviders(): ConnectorProviderDefinition[];
  listConnections(filter?: Parameters<ConnectStore["listConnections"]>[0]): Promise<ConnectionRecord[]>;
  createApiKeyConnection(input: CreateApiKeyConnectionInput): Promise<ConnectionRecord>;
  createMcpConnection(input: CreateMcpConnectionInput): Promise<ConnectionRecord>;
  startOAuth(input: StartOAuthInput): Promise<StartOAuthResult>;
  completeOAuth(input: CompleteOAuthInput): Promise<ConnectionRecord>;
  resolveCredential(input: ResolveConnectionCredentialInput): Promise<ResolvedConnectionCredential>;
  getToken(input: GetTokenInput): Promise<RuntimeToken>;
  revokeConnection(input: RevokeConnectionInput): Promise<ConnectionRecord>;
}

export function createConnectService(options: CreateConnectServiceOptions): ConnectService {
  const registry = createConnectorRegistry(options.providers);
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const tokenRefreshSkewMs = options.tokenRefreshSkewMs ?? 60_000;
  const oauthStateTtlMs = options.oauthStateTtlMs ?? 10 * 60_000;

  return {
    listProviders() {
      return registry.list();
    },

    listConnections(filter) {
      return options.store.listConnections(filter);
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
      await options.secrets.setSecret(secretRef, { kind: "api_key", apiKey });
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

    async startOAuth(input) {
      const provider = registry.require(input.providerId);
      if (provider.auth.type !== "oauth2") {
        throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use OAuth2 auth`);
      }
      const auth = provider.auth;
      if (!auth.clientId) {
        throw new ConnectError("invalid_provider", `OAuth provider "${provider.id}" is missing clientId`);
      }
      const requestedScopes = assertAllowedScopes(provider, input.scopes ?? auth.defaultScopes);
      const state = createOpaqueToken();
      const pkce = auth.supportsPkce === false ? undefined : createPkcePair();
      const expiresAt = new Date(now().getTime() + oauthStateTtlMs).toISOString();
      await options.store.saveOAuthState({
        state,
        providerId: provider.id,
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
      });

      const url = new URL(auth.authorizationUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", auth.clientId);
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
      const tokenSet = await exchangeCode(fetchImpl, provider.auth, input.code, state.redirectUri, state.codeVerifier);
      const grantedScopes = assertAllowedScopes(provider, parseScopes(tokenSet.scope, state.requestedScopes));
      assertGrantedScopes(grantedScopes, state.requestedScopes);
      const id = createId("conn");
      const secretRef = createId("connsec");
      const tokens = normalizeTokenSet(tokenSet, grantedScopes, now());
      await options.secrets.setSecret(secretRef, { kind: "oauth2", tokens });
      return options.store.upsertConnection({
        id,
        providerId: provider.id,
        name: state.connectionName,
        projectId: state.projectId,
        orgId: state.orgId,
        owner: state.subject,
        authType: "oauth2",
        status: "active",
        grantedScopes,
        secretRef,
        tokenExpiresAt: tokens.expiresAt,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        metadata: state.metadata,
      });
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

      const secret = await options.secrets.getSecret(connection.secretRef);
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
        const provider = registry.require(connection.providerId);
        if (provider.auth.type !== "oauth2") {
          throw new ConnectError("unsupported_auth", `Provider "${provider.id}" does not use OAuth2 auth`);
        }
        if (!tokens.refreshToken) {
          throw new ConnectError("token_not_available", "OAuth access token is expired and no refresh token is available");
        }
        tokens = await refreshToken(fetchImpl, provider.auth, tokens.refreshToken, connection.grantedScopes, now());
        await options.secrets.setSecret(connection.secretRef, { ...secret, tokens });
        await options.store.updateConnection(connection.id, {
          tokenExpiresAt: tokens.expiresAt,
          updatedAt: now().toISOString(),
        });
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
