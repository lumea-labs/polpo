import { createHash } from "node:crypto";
import {
  ConnectError, connectorHostnameIsUnsafe,
  type McpOAuthClientResolver, type McpOAuthClientResolverInput, type ResolvedMcpOAuthClient,
} from "@polpo-ai/connect";
import { normalizeMcpOAuthRedirect } from "./mcp-oauth-redirect.js";

export interface McpOAuthSetupClientReference { id: string; fingerprint: string }

function invalid(): never {
  throw new ConnectError("setup_invalid", "MCP OAuth client configuration is unavailable or changed; restart setup");
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) invalid();
  return value.trim();
}

function https(value: unknown, document = false): string {
  let url: URL;
  try { url = new URL(text(value)); } catch { invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || connectorHostnameIsUnsafe(url.hostname)
    || (document && url.pathname === "/")) invalid();
  for (const key of url.searchParams.keys()) {
    if (/^(access_token|refresh_token|client_secret|api[_-]?key|authorization|password|token|secret|code|state)$/i.test(key)) invalid();
  }
  return url.toString();
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) invalid();
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item, depth + 1)]));
  return value;
}

function normalize(client: ResolvedMcpOAuthClient): ResolvedMcpOAuthClient {
  if (!client || !client.owner || !["project", "org", "platform", "instance"].includes(client.owner.type)
    || !["http", "sse"].includes(client.transport) || !client.registration) invalid();
  const registration = client.registration;
  let normalized: ResolvedMcpOAuthClient["registration"];
  if (registration.mode === "dynamic") normalized = { mode: "dynamic", clientName: text(registration.clientName),
    ...(registration.clientUri ? { clientUri: https(registration.clientUri) } : {}) };
  else if (registration.mode === "metadata_document") normalized = { mode: "metadata_document", clientMetadataUrl: https(registration.clientMetadataUrl, true) };
  else if (registration.mode === "pre_registered") {
    if (!registration.client || typeof registration.client !== "object" || Array.isArray(registration.client)) invalid();
    let serialized: string;
    try { serialized = JSON.stringify(registration.client); } catch { invalid(); }
    if (serialized.length > 16_384) invalid();
    normalized = { mode: "pre_registered", client: { ...JSON.parse(serialized), client_id: text(registration.client.client_id) } };
  } else invalid();
  let redirectUri: string;
  try { redirectUri = normalizeMcpOAuthRedirect(text(client.redirectUri)); } catch { invalid(); }
  return { id: text(client.id), providerId: text(client.providerId),
    ...(client.authenticationId ? { authenticationId: text(client.authenticationId) } : {}),
    owner: { type: client.owner.type, id: text(client.owner.id) }, resourceUrl: https(client.resourceUrl),
    transport: client.transport, redirectUri, registration: normalized };
}

function resolved(raw: ResolvedMcpOAuthClient) {
  const client = normalize(raw);
  const registration = structuredClone(client.registration);
  if (registration.mode === "pre_registered") {
    // Secret rotation keeps the registered client identity. It is resolved live.
    delete registration.client.client_secret;
    delete registration.client.client_secret_expires_at;
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical({ ...client, registration }))).digest("hex");
  return { client, reference: { id: client.id, fingerprint }, registrationNamespace: fingerprint };
}

/** Host configuration lookup only: no provider I/O and no browser-owned identity. */
export async function resolveMcpOAuthSetupClient(resolver: McpOAuthClientResolver, input: McpOAuthClientResolverInput) {
  const result = resolved(await resolver.resolve(input));
  const client = result.client;
  if (client.providerId !== input.providerId || (input.authenticationId && client.authenticationId !== input.authenticationId)
    || (input.configurationId && client.id !== input.configurationId)) invalid();
  const mode = input.mode ?? "managed";
  const ownerAllowed = mode === "customer"
    ? (client.owner.type === "project" && client.owner.id === input.projectId) || (client.owner.type === "org" && client.owner.id === input.orgId)
    : mode === "instance" ? client.owner.type === "instance" : mode === "managed" && client.owner.type === "platform";
  if (!ownerAllowed) invalid();
  return result;
}

/** Re-resolve before start/callback/activation; a saved ID is not permanent authorization. */
export async function verifyMcpOAuthSetupClient(resolver: McpOAuthClientResolver, reference: McpOAuthSetupClientReference) {
  const client = await resolver.resolveById(reference.id);
  if (!client) invalid();
  const result = resolved(client);
  if (result.reference.id !== reference.id || result.reference.fingerprint !== reference.fingerprint) invalid();
  return result;
}
