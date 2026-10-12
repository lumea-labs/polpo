import { ConnectError } from "./errors.js";
import { connectorHostnameIsUnsafe, normalizeConnectorHttpPolicy } from "./http-policy.js";
import { normalizeScopes } from "./scopes.js";
import { normalizeConnectorVerification } from "./verification.js";
import type {
  ConnectorAuthConfig, ConnectorHttpAuthPolicy, ConnectorHttpPolicy,
  ConnectorProtocol, ConnectorProviderDefinition, OAuth2AuthConfig,
} from "./types.js";

interface AuthenticationBase {
  id: string;
  label?: string;
  defaultScopes?: string[];
}

export interface ConnectorKeyAuthentication extends AuthenticationBase {
  type: "api_key";
  injection: ConnectorHttpAuthPolicy & { mode: "bearer" | "header" | "query" };
}

export interface ConnectorOAuthAuthentication extends AuthenticationBase,
  Omit<OAuth2AuthConfig, "type" | "clientId" | "clientSecret"> {
  type: "oauth2";
}

export interface ConnectorDiscoveredOAuthAuthentication extends AuthenticationBase {
  type: "oauth2";
  discovery: true;
}

export interface ConnectorPublicAuthentication extends AuthenticationBase {
  type: "none";
}

export type ConnectorAuthentication = ConnectorKeyAuthentication
  | ConnectorOAuthAuthentication | ConnectorDiscoveredOAuthAuthentication
  | ConnectorPublicAuthentication;

interface ConnectorDefinitionBase extends Pick<ConnectorProviderDefinition,
  "id" | "name" | "description" | "icon" | "scopes" | "actions" | "triggers" | "allowCustomScopes" | "verification"> {
  version: 2;
  source: "catalog" | "custom";
  defaultAuthenticationId: string;
}

export type ConnectorDefinition = ConnectorDefinitionBase & (
  | {
    protocol: "http_api";
    authentication: Array<ConnectorKeyAuthentication | ConnectorOAuthAuthentication | ConnectorPublicAuthentication>;
    http: Omit<ConnectorHttpPolicy, "auth">;
  }
  | {
    protocol: "mcp";
    authentication: Array<ConnectorKeyAuthentication | ConnectorDiscoveredOAuthAuthentication | ConnectorPublicAuthentication>;
  }
);

export interface ConnectorCatalogEntry extends Pick<ConnectorProviderDefinition,
  "id" | "name" | "description" | "icon" | "scopes" | "actions" | "triggers" | "allowCustomScopes" | "verification"> {
  kind: "integration" | "credential";
  protocol: ConnectorProtocol | null;
  source: "catalog" | "custom" | "legacy";
  defaultAuthenticationId: string;
  authentication: ConnectorAuthentication[];
  http?: Omit<ConnectorHttpPolicy, "auth">;
}

const RESERVED_OAUTH_PARAMS = new Set([
  "client_id", "client_secret", "redirect_uri", "response_type", "grant_type",
  "scope", "state", "code", "code_verifier", "code_challenge", "code_challenge_method",
  "refresh_token", "access_token",
]);

function invalid(message: string): never {
  throw new ConnectError("invalid_provider", message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function knownKeys(input: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) invalid(`${name} contains an unsupported field`);
}

function jsonDocument(value: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 32) invalid("Connector JSON document exceeds its structural limit");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (!entry || typeof entry !== "object" || seen.has(entry)) invalid("Connector document must contain finite JSON values");
    if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) {
      invalid("Connector document must contain plain JSON objects");
    }
    seen.add(entry);
    for (const child of Object.values(entry)) visit(child, depth + 1);
    seen.delete(entry);
  };
  visit(value, 0);
  if (JSON.stringify(value).length > 65_536) invalid("Connector JSON document is too large");
  return structuredClone(value);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) invalid(`${name} is invalid`);
  return value.trim();
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) invalid(`${name} is invalid`);
  return result;
}

function scopes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128 || value.some((v) => typeof v !== "string" || v.length > 2048)) {
    invalid("Authentication scopes are invalid");
  }
  return normalizeScopes(value as string[]);
}

function endpoint(value: unknown, name: string): string {
  let url: URL;
  try { url = new URL(text(value, name)); } catch { invalid(`${name} must be a public HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || connectorHostnameIsUnsafe(url.hostname)) invalid(`${name} must be a public HTTPS URL`);
  for (const key of url.searchParams.keys()) {
    if (RESERVED_OAUTH_PARAMS.has(key.toLowerCase())) invalid(`${name} cannot override OAuth parameters`);
  }
  return url.toString();
}

function parameters(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, name);
  const result: Record<string, string> = {};
  if (Object.keys(input).length > 32) invalid(`${name} has too many parameters`);
  for (const [key, value] of Object.entries(input)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(key) || RESERVED_OAUTH_PARAMS.has(key.toLowerCase())) {
      invalid(`${name} cannot override reserved OAuth parameters`);
    }
    result[key] = text(value, name);
  }
  return result;
}

function normalizeIdentity(value: unknown): NonNullable<OAuth2AuthConfig["identity"]> {
  const input = record(value, "OAuth identity policy");
  knownKeys(input, ["method", "issuer", "url", "requiredScopes", "scopeAliases"], "OAuth identity policy");
  if (input.method !== "userinfo") invalid("Unsupported OAuth identity method");
  const issuer = endpoint(input.issuer, "OAuth identity issuer");
  if (new URL(issuer).search) invalid("OAuth identity issuer cannot contain a query");
  const requiredScopes = scopes(input.requiredScopes);
  if (!requiredScopes?.length) invalid("OAuth identity scopes are required");
  const aliases: Record<string, string> = Object.create(null);
  if (input.scopeAliases !== undefined) {
    for (const [alias, canonical] of Object.entries(record(input.scopeAliases, "OAuth scope aliases"))) {
      const target = text(canonical, "OAuth scope alias");
      if (!alias.trim() || alias.length > 2048 || !requiredScopes.includes(target)
        || requiredScopes.includes(alias) || Object.keys(aliases).length >= 32) invalid("Invalid OAuth scope alias");
      aliases[alias] = target;
    }
  }
  return { method: "userinfo", issuer: text(input.issuer, "OAuth identity issuer"),
    url: endpoint(input.url, "OAuth UserInfo endpoint"), requiredScopes,
    ...(Object.keys(aliases).length ? { scopeAliases: aliases } : {}) };
}

/** Immutable, non-secret JSON definitions are safe to persist and expose in catalogs. */
export function normalizeConnectorDefinition(value: unknown): ConnectorDefinition {
  const input = record(value, "Connector definition");
  knownKeys(input, ["version", "id", "name", "description", "icon", "source", "protocol", "defaultAuthenticationId",
    "authentication", "scopes", "actions", "triggers", "allowCustomScopes", "http", "verification"], "Connector definition");
  if (input.version !== 2) invalid("Unsupported Connector definition version");
  if (input.protocol !== "http_api" && input.protocol !== "mcp") invalid("Unsupported Connector protocol");
  if (input.source !== "catalog" && input.source !== "custom") invalid("Unsupported Connector source");
  if (!Array.isArray(input.authentication) || input.authentication.length === 0 || input.authentication.length > 16) {
    invalid("Connector must declare between 1 and 16 authentication methods");
  }
  const authentication: ConnectorAuthentication[] = input.authentication.map((value) => {
    const auth = record(value, "Connector authentication");
    for (const key of ["clientId", "clientSecret", "apiKey", "accessToken", "refreshToken", "secretRef", "bearerToken"]) {
      if (key in auth) invalid("Connector authentication cannot contain client credentials or account secrets");
    }
    const common = ["id", "label", "type", "defaultScopes"];
    knownKeys(auth, [...common, ...(auth.type === "api_key" ? ["injection"] : auth.type === "oauth2"
      ? input.protocol === "mcp" ? ["discovery"]
        : ["authorizationUrl", "tokenUrl", "revokeUrl", "supportsPkce", "extraAuthorizeParams", "extraTokenParams", "identity"] : [])], "Connector authentication");
    const base: AuthenticationBase = {
      id: identifier(auth.id, "Authentication id"),
      ...(auth.label === undefined ? {} : { label: text(auth.label, "Authentication label") }),
      ...(auth.defaultScopes === undefined ? {} : { defaultScopes: scopes(auth.defaultScopes) }),
    };
    if (auth.type === "none") return { ...base, type: "none" };
    if (auth.type === "api_key") {
      const injection = record(auth.injection, "API key injection");
      knownKeys(injection, ["mode", "name"], "API key injection");
      if (!["bearer", "header", "query"].includes(String(injection.mode))
        || (input.protocol === "mcp" && injection.mode === "query")) invalid("Unsupported API key injection");
      const policy = normalizeConnectorHttpPolicy({
        origins: ["https://policy-validation.example.com"],
        auth: injection as unknown as ConnectorHttpAuthPolicy,
      });
      return { ...base, type: "api_key", injection: policy.auth as ConnectorKeyAuthentication["injection"] };
    }
    if (auth.type !== "oauth2") invalid("Unsupported Connector authentication method");
    if (input.protocol === "mcp") {
      if (auth.discovery !== true || auth.authorizationUrl !== undefined || auth.tokenUrl !== undefined) {
        invalid("MCP OAuth requires protocol discovery, not API OAuth endpoint configuration");
      }
      return { ...base, type: "oauth2", discovery: true };
    }
    if (auth.discovery !== undefined) invalid("HTTP API OAuth requires explicit endpoints");
    if (auth.supportsPkce !== undefined && typeof auth.supportsPkce !== "boolean") invalid("supportsPkce must be a boolean");
    return {
      ...base, type: "oauth2",
      authorizationUrl: endpoint(auth.authorizationUrl, "authorizationUrl"),
      tokenUrl: endpoint(auth.tokenUrl, "tokenUrl"),
      ...(auth.revokeUrl === undefined ? {} : { revokeUrl: endpoint(auth.revokeUrl, "revokeUrl") }),
      ...(auth.supportsPkce === undefined ? {} : { supportsPkce: auth.supportsPkce }),
      ...(auth.extraAuthorizeParams === undefined ? {} : { extraAuthorizeParams: parameters(auth.extraAuthorizeParams, "extraAuthorizeParams") }),
      ...(auth.extraTokenParams === undefined ? {} : { extraTokenParams: parameters(auth.extraTokenParams, "extraTokenParams") }),
      ...(auth.identity === undefined ? {} : { identity: normalizeIdentity(auth.identity) }),
    };
  });
  const ids = new Set(authentication.map((auth) => auth.id));
  if (ids.size !== authentication.length) invalid("Duplicate Connector authentication id");
  const defaultAuthenticationId = identifier(input.defaultAuthenticationId, "Default authentication id");
  if (!ids.has(defaultAuthenticationId)) invalid("Default authentication is not supported");
  const base = {
    version: 2 as const, id: identifier(input.id, "Connector id"),
    name: text(input.name, "Connector name"), source: input.source,
    defaultAuthenticationId, authentication,
    ...(input.description === undefined ? {} : { description: text(input.description, "Connector description") }),
    ...(input.icon === undefined ? {} : { icon: text(input.icon, "Connector icon") }),
    ...normalizeOperations({ ...input, authentication }),
  };
  if (base.id.length < 2) invalid("Connector id must contain at least two characters");
  if (input.protocol === "mcp") {
    if (input.http !== undefined) invalid("MCP definitions cannot declare an HTTP API policy");
    const verification = input.verification === undefined ? undefined : normalizeConnectorVerification(input.verification, "mcp");
    if (verification && !input.allowCustomScopes && verification.scopes?.some((scope) => !base.scopes?.some((candidate) => candidate.id === scope))) {
      invalid("Verification references an undeclared scope");
    }
    return freezeConnectorValue({ ...base, protocol: "mcp",
      ...(verification ? { verification } : {}),
    }) as ConnectorDefinition;
  }
  const http = record(input.http, "HTTP API policy");
  if ("auth" in http) invalid("HTTP authentication belongs to the selected authentication method");
  const { auth: _auth, ...policy } = normalizeConnectorHttpPolicy({ ...http, auth: { mode: "none" } } as ConnectorHttpPolicy);
  const verification = input.verification === undefined ? undefined : normalizeConnectorVerification(input.verification, "http_api", { ...policy, auth: { mode: "none" } });
  if (verification?.kind === "http" && verification.account && authentication.some((method) => method.type === "none")) {
    invalid("A public authentication method cannot verify account credentials");
  }
  if (verification && !input.allowCustomScopes) {
    const allowed = new Set((base.scopes ?? []).map((scope) => scope.id));
    if (verification.scopes?.some((scope) => !allowed.has(scope))) invalid("Verification references an undeclared scope");
  }
  return freezeConnectorValue({ ...base, protocol: "http_api", http: policy, ...(verification ? { verification } : {}) }) as ConnectorDefinition;
}

function normalizeOperations(input: Record<string, unknown>): Pick<ConnectorProviderDefinition,
  "scopes" | "actions" | "triggers" | "allowCustomScopes"> {
  const result: Record<string, unknown> = {};
  if (input.allowCustomScopes !== undefined) {
    if (typeof input.allowCustomScopes !== "boolean") invalid("allowCustomScopes must be a boolean");
    result.allowCustomScopes = input.allowCustomScopes;
  }
  for (const name of ["scopes", "actions", "triggers"] as const) {
    if (input[name] === undefined) continue;
    if (!Array.isArray(input[name]) || input[name].length > 256) invalid(`Connector ${name} must be an array`);
    const ids = new Set<string>();
    result[name] = input[name].map((value: unknown) => {
      const entry = record(value, name);
      knownKeys(entry, name === "scopes" ? ["id", "label", "description", "required", "dangerous"]
        : name === "actions" ? ["id", "label", "description", "scopes", "risk", "inputSchema", "outputSchema", "metadata"]
          : ["id", "label", "description", "scopes", "metadata"], `Connector ${name}`);
      const id = name === "scopes" ? text(entry.id, "Scope id") : identifier(entry.id, "Operation id");
      if (ids.has(id)) invalid(`Duplicate Connector ${name} id`);
      ids.add(id);
      const copy: Record<string, unknown> = { id };
      for (const field of ["label", "description"]) if (entry[field] !== undefined) copy[field] = text(entry[field], field);
      if (name === "scopes") {
        for (const field of ["required", "dangerous"]) {
          if (entry[field] !== undefined && typeof entry[field] !== "boolean") invalid(`Scope ${field} must be a boolean`);
          if (entry[field] !== undefined) copy[field] = entry[field];
        }
      } else {
        if (entry.scopes !== undefined) copy.scopes = scopes(entry.scopes);
        if (entry.metadata !== undefined) copy.metadata = jsonDocument(record(entry.metadata, "Operation metadata"));
        for (const field of ["inputSchema", "outputSchema"]) if (entry[field] !== undefined) copy[field] = jsonDocument(entry[field]);
        if (entry.risk !== undefined) {
          if (!["read", "write", "admin"].includes(String(entry.risk))) invalid("Unsupported operation risk");
          copy.risk = entry.risk;
        }
      }
      return copy;
    });
  }
  const knownScopes = new Set((result.scopes as Array<{ id: string }> | undefined)?.map((entry) => entry.id));
  if (!input.allowCustomScopes) {
    const uses = [
      ...(input.authentication as Array<{ defaultScopes?: string[] }>).flatMap((auth) => scopes(auth.defaultScopes) ?? []),
      ...(input.authentication as Array<{ identity?: { requiredScopes: string[] } }>).flatMap((auth) => auth.identity?.requiredScopes ?? []),
      ...([...(result.actions as Array<{ scopes?: string[] }> ?? []), ...(result.triggers as Array<{ scopes?: string[] }> ?? [])])
        .flatMap((operation) => operation.scopes ?? []),
    ];
    if (uses.some((scope) => !knownScopes.has(scope))) invalid("Connector references an undeclared scope");
  }
  return result;
}

/** Selects one method for existing execution adapters; the authored definition remains intact. */
export function compileConnectorDefinition(value: ConnectorDefinition, authenticationId?: string): ConnectorProviderDefinition {
  const definition = normalizeConnectorDefinition(value);
  const selected = authenticationId ?? definition.defaultAuthenticationId;
  const method = definition.authentication.find((candidate) => candidate.id === selected);
  if (!method) throw new ConnectError("unsupported_auth", `Unsupported authentication: ${selected}`);
  let auth: ConnectorAuthConfig;
  if (definition.protocol === "mcp") {
    auth = {
      type: "mcp", defaultScopes: method.defaultScopes,
      auth: method.type === "api_key" ? method.injection.mode as "bearer" | "header" : method.type,
      ...(method.type === "api_key" && method.injection.mode === "header" ? { headerName: method.injection.name } : {}),
    };
  } else if (method.type === "api_key") {
    auth = {
      type: "api_key", defaultScopes: method.defaultScopes,
      ...(method.injection.mode === "header" ? { headerName: method.injection.name } : {}),
      ...(method.injection.mode === "query" ? { queryParam: method.injection.name } : {}),
    };
  } else if (method.type === "oauth2" && "authorizationUrl" in method) {
    const { id: _id, label: _label, ...config } = method;
    auth = config;
  } else {
    auth = { type: "none", defaultScopes: method.defaultScopes };
  }
  return freezeConnectorValue({
    id: definition.id, name: definition.name, description: definition.description,
    icon: definition.icon, source: definition.source, protocol: definition.protocol,
    scopes: definition.scopes, actions: definition.actions, triggers: definition.triggers,
    allowCustomScopes: definition.allowCustomScopes, auth, authenticationId: selected,
    verification: definition.verification,
    http: definition.protocol === "http_api"
      ? normalizeConnectorHttpPolicy({
        ...definition.http,
        auth: method.type === "api_key" ? method.injection : { mode: method.type === "none" ? "none" : "bearer" },
      }) : undefined,
  });
}

export function describeConnector(provider: ConnectorProviderDefinition | ConnectorDefinition): ConnectorCatalogEntry {
  if ("version" in provider && provider.version === 2) {
    const { version: _version, ...definition } = normalizeConnectorDefinition(provider);
    return freezeConnectorValue({ ...definition, kind: "integration" });
  }
  const legacy = provider as ConnectorProviderDefinition;
  const id = legacy.authenticationId ?? "default";
  let authentication: ConnectorAuthentication;
  if (legacy.auth.type === "mcp") {
    authentication = legacy.auth.auth === "oauth2"
      ? { id, type: "oauth2", discovery: true, defaultScopes: legacy.auth.defaultScopes }
      : legacy.auth.auth === "none"
        ? { id, type: "none", defaultScopes: legacy.auth.defaultScopes }
        : { id, type: "api_key", injection: legacy.auth.auth === "header"
          ? { mode: "header", name: legacy.auth.headerName } : { mode: "bearer" }, defaultScopes: legacy.auth.defaultScopes };
  } else if (legacy.auth.type === "oauth2") {
    const { clientId: _clientId, clientSecret: _secret, ...auth } = legacy.auth;
    authentication = { ...auth, id };
  } else if (legacy.auth.type === "none") {
    authentication = { ...legacy.auth, id };
  } else {
    authentication = { id, type: "api_key", defaultScopes: legacy.auth.defaultScopes,
      injection: (legacy.http?.auth ?? (legacy.auth.headerName ? { mode: "header", name: legacy.auth.headerName }
        : legacy.auth.queryParam ? { mode: "query", name: legacy.auth.queryParam } : { mode: "bearer" })) as ConnectorKeyAuthentication["injection"] };
  }
  const credentialOnly = legacy.auth.type === "api_key" && !legacy.http;
  const { auth: _httpAuth, ...http } = legacy.http ?? {};
  return freezeConnectorValue({
    id: legacy.id, name: legacy.name, description: legacy.description, icon: legacy.icon,
    scopes: structuredClone(legacy.scopes), actions: structuredClone(legacy.actions), triggers: structuredClone(legacy.triggers),
    allowCustomScopes: legacy.allowCustomScopes, kind: credentialOnly ? "credential" : "integration",
    source: legacy.source ?? "legacy", protocol: credentialOnly ? null : legacy.auth.type === "mcp" ? "mcp" : "http_api",
    defaultAuthenticationId: id, authentication: [authentication],
    verification: structuredClone(legacy.verification),
    ...(legacy.http ? { http: http as Omit<ConnectorHttpPolicy, "auth"> } : {}),
  });
}

/** Compatibility projection for old catalog consumers; never expose OAuth client secrets. */
export function sanitizeConnectorProvider(provider: ConnectorProviderDefinition): ConnectorProviderDefinition {
  const copy = structuredClone(provider);
  if (copy.auth.type === "oauth2") {
    delete copy.auth.clientId;
    delete copy.auth.clientSecret;
  }
  return freezeConnectorValue(copy);
}

export function freezeConnectorValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeConnectorValue(child);
    Object.freeze(value);
  }
  return value;
}
