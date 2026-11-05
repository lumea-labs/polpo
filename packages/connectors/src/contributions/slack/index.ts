import {
  ConnectError,
  type ConnectorActionRequest,
  type ConnectorDefinition,
} from "@polpo-ai/connect";
import { defineConnectorContribution } from "../../contribution.js";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const optional = (schema: Record<string, unknown>) => ({ ...schema, optional: true });

export const slackDefinition: ConnectorDefinition = {
  version: 2,
  id: "slack",
  name: "Slack",
  source: "catalog",
  protocol: "http_api",
  description: "Read channels and send messages through scoped Slack OAuth.",
  defaultAuthenticationId: "oauth",
  authentication: [{
    id: "oauth",
    type: "oauth2",
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    defaultScopes: ["channels:read", "chat:write"],
  }],
  scopes: [
    { id: "channels:read", label: "Read channels" },
    { id: "chat:write", label: "Send messages", dangerous: true },
    { id: "users:read", label: "Read users" },
  ],
  http: {
    origins: ["https://slack.com"],
    allowedMethods: ["GET", "POST"],
    allowedPathPatterns: ["/api/*"],
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    timeoutMs: 30_000,
  },
  actions: [
    {
      id: "slack_list_channels",
      label: "List Slack channels",
      description: "List channels visible to the connected Slack workspace.",
      scopes: ["channels:read"],
      risk: "read",
      inputSchema: objectSchema({
        limit: optional({ type: "number", description: "Number of channels. Default 100, max 200." }),
        cursor: optional({ type: "string", description: "Slack pagination cursor." }),
        types: optional({ type: "string", description: "Conversation types. Default public_channel,private_channel." }),
      }),
    },
    {
      id: "slack_send_message",
      label: "Send Slack message",
      description: "Send a message to a Slack channel through the connected workspace.",
      scopes: ["chat:write"],
      risk: "write",
      inputSchema: objectSchema({
        channel: { type: "string", description: "Channel id or name." },
        text: { type: "string", description: "Message text." },
        threadTs: optional({ type: "string", description: "Optional Slack thread timestamp to reply in-thread." }),
      }, ["channel", "text"]),
    },
  ],
  triggers: [{ id: "slack_message_posted", label: "Message posted", scopes: ["channels:read"] }],
};

export const slackContribution = defineConnectorContribution({
  definition: slackDefinition,
  async execute(actionId, input, context) {
    const args = inputRecord(input);
    let operation: ConnectorActionRequest["request"];
    if (actionId === "slack_list_channels") {
      const cursor = optionalString(args, "cursor");
      operation = {
        method: "GET",
        path: "/api/conversations.list",
        query: {
          limit: String(clampNumber(args.limit, 100, 1, 200)),
          types: optionalString(args, "types") ?? "public_channel,private_channel",
          ...(cursor ? { cursor } : {}),
        },
      };
    } else if (actionId === "slack_send_message") {
      const threadTs = optionalString(args, "threadTs");
      operation = {
        method: "POST",
        path: "/api/chat.postMessage",
        body: {
          channel: requiredString(args, "channel"),
          text: requiredString(args, "text"),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        },
      };
    } else {
      throw new ConnectError("invalid_request", `Unsupported Slack action "${actionId}"`, { status: 404 });
    }
    const response = await context.request(operation);
    if (response.status < 200 || response.status >= 300) {
      throw new ConnectError("http_error", `Slack API returned ${response.status}`, {
        status: response.status >= 400 && response.status < 500 ? 400 : 502,
        details: response.body,
      });
    }
    const result = responseRecord(response.body);
    if (result.ok === false) {
      throw new ConnectError("http_error", `Slack API error: ${String(result.error ?? "unknown_error")}`, {
        status: 502,
        details: result,
      });
    }
    return result;
  },
});

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectError("invalid_request", "Slack action input must be an object", { status: 400 });
  }
  return input as Record<string, unknown>;
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectError("http_error", "Slack returned an invalid response", {
      status: 502,
      details: { category: "invalid_response" },
    });
  }
  return value as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectError("invalid_request", `${key} is required`, { status: 400 });
  }
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(minimum, Math.min(maximum, number));
}
