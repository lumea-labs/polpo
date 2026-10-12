import { ConnectError } from "../errors.js";
import type { ConnectorCatalogEntry, ConnectorDefinition } from "../definitions.js";
import type { StoredConnectorDefinition } from "../definition-store.js";
import type { ConnectionVerificationResult, ConnectorSetupReadinessInput, ConnectorSetupReadinessResult } from "../verification.js";
import type {
  ConnectionOperationPolicy,
  ConnectionRequest,
  ConnectionResponse,
  ToolInvocationJsonValue,
} from "@polpo-ai/core";
import type {
  ConnectSubject,
  ConnectionAudience,
  ConnectionBindingAttributes,
  ConnectionCreationContext,
  ConnectionLink,
  ConnectionLinkListFilter,
  ConnectionOwner,
  ConnectionRecord,
  ConnectionSetupSession,
  ConnectionSetupStatus,
  ConnectorProviderDefinition,
  McpConnectionAuth,
  McpConnectionTransport,
  McpOAuthClientInformation,
  McpOAuthClientMode,
  McpOAuthInspection,
  ResolvedMcpOAuthClient,
  RuntimeToken,
} from "../types.js";

export interface PolpoConnectClientOptions {
  baseUrl: string;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof fetch;
}

export interface CreateApiKeyConnectionRequest extends ConnectionCreationContext {
  providerId: string;
  authenticationId?: string;
  apiKey: string;
  scopes?: string[];
  name?: string;
  projectId?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
}

export type CreatePublicConnectionRequest = Omit<CreateApiKeyConnectionRequest, "apiKey">;

export interface CreateMcpConnectionRequest extends ConnectionCreationContext {
  providerId?: string;
  authenticationId?: string;
  name?: string;
  url: string;
  transport?: McpConnectionTransport;
  auth?: McpConnectionAuth;
  headerName?: string;
  apiKey?: string;
  bearerToken?: string;
  scopes?: string[];
  projectId?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
}

export interface StartOAuthRequest {
  providerId: string;
  authenticationId?: string;
  oauthClientMode?: "managed" | "customer" | "instance";
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

export interface InspectMcpOAuthRequest {
  url: string;
  transport?: McpConnectionTransport;
}

export interface StartMcpOAuthRequest extends InspectMcpOAuthRequest, ConnectionCreationContext {
  providerId?: string;
  authenticationId?: string;
  name?: string;
  scopes?: string[];
  mode: McpOAuthClientMode;
  clientMetadataUrl?: string;
  preRegisteredClient?: McpOAuthClientInformation;
  metadata?: Record<string, unknown>;
}

export interface GetTokenRequest {
  scopes?: string[];
  subject?: ConnectSubject;
  actionId?: string;
  forceRefresh?: boolean;
}

export interface CreateConnectionSetupSessionRequest {
  providerId: string;
  authenticationId?: string;
  /** Reusable host-owned MCP OAuth configuration; never a provider secret. */
  configurationId?: string;
  projectId: string;
  orgId?: string;
  audience: ConnectionAudience;
  subject: ConnectionOwner;
  binding?: ConnectionBindingAttributes;
  scopes?: string[];
  returnUrl: string;
  oauthClientMode: "managed" | "customer" | "instance";
  application?: { name: string; url?: string };
  metadata?: Record<string, unknown>;
}

export interface ConnectionGatewayRequest extends GetTokenRequest {
  request: ConnectionRequest;
}

export interface ApplicationCapabilityRecord {
  capabilityId: string;
  connectionId: string;
  providerId: string;
  scopes: string[];
  allowedOperations: ConnectionOperationPolicy[];
  binding?: ConnectionBindingAttributes;
  status: "pending" | "active" | "revoked";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigureApplicationCapabilityRequest {
  connectionId: string;
  scopes?: string[];
  allowedOperations?: ConnectionOperationPolicy[];
  binding?: ConnectionBindingAttributes;
}

export interface ApplicationCapabilityInvocation {
  user?: string;
  metadata?: Record<string, ToolInvocationJsonValue>;
  scope?: { key: string; version?: string };
  sessionId?: string;
}

export interface ApplicationCapabilityRequest {
  invocation?: ApplicationCapabilityInvocation;
  request: ConnectionRequest;
}

export type { ConnectionSetupStatus } from "../types.js";

/** Project-approved destinations after provider authorization, independent of OAuth app ownership. */
export interface ProjectConnectionSetupConfiguration {
  returnOrigins: string[];
}

export interface CloudOAuthClientRecord {
  id: string;
  providerId: string;
  authenticationId?: string;
  owner: { type: "organization" | "project"; id: string };
  name?: string;
  status: "active" | "revoked";
  clientId: string;
  hasSecret: boolean;
  redirectUris: string[];
  returnOrigins: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ConfigureCloudOAuthClientRequest {
  name?: string;
  authenticationId?: string;
  clientId: string;
  clientSecret?: string;
  returnOrigins?: string[];
}

export type McpOAuthConfigurationScope = { type: "project" | "organization"; id: string };
export type ConfigureMcpOAuthRequest = Pick<ResolvedMcpOAuthClient, "providerId" | "authenticationId" | "resourceUrl" | "transport" | "registration"> & {
  name?: string; returnOrigins?: string[];
};
export type CloudMcpOAuthConfiguration = Omit<ResolvedMcpOAuthClient, "registration"> & {
  registration: Exclude<ResolvedMcpOAuthClient["registration"], { mode: "pre_registered" }>
    // Omit over the metadata index signature would erase required client_id.
    | { mode: "pre_registered"; client: McpOAuthClientInformation & { client_secret?: never } };
  name?: string; status: "active" | "revoked"; hasSecret: boolean; fingerprint: string;
  revision: string; returnOrigins: string[]; createdAt: string; updatedAt: string;
};

export interface ConnectionEventRecord {
  id: string;
  connectionId?: string | null;
  providerId?: string | null;
  agentName?: string | null;
  eventType: string;
  actionId?: string | null;
  toolName?: string | null;
  status: string;
  subjectType?: string | null;
  subjectId?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
  createdAt: string;
}

export interface WaitForConnectionSetupOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface OpenConnectionSetupOptions {
  target?: string;
  features?: string;
  open?: (url: string, target: string, features?: string) => Window | null;
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

  listCatalog(): Promise<ConnectorCatalogEntry[]> {
    return this.request("GET", "/v1/connect/catalog");
  }

  listProjectCatalog(projectId: string): Promise<ConnectorCatalogEntry[]> {
    return this.request("GET", `${projectConnectPath(projectId)}/catalog`);
  }

  getProjectSetupReadiness(projectId: string, input: Pick<ConnectorSetupReadinessInput, "providerId" | "authenticationId"> & {
    oauthClientMode?: "managed" | "customer";
  }): Promise<ConnectorSetupReadinessResult> {
    return this.request("POST", `${projectConnectPath(projectId)}/setup-readiness`, input);
  }

  registerProjectConnectorDefinition(projectId: string, definition: ConnectorDefinition): Promise<StoredConnectorDefinition> {
    return this.request("POST", `${projectConnectPath(projectId)}/connectors`, definition);
  }

  disableProjectConnectorDefinition(projectId: string, connectorId: string): Promise<StoredConnectorDefinition> {
    return this.request("POST", `${projectConnectPath(projectId)}/connectors/${encodeURIComponent(connectorId)}/disable`);
  }

  getSetupReadiness(input: ConnectorSetupReadinessInput): Promise<ConnectorSetupReadinessResult> {
    return this.request("POST", "/v1/connect/setup-readiness", input);
  }

  registerConnectorDefinition(definition: ConnectorDefinition): Promise<StoredConnectorDefinition> {
    return this.request("POST", "/v1/connect/connectors", definition);
  }

  disableConnectorDefinition(connectorId: string): Promise<StoredConnectorDefinition> {
    return this.request("POST", `/v1/connect/connectors/${encodeURIComponent(connectorId)}/disable`);
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

  createPublicConnection(input: CreatePublicConnectionRequest): Promise<ConnectionRecord> {
    return this.request("POST", "/v1/connect/connections/public", input);
  }

  verifyConnection(connectionId: string): Promise<ConnectionVerificationResult> {
    return this.request("POST", `/v1/connect/connections/${encodeURIComponent(connectionId)}/verify`);
  }

  verifyProjectConnection(projectId: string, connectionId: string): Promise<ConnectionVerificationResult> {
    return this.request("POST", `${projectConnectPath(projectId)}/connections/${encodeURIComponent(connectionId)}/verify`);
  }

  createMcpConnection(input: CreateMcpConnectionRequest): Promise<ConnectionRecord> {
    return this.request("POST", "/v1/connect/connections/mcp", input);
  }

  createProjectApiKeyConnection(projectId: string, input: CreateApiKeyConnectionRequest): Promise<ConnectionRecord> {
    return this.request("POST", `${projectConnectPath(projectId)}/connections/api-key`, input);
  }

  createProjectPublicConnection(projectId: string, input: CreatePublicConnectionRequest): Promise<ConnectionRecord> {
    return this.request("POST", `${projectConnectPath(projectId)}/connections/public`, input);
  }

  createProjectMcpConnection(projectId: string, input: CreateMcpConnectionRequest): Promise<ConnectionRecord> {
    return this.request("POST", `${projectConnectPath(projectId)}/connections/mcp`, input);
  }

  inspectMcpOAuth(input: InspectMcpOAuthRequest): Promise<McpOAuthInspection> {
    return this.request("POST", "/v1/connect/mcp/inspect", input);
  }

  startMcpOAuth(input: StartMcpOAuthRequest & { redirectUri: string; projectId?: string; orgId?: string }): Promise<StartOAuthResponse> {
    return this.request("POST", "/v1/connect/mcp/oauth/start", input);
  }

  inspectProjectMcpOAuth(projectId: string, input: InspectMcpOAuthRequest): Promise<McpOAuthInspection> {
    return this.request("POST", `${projectConnectPath(projectId)}/mcp/inspect`, input);
  }

  /** Requires a Polpo browser session; a platform key does not identify the
   * person authorizing MCP. CLI users review and confirm setup in the dashboard. */
  startProjectMcpOAuth(projectId: string, input: StartMcpOAuthRequest): Promise<StartOAuthResponse> {
    return this.request("POST", `${projectConnectPath(projectId)}/mcp/oauth/start`, input);
  }

  /** @deprecated Cloud deliberately rejects MCP reconnect until verified-account
   * continuity is supported. Create a new Connection and explicitly reassign
   * its tools; this compatibility method surfaces the server's 409 denial. */
  reconnectProjectMcpConnection(projectId: string, connectionId: string): Promise<StartOAuthResponse> {
    return this.request(
      "POST",
      `${projectConnectPath(projectId)}/connections/${encodeURIComponent(connectionId)}/reconnect`,
    );
  }

  async verifyProjectMcpConnection(projectId: string, connectionId: string): Promise<{ ok: true; toolCount: number }> {
    const result = await this.request<{ tools?: unknown[] }>(
      "POST",
      `${projectConnectPath(projectId)}/connections/${encodeURIComponent(connectionId)}/mcp/discover`,
    );
    return { ok: true, toolCount: result.tools?.length ?? 0 };
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

  createProjectSetupSession(
    projectId: string,
    input: Omit<CreateConnectionSetupSessionRequest, "projectId">,
  ): Promise<ConnectionSetupSession & { setupUrl: string }> {
    return this.request(
      "POST",
      `${projectConnectPath(projectId)}/setup-sessions`,
      input,
    );
  }

  getProjectSetupConfiguration(projectId: string): Promise<ProjectConnectionSetupConfiguration> {
    return this.request("GET", `${projectConnectPath(projectId)}/setup-configuration`);
  }

  listProjectEndUserConnections(
    projectId: string,
    owner: { namespace: string; id: string },
  ): Promise<ConnectionRecord[]> {
    const query = new URLSearchParams({ namespace: owner.namespace });
    return this.request("GET", `${projectConnectPath(projectId)}/end-users/${encodeURIComponent(owner.id)}/connections?${query}`);
  }

  revokeProjectEndUserConnection(
    projectId: string,
    owner: { namespace: string; id: string },
    connectionId: string,
  ): Promise<ConnectionRecord> {
    const query = new URLSearchParams({ namespace: owner.namespace });
    return this.request("POST", `${projectConnectPath(projectId)}/end-users/${encodeURIComponent(owner.id)}/connections/${encodeURIComponent(connectionId)}/revoke?${query}`);
  }

  configureProjectSetup(projectId: string, input: ProjectConnectionSetupConfiguration): Promise<ProjectConnectionSetupConfiguration> {
    return this.request("PUT", `${projectConnectPath(projectId)}/setup-configuration`, input);
  }

  getSetupStatus(setupToken: string): Promise<ConnectionSetupStatus> {
    return this.request(
      "GET",
      `/v1/connect/setup/${encodeURIComponent(setupToken)}/status`,
    );
  }

  cancelSetupSession(setupToken: string): Promise<ConnectionSetupStatus> {
    return this.request(
      "POST",
      `/v1/connect/setup/${encodeURIComponent(setupToken)}/cancel`,
    );
  }

  async waitForSetupCompletion(
    setupToken: string,
    options: WaitForConnectionSetupOptions = {},
  ): Promise<ConnectionSetupStatus> {
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
      throw new TypeError("pollIntervalMs must be between 100 and 60000");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60 * 60_000) {
      throw new TypeError("timeoutMs must be between 100 and 3600000");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      throwIfAborted(options.signal);
      const status = await this.getSetupStatus(setupToken);
      if (["completed", "cancelled", "expired", "error"].includes(status.status)) {
        return status;
      }
      if (Date.now() >= deadline) {
        throw new ConnectError("http_error", "Connection setup timed out", { status: 408 });
      }
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), options.signal);
    }
  }

  startOAuthSetup(setupSessionId: string): Promise<StartOAuthResponse> {
    return this.request(
      "POST",
      `/v1/connect/setup-sessions/${encodeURIComponent(setupSessionId)}/start`,
    );
  }

  /** Starts a session from createProjectSetupSession through the Cloud public setup API. */
  startProjectOAuthSetup(setupToken: string): Promise<StartOAuthResponse> {
    return this.request(
      "POST",
      `/v1/connect/setup/${encodeURIComponent(setupToken)}/oauth/start`,
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

  listApplicationCapabilities(
    projectId: string,
    status: "pending" | "active" | "revoked" = "active",
  ): Promise<ApplicationCapabilityRecord[]> {
    return this.request(
      "GET",
      `${projectConnectPath(projectId)}/application-capabilities?status=${status}`,
    );
  }

  listProjectOAuthClients(projectId: string): Promise<CloudOAuthClientRecord[]> {
    return this.request("GET", `${projectConnectPath(projectId)}/oauth-clients`);
  }

  listMcpOAuthConfigurations(owner: McpOAuthConfigurationScope): Promise<CloudMcpOAuthConfiguration[]> {
    return this.request("GET", mcpConfigurationPath(owner));
  }

  createMcpOAuthConfiguration(owner: McpOAuthConfigurationScope, input: ConfigureMcpOAuthRequest): Promise<CloudMcpOAuthConfiguration> {
    return this.request("POST", mcpConfigurationPath(owner), input);
  }

  updateMcpOAuthConfiguration(owner: McpOAuthConfigurationScope, id: string,
    input: ConfigureMcpOAuthRequest & { expectedRevision: string }): Promise<CloudMcpOAuthConfiguration> {
    return this.request("PUT", `${mcpConfigurationPath(owner)}/${encodeURIComponent(id)}`, input);
  }

  revokeMcpOAuthConfiguration(owner: McpOAuthConfigurationScope, id: string, expectedRevision: string): Promise<CloudMcpOAuthConfiguration> {
    return this.request("DELETE", `${mcpConfigurationPath(owner)}/${encodeURIComponent(id)}?${new URLSearchParams({ expectedRevision })}`);
  }

  configureProjectOAuthClient(
    projectId: string,
    providerId: string,
    input: ConfigureCloudOAuthClientRequest,
  ): Promise<CloudOAuthClientRecord> {
    return this.request(
      "PUT",
      `${projectConnectPath(projectId)}/oauth-clients/${encodeURIComponent(providerId)}`,
      input,
    );
  }

  revokeProjectOAuthClient(
    projectId: string,
    providerId: string,
    authenticationId?: string,
  ): Promise<CloudOAuthClientRecord> {
    return this.request(
      "DELETE",
      `${projectConnectPath(projectId)}/oauth-clients/${encodeURIComponent(providerId)}${authenticationId ? `?authenticationId=${encodeURIComponent(authenticationId)}` : ""}`,
    );
  }

  listOrganizationOAuthClients(organizationId: string): Promise<CloudOAuthClientRecord[]> {
    return this.request("GET", `${organizationConnectPath(organizationId)}/oauth-clients`);
  }

  configureOrganizationOAuthClient(
    organizationId: string,
    providerId: string,
    input: ConfigureCloudOAuthClientRequest,
  ): Promise<CloudOAuthClientRecord> {
    return this.request(
      "PUT",
      `${organizationConnectPath(organizationId)}/oauth-clients/${encodeURIComponent(providerId)}`,
      input,
    );
  }

  revokeOrganizationOAuthClient(
    organizationId: string,
    providerId: string,
    authenticationId?: string,
  ): Promise<CloudOAuthClientRecord> {
    return this.request(
      "DELETE",
      `${organizationConnectPath(organizationId)}/oauth-clients/${encodeURIComponent(providerId)}${authenticationId ? `?authenticationId=${encodeURIComponent(authenticationId)}` : ""}`,
    );
  }

  configureApplicationCapability(
    projectId: string,
    capabilityId: string,
    input: ConfigureApplicationCapabilityRequest,
  ): Promise<ApplicationCapabilityRecord> {
    return this.request(
      "PUT",
      `${projectConnectPath(projectId)}/application-capabilities/${encodeURIComponent(capabilityId)}`,
      input,
    );
  }

  revokeApplicationCapability(
    projectId: string,
    capabilityId: string,
  ): Promise<ApplicationCapabilityRecord> {
    return this.request(
      "DELETE",
      `${projectConnectPath(projectId)}/application-capabilities/${encodeURIComponent(capabilityId)}`,
    );
  }

  requestApplicationCapability<T = unknown>(
    projectId: string,
    capabilityId: string,
    input: ApplicationCapabilityRequest,
  ): Promise<ConnectionResponse<T>> {
    return this.request(
      "POST",
      `${projectConnectPath(projectId)}/capabilities/${encodeURIComponent(capabilityId)}/request`,
      input,
    );
  }

  listConnectionEvents(
    projectId: string,
    connectionId: string,
    limit = 50,
  ): Promise<ConnectionEventRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError("Connection event limit must be an integer between 1 and 200");
    }
    return this.request(
      "GET",
      `${projectConnectPath(projectId)}/connections/${encodeURIComponent(connectionId)}/events?limit=${limit}`,
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

function mcpConfigurationPath(owner: McpOAuthConfigurationScope): string {
  return `${owner.type === "project" ? projectConnectPath(owner.id) : organizationConnectPath(owner.id)}/mcp-oauth-configurations`;
}

function projectConnectPath(projectId: string): string {
  if (!projectId.trim()) throw new TypeError("projectId is required");
  return `/v1/projects/${encodeURIComponent(projectId)}/connect`;
}

function organizationConnectPath(organizationId: string): string {
  if (!organizationId.trim()) throw new TypeError("organizationId is required");
  return `/v1/orgs/${encodeURIComponent(organizationId)}/connect`;
}

export function openConnectionSetup(
  setupUrl: string,
  options: OpenConnectionSetupOptions = {},
): Window {
  const url = new URL(setupUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Connection setup URL must use HTTP or HTTPS");
  }
  const open = options.open
    ?? (typeof window !== "undefined" ? window.open.bind(window) : undefined);
  if (!open) throw new Error("Connection setup can only be opened in a browser");
  const popup = open(
    url.toString(),
    options.target ?? "polpo-connect",
    options.features ?? "popup,width=520,height=720,resizable=yes,scrollbars=yes",
  );
  if (!popup) throw new Error("Connection setup popup was blocked");
  return popup;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
