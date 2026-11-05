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

export const githubDefinition: ConnectorDefinition = {
  version: 2,
  id: "github",
  name: "GitHub",
  source: "catalog",
  protocol: "http_api",
  description: "Read repositories, inspect issues and pull requests, and create issues through scoped GitHub OAuth.",
  defaultAuthenticationId: "oauth",
  authentication: [{
    id: "oauth",
    type: "oauth2",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScopes: ["read:user", "repo"],
  }],
  scopes: [
    { id: "read:user", label: "Read user profile" },
    { id: "repo", label: "Repository read/write", dangerous: true },
  ],
  http: {
    origins: ["https://api.github.com"],
    allowedMethods: ["GET", "POST"],
    allowedPathPatterns: ["/user/repos", "/repos/*"],
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    timeoutMs: 30_000,
  },
  actions: [
    {
      id: "github_list_repos",
      label: "List GitHub repositories",
      description: "List repositories visible to the connected GitHub account.",
      scopes: ["repo"],
      risk: "read",
      inputSchema: objectSchema({
        perPage: optional({ type: "number", description: "Repositories per page. Default 30, max 100." }),
        page: optional({ type: "number", description: "Page number. Default 1." }),
      }),
    },
    {
      id: "github_create_issue",
      label: "Create GitHub issue",
      description: "Create an issue in a repository authorized by the connected GitHub account.",
      scopes: ["repo"],
      risk: "write",
      inputSchema: objectSchema({
        owner: { type: "string", description: "Repository owner or organization." },
        repo: { type: "string", description: "Repository name." },
        title: { type: "string", description: "Issue title." },
        body: optional({ type: "string", description: "Issue body." }),
        labels: optional({ type: "array", items: { type: "string" }, description: "Optional issue labels." }),
      }, ["owner", "repo", "title"]),
    },
    {
      id: "github_read_file",
      label: "Read GitHub file",
      description: "Read a file from a repository authorized by the connected GitHub account.",
      scopes: ["repo"],
      risk: "read",
      inputSchema: objectSchema({
        owner: { type: "string", description: "Repository owner or organization." },
        repo: { type: "string", description: "Repository name." },
        path: { type: "string", description: "File path inside the repository." },
        ref: optional({ type: "string", description: "Branch, tag, or commit SHA." }),
      }, ["owner", "repo", "path"]),
    },
  ],
  triggers: [
    { id: "github_issue_opened", label: "Issue opened", scopes: ["repo"] },
    { id: "github_pr_opened", label: "Pull request opened", scopes: ["repo"] },
  ],
};

export const githubContribution = defineConnectorContribution({
  definition: githubDefinition,
  async execute(actionId, input, context) {
    const args = inputRecord(input);
    const request = (operation: ConnectorActionRequest["request"]) => providerRequest(operation, context.request);
    if (actionId === "github_list_repos") {
      return request({
        method: "GET",
        path: "/user/repos",
        query: {
          per_page: String(clampNumber(args.perPage, 30, 1, 100)),
          page: String(clampNumber(args.page, 1, 1, 1000)),
          affiliation: "owner,collaborator,organization_member",
        },
        headers: githubHeaders,
      });
    }
    if (actionId === "github_create_issue") {
      const labels = Array.isArray(args.labels)
        ? args.labels.filter((value): value is string => typeof value === "string")
        : undefined;
      return request({
        method: "POST",
        path: `/repos/${encodeURIComponent(requiredString(args, "owner"))}/${encodeURIComponent(requiredString(args, "repo"))}/issues`,
        headers: githubHeaders,
        body: {
          title: requiredString(args, "title"),
          body: optionalString(args, "body"),
          labels,
        },
      });
    }
    if (actionId === "github_read_file") {
      const path = requiredString(args, "path").split("/").map(encodeURIComponent).join("/");
      const ref = optionalString(args, "ref");
      const payload = await request({
        method: "GET",
        path: `/repos/${encodeURIComponent(requiredString(args, "owner"))}/${encodeURIComponent(requiredString(args, "repo"))}/contents/${path}`,
        ...(ref ? { query: { ref } } : {}),
        headers: githubHeaders,
      });
      const result = responseRecord(payload);
      if (typeof result.content === "string" && result.encoding === "base64") {
        try {
          const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, "")), (char) => char.charCodeAt(0));
          return { ...result, contentText: new TextDecoder().decode(bytes) };
        } catch {
          throw invalidProviderResponse();
        }
      }
      return payload;
    }
    throw new ConnectError("invalid_request", `Unsupported GitHub action "${actionId}"`, { status: 404 });
  },
});

const githubHeaders = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

async function providerRequest(
  request: ConnectorActionRequest["request"],
  gateway: import("../../contribution.js").ConnectorContributionRequestGateway,
): Promise<unknown> {
  const response = await gateway(request);
  if (response.status < 200 || response.status >= 300) {
    throw new ConnectError("http_error", `GitHub API returned ${response.status}`, {
      status: response.status >= 400 && response.status < 500 ? 400 : 502,
      details: response.body,
    });
  }
  return response.body;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectError("invalid_request", "GitHub action input must be an object", { status: 400 });
  }
  return input as Record<string, unknown>;
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

function responseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidProviderResponse();
  return value as Record<string, unknown>;
}

function invalidProviderResponse(): ConnectError {
  return new ConnectError("http_error", "GitHub returned an invalid response", {
    status: 502,
    details: { category: "invalid_response" },
  });
}
