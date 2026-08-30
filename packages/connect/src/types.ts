export type ConnectorAuthType = "api_key" | "oauth2" | "mcp";

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
}

export interface McpAuthConfig {
  type: "mcp";
  auth?: "none" | "bearer" | "oauth2";
  defaultScopes?: string[];
}

export type ConnectorAuthConfig = ApiKeyAuthConfig | OAuth2AuthConfig | McpAuthConfig;

export interface ConnectorHttpAuthPolicy {
  mode: "bearer" | "header" | "query";
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
}

export type ConnectionStatus = "active" | "pending" | "revoked" | "error";

export type ConnectionAudience = "personal" | "shared" | "end_user";

export type ConnectionOwner =
  | ConnectSubject
  | { type: "external_user"; namespace: string; id: string };

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
}

export interface ConnectionRecord {
  id: string;
  providerId: string;
  name?: string;
  projectId?: string;
  orgId?: string;
  owner?: ConnectionOwner;
  audience?: ConnectionAudience;
  oauthClientId?: string;
  providerAccountId?: string;
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
  state: string;
  providerId: string;
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
  audience?: ConnectionAudience;
  binding?: ConnectionBindingAttributes;
  returnUrl?: string;
}

export interface ConnectionSetupSession {
  id: string;
  providerId: string;
  oauthClientId: string;
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

export type McpConnectionAuth = "none" | "bearer";

export interface McpConnectionMetadata extends Record<string, unknown> {
  url: string;
  transport: McpConnectionTransport;
  auth: McpConnectionAuth;
  serverName?: string;
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
      scopes: string[];
      connectionId: string;
      providerId: string;
      metadata?: McpConnectionMetadata;
    };

export interface StoredConnectionSecret {
  kind: "api_key" | "oauth2" | "mcp";
  apiKey?: string;
  tokens?: TokenSet;
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
  listConnections(filter?: ConnectionListFilter): Promise<ConnectionRecord[]>;
  getConnection(id: string): Promise<ConnectionRecord | null>;
  upsertConnection(record: ConnectionRecord): Promise<ConnectionRecord>;
  updateConnection(id: string, patch: Partial<Omit<ConnectionRecord, "id" | "createdAt">>): Promise<ConnectionRecord>;
  deleteConnection(id: string): Promise<void>;
  saveOAuthState(record: OAuthStateRecord): Promise<void>;
  consumeOAuthState(state: string): Promise<OAuthStateRecord | null>;
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
  consumeConnectionSetupSession(id: string, consumedAt: string): Promise<ConnectionSetupSession | null>;
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
