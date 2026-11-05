import {
  ConnectError,
  type ConnectorActionDefinition,
  type ConnectorActionRequest,
} from "@polpo-ai/connect";
import type { ConnectorContributionRequestGateway } from "../contribution.js";

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"];

export const stringSchema = (description: string, maxLength = 2048) => ({
  type: "string", minLength: 1, maxLength, description,
});
export const pageSizeSchema = (maximum: number) => ({
  type: "integer", minimum: 1, maximum, default: 20,
});
export const maxCharsSchema = {
  type: "integer", minimum: 1, maximum: 100_000, default: 20_000,
};

export const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => [
    name,
    required.includes(name)
      ? property
      : { anyOf: [property, { type: "null" }], description: "Omit or pass null when unused." },
  ])),
});

export const googleOAuth = (scope: string) => [{
  id: "oauth",
  type: "oauth2" as const,
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  supportsPkce: true,
  defaultScopes: [scope],
  identity: {
    method: "userinfo" as const,
    issuer: "https://accounts.google.com",
    url: "https://openidconnect.googleapis.com/v1/userinfo",
    requiredScopes: GOOGLE_IDENTITY_SCOPES,
    scopeAliases: { "https://www.googleapis.com/auth/userinfo.email": "email" },
  },
  extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
}];

export function actionArguments(
  action: ConnectorActionDefinition,
  input: unknown,
  provider: string,
): Record<string, unknown> {
  const properties = (action.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !(key in properties))) {
    throw new ConnectError("invalid_request", `Invalid ${provider} action arguments`);
  }
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}

export function actionRequest(
  _action: ConnectorActionDefinition,
  gateway: ConnectorContributionRequestGateway,
  provider: string,
) {
  return async (request: ConnectorActionRequest["request"]): Promise<unknown> => {
    const response = await gateway(request);
    if (response.status < 200 || response.status >= 300) {
      throw new ConnectError("http_error", `${provider} rejected the operation`, {
        details: { providerStatus: response.status },
      });
    }
    return response.body;
  };
}

export function argumentText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new ConnectError("invalid_request", "Invalid Google action argument");
  }
  return value;
}

export function resourceId(value: unknown): string {
  const id = argumentText(value, 256);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new ConnectError("invalid_request", "Invalid Google resource ID");
  }
  return id;
}

export function integer(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ConnectError("invalid_request", "Argument is outside its supported range");
  }
  return value;
}

export function optionalQuery(
  args: Record<string, unknown>,
  query: Record<string, string>,
  input: string,
  output: string,
  maximum = 2048,
): void {
  if (args[input] !== undefined) query[output] = argumentText(args[input], maximum);
}

export function invalidGoogleResponse(): ConnectError {
  return new ConnectError("http_error", "Google returned an invalid response", {
    details: { category: "invalid_response" },
  });
}

export function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidGoogleResponse();
  return value as Record<string, unknown>;
}

export function responseText(value: unknown): string {
  if (typeof value !== "string" || !value) throw invalidGoogleResponse();
  return value;
}

export function responseArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw invalidGoogleResponse();
  return value;
}

export function pagination(value: Record<string, unknown>): { nextPageToken?: string } {
  return value.nextPageToken === undefined ? {} : { nextPageToken: responseText(value.nextPageToken) };
}
