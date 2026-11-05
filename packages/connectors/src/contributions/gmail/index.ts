import { ConnectError, type ConnectorDefinition } from "@polpo-ai/connect";
import { defineConnectorContribution } from "../../contribution.js";
import {
  GMAIL_READ_SCOPE,
  GOOGLE_IDENTITY_SCOPES,
  actionArguments,
  actionRequest,
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

export { GMAIL_READ_SCOPE, GOOGLE_IDENTITY_SCOPES } from "../google-common.js";

const authoredGmailDefinition: ConnectorDefinition = {
  version: 2,
  id: "gmail",
  name: "Gmail",
  source: "catalog",
  protocol: "http_api",
  description: "Search and read messages in the connected Gmail account.",
  defaultAuthenticationId: "oauth",
  authentication: googleOAuth(GMAIL_READ_SCOPE),
  scopes: [
    { id: GMAIL_READ_SCOPE, label: "Read Gmail messages" },
    { id: "openid", label: "Identify your Google account", required: true },
    { id: "email", label: "Account email", required: true },
  ],
  verification: {
    kind: "http",
    path: "/gmail/v1/users/me/profile",
    scopes: [GMAIL_READ_SCOPE],
    account: { idPath: ["emailAddress"] },
  },
  http: {
    origins: ["https://gmail.googleapis.com"],
    allowedMethods: ["GET"],
    allowedPathPatterns: [
      "/gmail/v1/users/me/messages",
      "/gmail/v1/users/me/messages/*",
      "/gmail/v1/users/me/profile",
    ],
    maxResponseBytes: 2 * 1024 * 1024,
    timeoutMs: 30_000,
  },
  actions: [
    {
      id: "gmail_search_messages",
      label: "Search messages",
      risk: "read",
      scopes: [GMAIL_READ_SCOPE],
      description: "Search the connected mailbox. Returns message IDs for gmail_read_message and a continuation token.",
      inputSchema: objectSchema({
        query: stringSchema("Gmail search query"),
        pageSize: pageSizeSchema(100),
        pageToken: stringSchema("Continuation token", 4096),
      }),
    },
    {
      id: "gmail_read_message",
      label: "Read message",
      risk: "read",
      scopes: [GMAIL_READ_SCOPE],
      description: "Read one message with bounded text and attachment metadata. Does not download attachments or mark it as read.",
      inputSchema: objectSchema({
        messageId: stringSchema("Message ID", 256),
        maxChars: maxCharsSchema,
      }, ["messageId"]),
    },
  ],
};

export const gmailContribution = defineConnectorContribution({
  definition: authoredGmailDefinition,
  async execute(actionId, input, context) {
    const action = authoredGmailDefinition.actions?.find((entry) => entry.id === actionId);
    if (!action) throw new ConnectError("invalid_request", "Unsupported Gmail action");
    const args = actionArguments(action, input, "Gmail");
    const request = actionRequest(action, context.request, "Google");
    if (actionId === "gmail_search_messages") {
      const query: Record<string, string> = { maxResults: String(integer(args.pageSize, 20, 100)) };
      optionalQuery(args, query, "query", "q");
      optionalQuery(args, query, "pageToken", "pageToken", 4096);
      const result = responseObject(await request({ method: "GET", path: "/gmail/v1/users/me/messages", query }));
      const messages = responseArray(result.messages).map((message) => {
        const entry = responseObject(message);
        return { id: responseText(entry.id), threadId: responseText(entry.threadId) };
      });
      return {
        messages,
        ...pagination(result),
        ...(typeof result.resultSizeEstimate === "number" ? { resultSizeEstimate: result.resultSizeEstimate } : {}),
      };
    }
    const id = resourceId(args.messageId);
    const limit = integer(args.maxChars, 20_000, 100_000);
    const result = responseObject(await request({
      method: "GET",
      path: `/gmail/v1/users/me/messages/${id}`,
      query: { format: "full" },
    }));
    if (result.id !== id) throw invalidGoogleResponse();
    return readMessage(result, limit);
  },
});

export const gmailDefinition = gmailContribution.definition;

function readMessage(message: Record<string, unknown>, limit: number): Record<string, unknown> {
  const payload = responseObject(message.payload);
  const headers: Record<string, string> = {};
  for (const value of responseArray(payload.headers)) {
    const header = responseObject(value);
    if (typeof header.name === "string" && typeof header.value === "string") {
      headers[header.name.toLowerCase()] = header.value;
    }
  }
  const text: string[] = [];
  const html: string[] = [];
  const attachments: Record<string, unknown>[] = [];
  const pending = [{ value: payload, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { value, depth } = pending.shift()!;
    if (++count > 256 || depth > 20) throw invalidGoogleResponse();
    const body = value.body === undefined ? {} : responseObject(value.body);
    if (body.attachmentId !== undefined) {
      attachments.push({
        id: responseText(body.attachmentId),
        filename: value.filename ?? "",
        mimeType: value.mimeType,
        size: body.size,
      });
    } else if ((value.mimeType === "text/plain" || value.mimeType === "text/html") && body.data !== undefined) {
      if (typeof body.data !== "string" || !/^[A-Za-z0-9_=-]*$/.test(body.data)) throw invalidGoogleResponse();
      try {
        const decoded = new TextDecoder().decode(Uint8Array.from(
          atob(body.data.replace(/-/g, "+").replace(/_/g, "/")),
          (char) => char.charCodeAt(0),
        ));
        (value.mimeType === "text/plain" ? text : html).push(decoded);
      } catch {
        throw invalidGoogleResponse();
      }
    }
    for (const child of responseArray(value.parts)) {
      pending.push({ value: responseObject(child), depth: depth + 1 });
    }
  }
  const content = (text.length ? text : html).join("\n");
  return {
    id: responseText(message.id),
    threadId: responseText(message.threadId),
    subject: headers.subject ?? "",
    from: headers.from ?? "",
    to: headers.to ?? "",
    date: headers.date ?? "",
    snippet: typeof message.snippet === "string" ? message.snippet : "",
    text: content.slice(0, limit),
    contentType: text.length ? "text/plain" : "text/html",
    truncated: content.length > limit,
    attachments,
  };
}
