import { ConnectError, type ConnectorDefinition } from "@polpo-ai/connect";
import { defineConnectorContribution } from "../../contribution.js";
import {
  DRIVE_READ_SCOPE,
  actionArguments,
  actionRequest,
  argumentText,
  googleOAuth,
  integer,
  invalidGoogleResponse,
  maxCharsSchema,
  objectSchema,
  optionalQuery,
  pageSizeSchema,
  pagination,
  resourceId,
  responseArray,
  responseObject,
  responseText,
  stringSchema,
} from "../google-common.js";

export { DRIVE_READ_SCOPE } from "../google-common.js";

const authoredGoogleDriveDefinition: ConnectorDefinition = {
  version: 2,
  id: "google_drive",
  name: "Google Drive",
  source: "catalog",
  protocol: "http_api",
  description: "Search and read accessible files in My Drive and shared drives.",
  defaultAuthenticationId: "oauth",
  authentication: googleOAuth(DRIVE_READ_SCOPE),
  scopes: [
    { id: DRIVE_READ_SCOPE, label: "Read Drive files" },
    { id: "openid", label: "Identify your Google account", required: true },
    { id: "email", label: "Account email", required: true },
  ],
  verification: {
    kind: "http",
    path: "/drive/v3/about",
    query: { fields: "user(permissionId,displayName,emailAddress)" },
    scopes: [DRIVE_READ_SCOPE],
    account: { idPath: ["user", "permissionId"], labelPath: ["user", "displayName"] },
  },
  http: {
    origins: ["https://www.googleapis.com"],
    allowedMethods: ["GET"],
    allowedPathPatterns: ["/drive/v3/files", "/drive/v3/files/*", "/drive/v3/about"],
    maxResponseBytes: 2 * 1024 * 1024,
    timeoutMs: 30_000,
  },
  actions: [
    {
      id: "drive_search_files",
      label: "Search files",
      risk: "read",
      scopes: [DRIVE_READ_SCOPE],
      description: "Search accessible Drive files, optionally within one shared drive. A search filter does not grant or restrict permissions.",
      inputSchema: objectSchema({
        query: stringSchema("Drive files search expression"),
        driveId: stringSchema("Optional shared drive ID", 256),
        pageSize: pageSizeSchema(100),
        pageToken: stringSchema("Continuation token", 4096),
      }),
    },
    {
      id: "drive_read_file",
      label: "Read file",
      risk: "read",
      scopes: [DRIVE_READ_SCOPE],
      description: "Read a file up to 2 MiB. Export Google documents as text; CSV exports of spreadsheets contain the first sheet only.",
      inputSchema: objectSchema({
        fileId: stringSchema("Drive file ID", 256),
        mimeType: { type: "string", enum: ["text/plain", "text/csv", "text/html", "application/pdf"] },
        maxChars: maxCharsSchema,
      }, ["fileId"]),
    },
  ],
};

export const googleDriveContribution = defineConnectorContribution({
  definition: authoredGoogleDriveDefinition,
  async execute(actionId, input, context) {
    const action = authoredGoogleDriveDefinition.actions?.find((entry) => entry.id === actionId);
    if (!action) throw new ConnectError("invalid_request", "Unsupported Google Drive action");
    const args = actionArguments(action, input, "Google Drive");
    const request = actionRequest(action, context.request, "Google");
    if (actionId === "drive_search_files") {
      const query: Record<string, string> = {
        q: "trashed = false",
        pageSize: String(integer(args.pageSize, 20, 100)),
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: "user",
        fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,webViewLink,modifiedTime,size,driveId)",
      };
      optionalQuery(args, query, "query", "q");
      optionalQuery(args, query, "pageToken", "pageToken", 4096);
      if (args.driveId !== undefined) {
        query.driveId = resourceId(args.driveId);
        query.corpora = "drive";
      }
      const result = responseObject(await request({ method: "GET", path: "/drive/v3/files", query }));
      return {
        files: responseArray(result.files).map(fileMetadata),
        ...pagination(result),
        incompleteSearch: result.incompleteSearch === true,
      };
    }
    const id = resourceId(args.fileId);
    const limit = integer(args.maxChars, 20_000, 100_000);
    const requestedMime = args.mimeType === undefined ? undefined : argumentText(args.mimeType, 100);
    if (requestedMime && !["text/plain", "text/csv", "text/html", "application/pdf"].includes(requestedMime)) {
      throw new ConnectError("invalid_request", "Unsupported export MIME type");
    }
    const metadata = fileMetadata(await request({
      method: "GET",
      path: `/drive/v3/files/${id}`,
      query: { supportsAllDrives: "true", fields: "id,name,mimeType,webViewLink,size,driveId" },
    }));
    if (metadata.id !== id || typeof metadata.mimeType !== "string") throw invalidGoogleResponse();
    if (metadata.mimeType === "application/vnd.google-apps.folder"
      || metadata.mimeType === "application/vnd.google-apps.shortcut") {
      throw new ConnectError("invalid_request", "Choose a file rather than a folder or shortcut");
    }
    if (metadata.size !== undefined && Number(metadata.size) > 2 * 1024 * 1024) {
      throw new ConnectError("http_error", "File exceeds the Connector response limit", {
        details: { category: "response_too_large" },
      });
    }
    const workspaceFile = metadata.mimeType.startsWith("application/vnd.google-apps.");
    const exportMime = requestedMime
      ?? (metadata.mimeType === "application/vnd.google-apps.spreadsheet" ? "text/csv" : "text/plain");
    const content = await request({
      method: "GET",
      path: `/drive/v3/files/${id}${workspaceFile ? "/export" : ""}`,
      query: workspaceFile
        ? { mimeType: exportMime }
        : { alt: "media", supportsAllDrives: "true" },
    });
    return {
      ...metadata,
      content: typeof content === "string" ? content.slice(0, limit) : content,
      truncated: typeof content === "string" && content.length > limit,
      ...(workspaceFile ? { exportMimeType: exportMime } : {}),
      ...(metadata.mimeType === "application/vnd.google-apps.spreadsheet" && exportMime === "text/csv"
        ? { exportScope: "first_sheet" }
        : {}),
    };
  },
});

export const googleDriveDefinition = googleDriveContribution.definition;

function fileMetadata(value: unknown): Record<string, string> {
  const input = responseObject(value);
  const result: Record<string, string> = { id: responseText(input.id) };
  for (const key of ["name", "mimeType", "webViewLink", "modifiedTime", "size", "driveId"]) {
    if (input[key] !== undefined) result[key] = responseText(input[key]);
  }
  return result;
}
