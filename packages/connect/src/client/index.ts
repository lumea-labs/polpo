import { ConnectError } from "../errors.js";
import type { ConnectionRequest, ConnectionResponse } from "@polpo-ai/core";
import type {
  ConnectSubject,
  ConnectionAudience,
  ConnectionBindingAttributes,
  ConnectionLink,
  ConnectionLinkListFilter,
  ConnectionOwner,
  ConnectionRecord,
  ConnectionSetupSession,
  ConnectorProviderDefinition,
  McpConnectionAuth,
  McpConnectionTransport,
  RuntimeToken,
} from "../types.js";

export interface PolpoConnectClientOptions {
  baseUrl: string;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof fetch;
}

export interface CreateApiKeyConnectionRequest {
  providerId: string;
  apiKey: string;
  scopes?: string[];
  subject?: ConnectSubject;
  name?: string;
  projectId?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateMcpConnectionRequest {
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

export interface StartOAuthRequest {
  providerId: string;
  scopes?: string[];
  subject?: ConnectSubject;
  redirectUri: string;
  projectId?: string;
  orgId?: string;
  connectionName?: string;
  metadata?: Record<string, unknown>;
}

export interface StartOAuthResponse {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
}

export interface CompleteOAuthRequest {
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

export interface GetTokenRequest {
  scopes?: string[];
  subject?: ConnectSubject;
  actionId?: string;
  forceRefresh?: boolean;
}

export interface CreateConnectionSetupSessionRequest {
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

export interface ConnectionGatewayRequest extends GetTokenRequest {
  request: ConnectionRequest;
}

export class PolpoConnectClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers?: PolpoConnectClientOptions["headers"];

  constructor(options: PolpoConnectClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = options.headers;
  }

  listProviders(): Promise<ConnectorProviderDefinition[]> {
    return this.request("GET", "/v1/connect/providers");
  }

  listConnections(): Promise<ConnectionRecord[]> {
    return this.request("GET", "/v1/connect/connections");
  }

  listConnectionLinks(filter: ConnectionLinkListFilter = {}): Promise<ConnectionLink[]> {
    const query = new URLSearchParams();
    if (filter.connectionId) query.set("connectionId", filter.connectionId);
    if (filter.projectId) query.set("projectId", filter.projectId);
    if (filter.status) query.set("status", filter.status);
    return this.request("GET", `/v1/connect/connection-links${query.size ? `?${query}` : ""}`);
  }

  linkConnection(connectionId: string, projectId: string): Promise<ConnectionLink> {
    return this.request("POST", "/v1/connect/connection-links", { connectionId, projectId });
  }

  unlinkConnection(linkId: string): Promise<ConnectionLink> {
    return this.request("POST", `/v1/connect/connection-links/${encodeURIComponent(linkId)}/revoke`);
  }

  createApiKeyConnection(input: CreateApiKeyConnectionRequest): Promise<ConnectionRecord> {
    return this.request("POST", "/v1/connect/connections/api-key", input);
  }

  createMcpConnection(input: CreateMcpConnectionRequest): Promise<ConnectionRecord> {
    return this.request("POST", "/v1/connect/connections/mcp", input);
  }

  startOAuth(input: StartOAuthRequest): Promise<StartOAuthResponse> {
    return this.request("POST", "/v1/connect/oauth/start", input);
  }

  completeOAuth(input: CompleteOAuthRequest): Promise<ConnectionRecord> {
    return this.request("POST", "/v1/connect/oauth/callback", input);
  }

  createSetupSession(input: CreateConnectionSetupSessionRequest): Promise<ConnectionSetupSession> {
    return this.request("POST", "/v1/connect/setup-sessions", input);
  }

  startOAuthSetup(setupSessionId: string): Promise<StartOAuthResponse> {
    return this.request(
      "POST",
      `/v1/connect/setup-sessions/${encodeURIComponent(setupSessionId)}/start`,
    );
  }

  getToken(connectionId: string, input: GetTokenRequest = {}): Promise<RuntimeToken> {
    return this.request("POST", `/v1/connect/connections/${encodeURIComponent(connectionId)}/token`, input);
  }

  gatewayRequest<T = unknown>(
    connectionId: string,
    input: ConnectionGatewayRequest,
  ): Promise<ConnectionResponse<T>> {
    return this.request(
      "POST",
      `/v1/connect/connections/${encodeURIComponent(connectionId)}/request`,
      input,
    );
  }

  revokeConnection(connectionId: string): Promise<ConnectionRecord> {
    return this.request("POST", `/v1/connect/connections/${encodeURIComponent(connectionId)}/revoke`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const dynamicHeaders = typeof this.headers === "function" ? await this.headers() : this.headers;
    const headers = new Headers(dynamicHeaders);
    if (body !== undefined) headers.set("content-type", "application/json");

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText;
      throw new ConnectError("http_error", message, { status: response.status, details: payload });
    }
    if (
      payload
      && typeof payload === "object"
      && "ok" in payload
      && (payload as { ok?: unknown }).ok === true
      && "data" in payload
    ) {
      return (payload as { data: T }).data;
    }
    return payload as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
