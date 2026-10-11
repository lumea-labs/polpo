import {
  ConnectError, compileConnectorDefinition, normalizeConnectorDefinition,
  type ConnectorActionGateway, type ConnectorActionRequest, type ConnectorDefinition,
} from "@polpo-ai/connect";

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"];
export type GoogleActionGateway = ConnectorActionGateway;

const string = (description: string, maxLength = 2048) => ({ type: "string", minLength: 1, maxLength, description });
const pageSize = (maximum: number) => ({ type: "integer", minimum: 1, maximum, default: 20 });
// Some structured tool callers require every property to be present. Explicit
// null gives optional arguments an absence value without inventing resource IDs
// or continuation tokens. Required resource IDs remain non-nullable.
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", additionalProperties: false, required,
  properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => [name,
    required.includes(name) ? property : { anyOf: [property, { type: "null" }], description: "Omit or pass null when unused." },
  ])),
});
const maxChars = { type: "integer", minimum: 1, maximum: 100_000, default: 20_000 };
const oauth = (scope: string) => [{
  id: "oauth", type: "oauth2" as const,
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  supportsPkce: true, defaultScopes: [scope],
  identity: { method: "userinfo" as const, issuer: "https://accounts.google.com",
    url: "https://openidconnect.googleapis.com/v1/userinfo", requiredScopes: GOOGLE_IDENTITY_SCOPES,
    scopeAliases: { "https://www.googleapis.com/auth/userinfo.email": "email" } },
  extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
}];

export const gmailDefinition: ConnectorDefinition = normalizeConnectorDefinition({
  version: 2, id: "gmail", name: "Gmail", source: "catalog", protocol: "http_api",
  description: "Search and read messages in the connected Gmail account.",
  defaultAuthenticationId: "oauth", authentication: oauth(GMAIL_READ_SCOPE),
  scopes: [{ id: GMAIL_READ_SCOPE, label: "Read Gmail messages" },
    { id: "openid", label: "Identify your Google account", required: true }, { id: "email", label: "Account email", required: true }],
  verification: { kind: "http", path: "/gmail/v1/users/me/profile", scopes: [GMAIL_READ_SCOPE], account: { idPath: ["emailAddress"] } },
  http: { origins: ["https://gmail.googleapis.com"], allowedMethods: ["GET"],
    allowedPathPatterns: ["/gmail/v1/users/me/messages", "/gmail/v1/users/me/messages/*", "/gmail/v1/users/me/profile"],
    maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 30_000 },
  actions: [
    { id: "gmail_search_messages", label: "Search messages", risk: "read", scopes: [GMAIL_READ_SCOPE],
      description: "Search the connected mailbox. Returns message IDs for gmail_read_message and a continuation token.",
      inputSchema: schema({ query: string("Gmail search query"), pageSize: pageSize(100), pageToken: string("Continuation token", 4096) }) },
    { id: "gmail_read_message", label: "Read message", risk: "read", scopes: [GMAIL_READ_SCOPE],
      description: "Read one message with bounded text and attachment metadata. Does not download attachments or mark it as read.",
      inputSchema: schema({ messageId: string("Message ID", 256), maxChars }, ["messageId"]) },
  ],
});

export const googleDriveDefinition: ConnectorDefinition = normalizeConnectorDefinition({
  version: 2, id: "google_drive", name: "Google Drive", source: "catalog", protocol: "http_api",
  description: "Search and read accessible files in My Drive and shared drives.",
  defaultAuthenticationId: "oauth", authentication: oauth(DRIVE_READ_SCOPE),
  scopes: [{ id: DRIVE_READ_SCOPE, label: "Read Drive files" },
    { id: "openid", label: "Identify your Google account", required: true }, { id: "email", label: "Account email", required: true }],
  verification: { kind: "http", path: "/drive/v3/about", query: { fields: "user(permissionId,displayName,emailAddress)" },
    scopes: [DRIVE_READ_SCOPE], account: { idPath: ["user", "permissionId"], labelPath: ["user", "displayName"] } },
  http: { origins: ["https://www.googleapis.com"], allowedMethods: ["GET"],
    allowedPathPatterns: ["/drive/v3/files", "/drive/v3/files/*", "/drive/v3/about"],
    maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 30_000 },
  actions: [
    { id: "drive_search_files", label: "Search files", risk: "read", scopes: [DRIVE_READ_SCOPE],
      description: "Search accessible Drive files, optionally within one shared drive. A search filter does not grant or restrict permissions.",
      inputSchema: schema({ query: string("Drive files search expression"), driveId: string("Optional shared drive ID", 256),
        pageSize: pageSize(100), pageToken: string("Continuation token", 4096) }) },
    { id: "drive_read_file", label: "Read file", risk: "read", scopes: [DRIVE_READ_SCOPE],
      description: "Read a file up to 2 MiB. Export Google documents as text; CSV exports of spreadsheets contain the first sheet only.",
      inputSchema: schema({ fileId: string("Drive file ID", 256), mimeType: { type: "string", enum: ["text/plain", "text/csv", "text/html", "application/pdf"] }, maxChars }, ["fileId"]) },
  ],
});

export const gmailConnector = compileConnectorDefinition(gmailDefinition);

/** Executes only through an already authorized gateway supplied by the host. */
export async function executeGoogleAction(
  actionId: string,
  input: unknown,
  context: { request: GoogleActionGateway },
): Promise<unknown> {
  const definition = [gmailDefinition, googleDriveDefinition].find((entry) => entry.actions?.some((action) => action.id === actionId));
  const action = definition?.actions?.find((entry) => entry.id === actionId);
  if (!action) throw new ConnectError("invalid_request", "Unsupported Google action");
  const args = argumentsObject(input, Object.keys((action.inputSchema as { properties: Record<string, unknown> }).properties));
  const request = async (request: ConnectorActionRequest["request"]): Promise<unknown> => {
    const response = await context.request({ actionId, scopes: [...action.scopes!], request });
    if (response.status < 200 || response.status >= 300) {
      throw new ConnectError("http_error", "Google rejected the operation", { details: { providerStatus: response.status } });
    }
    return response.body;
  };
  if (actionId === "gmail_search_messages") {
    const query: Record<string, string> = { maxResults: String(integer(args.pageSize, 20, 100)) };
    optionalQuery(args, query, "query", "q");
    optionalQuery(args, query, "pageToken", "pageToken", 4096);
    const result = responseObject(await request({ method: "GET", path: "/gmail/v1/users/me/messages", query }));
    const messages = responseArray(result.messages).map((message) => {
      const entry = responseObject(message);
      return { id: responseText(entry.id), threadId: responseText(entry.threadId) };
    });
    return { messages, ...pagination(result), ...(typeof result.resultSizeEstimate === "number" ? { resultSizeEstimate: result.resultSizeEstimate } : {}) };
  }
  if (actionId === "gmail_read_message") {
    const id = resourceId(args.messageId);
    const limit = integer(args.maxChars, 20_000, 100_000);
    const result = responseObject(await request({ method: "GET", path: `/gmail/v1/users/me/messages/${id}`, query: { format: "full" } }));
    if (result.id !== id) throw invalidResponse();
    return readMessage(result, limit);
  }
  if (actionId === "drive_search_files") {
    const query: Record<string, string> = {
      q: "trashed = false", pageSize: String(integer(args.pageSize, 20, 100)),
      supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "user",
      fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,webViewLink,modifiedTime,size,driveId)",
    };
    optionalQuery(args, query, "query", "q");
    optionalQuery(args, query, "pageToken", "pageToken", 4096);
    if (args.driveId !== undefined) { query.driveId = resourceId(args.driveId); query.corpora = "drive"; }
    const result = responseObject(await request({ method: "GET", path: "/drive/v3/files", query }));
    return { files: responseArray(result.files).map(fileMetadata), ...pagination(result), incompleteSearch: result.incompleteSearch === true };
  }
  const id = resourceId(args.fileId);
  const limit = integer(args.maxChars, 20_000, 100_000);
  const requestedMime = args.mimeType === undefined ? undefined : argumentText(args.mimeType, 100);
  if (requestedMime && !["text/plain", "text/csv", "text/html", "application/pdf"].includes(requestedMime)) {
    throw new ConnectError("invalid_request", "Unsupported export MIME type");
  }
  const metadata = fileMetadata(await request({ method: "GET", path: `/drive/v3/files/${id}`,
    query: { supportsAllDrives: "true", fields: "id,name,mimeType,webViewLink,size,driveId" } }));
  if (metadata.id !== id || typeof metadata.mimeType !== "string") throw invalidResponse();
  if (metadata.mimeType === "application/vnd.google-apps.folder" || metadata.mimeType === "application/vnd.google-apps.shortcut") {
    throw new ConnectError("invalid_request", "Choose a file rather than a folder or shortcut");
  }
  if (metadata.size !== undefined && Number(metadata.size) > 2 * 1024 * 1024) {
    throw new ConnectError("http_error", "File exceeds the Connector response limit", { details: { category: "response_too_large" } });
  }
  const workspaceFile = metadata.mimeType.startsWith("application/vnd.google-apps.");
  const exportMime = requestedMime ?? (metadata.mimeType === "application/vnd.google-apps.spreadsheet" ? "text/csv" : "text/plain");
  const content = await request({ method: "GET", path: `/drive/v3/files/${id}${workspaceFile ? "/export" : ""}`,
    query: workspaceFile ? { mimeType: exportMime } : { alt: "media", supportsAllDrives: "true" } });
  return { ...metadata, content: typeof content === "string" ? content.slice(0, limit) : content,
    truncated: typeof content === "string" && content.length > limit,
    ...(workspaceFile ? { exportMimeType: exportMime } : {}),
    ...(metadata.mimeType === "application/vnd.google-apps.spreadsheet" && exportMime === "text/csv" ? { exportScope: "first_sheet" } : {}),
  };
}

function argumentsObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ConnectError("invalid_request", "Invalid Google action arguments");
  }
  // Unknown arguments were rejected above, including unknown null-valued keys.
  // A required null ID becomes absent and is rejected by resourceId below.
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}
function argumentText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new ConnectError("invalid_request", "Invalid Google action argument");
  return value;
}
function resourceId(value: unknown): string {
  const id = argumentText(value, 256);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ConnectError("invalid_request", "Invalid Google resource ID");
  return id;
}
function integer(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ConnectError("invalid_request", "Argument is outside its supported range");
  return value;
}
function optionalQuery(args: Record<string, unknown>, query: Record<string, string>, input: string, output: string, maximum = 2048) {
  if (args[input] !== undefined) query[output] = argumentText(args[input], maximum);
}
function invalidResponse() { return new ConnectError("http_error", "Google returned an invalid response", { details: { category: "invalid_response" } }); }
function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
function responseText(value: unknown): string {
  if (typeof value !== "string" || !value) throw invalidResponse();
  return value;
}
function responseArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw invalidResponse();
  return value;
}
function pagination(value: Record<string, unknown>) {
  return value.nextPageToken === undefined ? {} : { nextPageToken: responseText(value.nextPageToken) };
}
function fileMetadata(value: unknown): Record<string, string> {
  const input = responseObject(value);
  const result: Record<string, string> = { id: responseText(input.id) };
  for (const key of ["name", "mimeType", "webViewLink", "modifiedTime", "size", "driveId"]) {
    if (input[key] !== undefined) result[key] = responseText(input[key]);
  }
  return result;
}
function readMessage(message: Record<string, unknown>, limit: number): Record<string, unknown> {
  const payload = responseObject(message.payload);
  const headers: Record<string, string> = {};
  for (const value of responseArray(payload.headers)) {
    const header = responseObject(value);
    if (typeof header.name === "string" && typeof header.value === "string") headers[header.name.toLowerCase()] = header.value;
  }
  const text: string[] = [], html: string[] = [], attachments: Record<string, unknown>[] = [];
  const pending = [{ value: payload, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { value, depth } = pending.shift()!;
    if (++count > 256 || depth > 20) throw invalidResponse();
    const body = value.body === undefined ? {} : responseObject(value.body);
    if (body.attachmentId !== undefined) {
      attachments.push({ id: responseText(body.attachmentId), filename: value.filename ?? "", mimeType: value.mimeType, size: body.size });
    } else if ((value.mimeType === "text/plain" || value.mimeType === "text/html") && body.data !== undefined) {
      if (typeof body.data !== "string" || !/^[A-Za-z0-9_=-]*$/.test(body.data)) throw invalidResponse();
      try {
        const decoded = new TextDecoder().decode(Uint8Array.from(atob(body.data.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)));
        (value.mimeType === "text/plain" ? text : html).push(decoded);
      } catch { throw invalidResponse(); }
    }
    for (const child of responseArray(value.parts)) pending.push({ value: responseObject(child), depth: depth + 1 });
  }
  const content = (text.length ? text : html).join("\n");
  return { id: responseText(message.id), threadId: responseText(message.threadId),
    subject: headers.subject ?? "", from: headers.from ?? "", to: headers.to ?? "", date: headers.date ?? "",
    snippet: typeof message.snippet === "string" ? message.snippet : "", text: content.slice(0, limit),
    contentType: text.length ? "text/plain" : "text/html", truncated: content.length > limit, attachments };
}
