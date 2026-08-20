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
  clientId?: string;
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
}

export type ConnectionStatus = "active" | "pending" | "revoked" | "error";

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
  owner?: ConnectSubject;
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
  subject?: ConnectSubject;
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
  owner?: ConnectSubject;
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

export interface ConnectPolicyDecisionInput {
  connection: ConnectionRecord;
  subject?: ConnectSubject;
  scopes: string[];
  actionId?: string;
}

export interface ConnectPolicy {
  canUseConnection(input: ConnectPolicyDecisionInput): Promise<boolean> | boolean;
}
