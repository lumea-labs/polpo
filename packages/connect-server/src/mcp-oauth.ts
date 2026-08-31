import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  ConnectError,
  type McpOAuthClientInformation,
  type McpOAuthClientMode,
  type McpOAuthDiscovery,
  type McpOAuthInspection,
  type McpOAuthSecretMaterial,
  type TokenSet,
} from "@polpo-ai/connect";

export interface McpOAuthClientRegistrationStore {
  get(input: { resource: string; redirectUri: string; mode: McpOAuthClientMode }): Promise<McpOAuthClientInformation | null>;
  set(input: { resource: string; redirectUri: string; mode: McpOAuthClientMode; client: McpOAuthClientInformation }): Promise<void>;
}

export interface InspectMcpOAuthInput { url: string; transport?: "http" | "sse" }

export interface StartMcpOAuthProtocolInput extends InspectMcpOAuthInput {
  redirectUri: string;
  state: string;
  scopes?: string[];
  mode: McpOAuthClientMode;
  clientName?: string;
  clientUri?: string;
  clientMetadataUrl?: string;
  preRegisteredClient?: McpOAuthClientInformation;
}

export interface StartMcpOAuthProtocolResult {
  authorizationUrl: string;
  material: McpOAuthSecretMaterial;
}

export interface McpOAuthProtocolOptions {
  fetch: typeof fetch;
  registrations?: McpOAuthClientRegistrationStore;
  now?: () => Date;
}

export function createMcpOAuthProtocol(options: McpOAuthProtocolOptions) {
  const now = options.now ?? (() => new Date());

  async function inspect(input: InspectMcpOAuthInput): Promise<McpOAuthInspection> {
    const url = normalizeHttpsUrl(input.url);
    try {
      const discovered = await discoverOAuthServerInfo(url, { fetchFn: options.fetch as any });
      const discovery = normalizeDiscovery(
        url,
        discovered.authorizationServerUrl,
        discovered.authorizationServerMetadata as Record<string, unknown> | undefined,
        discovered.resourceMetadata as Record<string, unknown> | undefined,
      );
      const methods = discovery.codeChallengeMethodsSupported;
      if (methods && !methods.includes("S256")) {
        throw new ConnectError("oauth_discovery_failed", "MCP authorization server does not support PKCE S256");
      }
      const clientModes: McpOAuthClientMode[] = ["metadata_document", "pre_registered"];
      if (discovery.registrationEndpoint) clientModes.unshift("dynamic");
      return { url, transport: input.transport ?? "http", auth: "oauth2", discovery, clientModes, warnings: [] };
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      return {
        url,
        transport: input.transport ?? "http",
        auth: "unknown",
        clientModes: ["metadata_document", "pre_registered"],
        warnings: ["OAuth metadata discovery was inconclusive; choose authentication explicitly."],
      };
    }
  }

  async function start(input: StartMcpOAuthProtocolInput): Promise<StartMcpOAuthProtocolResult> {
    const inspected = await inspect(input);
    if (!inspected.discovery) {
      throw new ConnectError("oauth_discovery_failed", "MCP OAuth metadata could not be discovered");
    }
    const redirectUri = normalizeHttpsUrl(input.redirectUri);
    const scopes = normalizeScopes(input.scopes ?? inspected.discovery.scopesSupported ?? []);
    const client = await resolveClient(input, inspected.discovery, redirectUri, scopes);
    const started = await startAuthorization(inspected.discovery.authorizationServer, {
      metadata: inspected.discovery.rawAuthorizationServerMetadata as AuthorizationServerMetadata,
      clientInformation: client as OAuthClientInformationMixed,
      redirectUrl: redirectUri,
      scope: scopes.length ? scopes.join(" ") : undefined,
      state: input.state,
      resource: new URL(inspected.discovery.resource),
    });
    return {
      authorizationUrl: started.authorizationUrl.toString(),
      material: { mode: input.mode, redirectUri, discovery: inspected.discovery, client, codeVerifier: started.codeVerifier },
    };
  }

  async function complete(input: { material: McpOAuthSecretMaterial; code: string; requestedScopes: string[] }): Promise<TokenSet> {
    if (!input.material.codeVerifier) {
      throw new ConnectError("token_exchange_failed", "MCP OAuth PKCE verifier is missing");
    }
    try {
      const tokens = await exchangeAuthorization(input.material.discovery.authorizationServer, {
        metadata: input.material.discovery.rawAuthorizationServerMetadata as AuthorizationServerMetadata,
        clientInformation: input.material.client as OAuthClientInformationMixed,
        authorizationCode: input.code,
        codeVerifier: input.material.codeVerifier,
        redirectUri: input.material.redirectUri,
        resource: new URL(input.material.discovery.resource),
        fetchFn: options.fetch as any,
      });
      return normalizeTokens(tokens as Record<string, unknown>, input.requestedScopes, now());
    } catch (error) {
      throw protocolError("token_exchange_failed", "MCP OAuth token exchange failed", error);
    }
  }

  async function refresh(input: { material: McpOAuthSecretMaterial; fallbackScopes: string[] }): Promise<TokenSet> {
    if (!input.material.tokens?.refreshToken) {
      throw new ConnectError("refresh_unavailable", "MCP OAuth refresh token is unavailable");
    }
    try {
      const tokens = await refreshAuthorization(input.material.discovery.authorizationServer, {
        metadata: input.material.discovery.rawAuthorizationServerMetadata as AuthorizationServerMetadata,
        clientInformation: input.material.client as OAuthClientInformationMixed,
        refreshToken: input.material.tokens.refreshToken,
        resource: new URL(input.material.discovery.resource),
        fetchFn: options.fetch as any,
      });
      return normalizeTokens(tokens as Record<string, unknown>, input.fallbackScopes, now(), input.material.tokens.refreshToken);
    } catch (error) {
      throw protocolError("refresh_unavailable", "MCP OAuth token refresh failed", error);
    }
  }

  async function resolveClient(
    input: StartMcpOAuthProtocolInput,
    discovery: McpOAuthDiscovery,
    redirectUri: string,
    scopes: string[],
  ): Promise<McpOAuthClientInformation> {
    if (input.mode === "pre_registered") {
      if (!input.preRegisteredClient?.client_id) {
        throw new ConnectError("oauth_registration_failed", "A pre-registered MCP OAuth client is required");
      }
      return input.preRegisteredClient;
    }
    if (input.mode === "metadata_document") {
      if (!input.clientMetadataUrl) {
        throw new ConnectError("oauth_registration_failed", "Client ID Metadata Document URL is required");
      }
      return { client_id: normalizeHttpsUrl(input.clientMetadataUrl) };
    }
    if (!discovery.registrationEndpoint) {
      throw new ConnectError("oauth_registration_failed", "MCP authorization server does not support dynamic client registration");
    }
    const cached = await options.registrations?.get({ resource: discovery.resource, redirectUri, mode: input.mode });
    if (cached) return cached;
    const metadata: OAuthClientMetadata = {
      client_name: input.clientName ?? "Polpo",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(input.clientUri ? { client_uri: normalizeHttpsUrl(input.clientUri) } : {}),
    };
    try {
      const registered = await registerClient(discovery.authorizationServer, {
        metadata: discovery.rawAuthorizationServerMetadata as AuthorizationServerMetadata,
        clientMetadata: metadata,
        scope: scopes.length ? scopes.join(" ") : undefined,
        fetchFn: options.fetch as any,
      });
      const client = registered as McpOAuthClientInformation;
      await options.registrations?.set({ resource: discovery.resource, redirectUri, mode: input.mode, client });
      return client;
    } catch (error) {
      throw protocolError("oauth_registration_failed", "MCP OAuth dynamic client registration failed", error);
    }
  }

  return { inspect, start, complete, refresh };
}

function normalizeDiscovery(
  resource: string,
  authorizationServer: string,
  metadata: Record<string, unknown> | undefined,
  protectedResource: Record<string, unknown> | undefined,
): McpOAuthDiscovery {
  const authorizationEndpoint = text(metadata?.authorization_endpoint);
  const tokenEndpoint = text(metadata?.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new ConnectError("oauth_discovery_failed", "MCP OAuth metadata is missing authorization or token endpoint");
  }
  const registrationEndpoint = text(metadata?.registration_endpoint);
  const revocationEndpoint = text(metadata?.revocation_endpoint);
  const scopesSupported = strings(metadata?.scopes_supported);
  const codeChallengeMethodsSupported = strings(metadata?.code_challenge_methods_supported);
  return {
    resource: normalizeHttpsUrl(text(protectedResource?.resource) ?? resource),
    authorizationServer: normalizeHttpsUrl(authorizationServer),
    authorizationEndpoint: normalizeHttpsUrl(authorizationEndpoint),
    tokenEndpoint: normalizeHttpsUrl(tokenEndpoint),
    ...(registrationEndpoint ? { registrationEndpoint: normalizeHttpsUrl(registrationEndpoint) } : {}),
    ...(revocationEndpoint ? { revocationEndpoint: normalizeHttpsUrl(revocationEndpoint) } : {}),
    ...(scopesSupported ? { scopesSupported } : {}),
    ...(codeChallengeMethodsSupported ? { codeChallengeMethodsSupported } : {}),
    rawAuthorizationServerMetadata: metadata,
    rawProtectedResourceMetadata: protectedResource,
  };
}

function normalizeTokens(tokens: Record<string, unknown>, fallbackScopes: string[], now: Date, fallbackRefreshToken?: string): TokenSet {
  const accessToken = text(tokens.access_token);
  if (!accessToken) throw new ConnectError("token_exchange_failed", "MCP OAuth response is missing access_token");
  const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : undefined;
  return {
    accessToken,
    refreshToken: text(tokens.refresh_token) ?? fallbackRefreshToken,
    tokenType: text(tokens.token_type) ?? "Bearer",
    expiresAt: expiresIn === undefined ? undefined : new Date(now.getTime() + expiresIn * 1000).toISOString(),
    scopes: normalizeScopes(text(tokens.scope)?.split(/[,\s]+/) ?? fallbackScopes),
    raw: tokens,
  };
}

function normalizeHttpsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConnectError("invalid_request", "MCP OAuth URL must be absolute"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ConnectError("invalid_request", "MCP OAuth URL must use HTTPS and cannot contain credentials");
  }
  return url.toString();
}

function normalizeScopes(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function strings(value: unknown): string[] | undefined { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined; }
function protocolError(code: "token_exchange_failed" | "refresh_unavailable" | "oauth_registration_failed", message: string, error: unknown): ConnectError {
  return error instanceof ConnectError ? error : new ConnectError(code, message, { details: error instanceof Error ? error.message : String(error) });
}
