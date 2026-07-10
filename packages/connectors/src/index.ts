import type { ConnectorProviderDefinition } from "@polpo-ai/connect";

export const apiKeyConnector: ConnectorProviderDefinition = {
  id: "api_key",
  name: "API Key",
  description: "Store a project or user API key and expose it to approved connector tools without showing it to the model.",
  auth: {
    type: "api_key",
    defaultScopes: ["use"],
  },
  scopes: [{ id: "use", label: "Use API key" }],
  actions: [
    {
      id: "api_key_get_token",
      label: "Get runtime token",
      description: "Resolve the stored API key for server-side tool execution.",
      scopes: ["use"],
      risk: "read",
    },
  ],
};

export const githubConnector: ConnectorProviderDefinition = {
  id: "github",
  name: "GitHub",
  description: "Read repositories, inspect issues and pull requests, and create issues through scoped GitHub OAuth.",
  auth: {
    type: "oauth2",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScopes: ["read:user", "repo"],
  },
  scopes: [
    { id: "read:user", label: "Read user profile" },
    { id: "repo", label: "Repository read/write", dangerous: true },
  ],
  actions: [
    {
      id: "github_list_repos",
      label: "List repositories",
      description: "List repositories visible to the connected account.",
      scopes: ["repo"],
      risk: "read",
    },
    {
      id: "github_create_issue",
      label: "Create issue",
      description: "Create an issue in an authorized repository.",
      scopes: ["repo"],
      risk: "write",
    },
    {
      id: "github_read_file",
      label: "Read file",
      description: "Read a file from an authorized repository.",
      scopes: ["repo"],
      risk: "read",
    },
  ],
  triggers: [
    { id: "github_issue_opened", label: "Issue opened", scopes: ["repo"] },
    { id: "github_pr_opened", label: "Pull request opened", scopes: ["repo"] },
  ],
};

export const slackConnector: ConnectorProviderDefinition = {
  id: "slack",
  name: "Slack",
  description: "Read channels and send messages through scoped Slack OAuth.",
  auth: {
    type: "oauth2",
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    defaultScopes: ["channels:read", "chat:write"],
  },
  scopes: [
    { id: "channels:read", label: "Read channels" },
    { id: "chat:write", label: "Send messages", dangerous: true },
    { id: "users:read", label: "Read users" },
  ],
  actions: [
    {
      id: "slack_list_channels",
      label: "List channels",
      description: "List channels available to the connected Slack installation.",
      scopes: ["channels:read"],
      risk: "read",
    },
    {
      id: "slack_send_message",
      label: "Send message",
      description: "Send a message to an authorized Slack channel.",
      scopes: ["chat:write"],
      risk: "write",
    },
  ],
  triggers: [
    { id: "slack_message_posted", label: "Message posted", scopes: ["channels:read"] },
  ],
};

export const googleDriveConnector: ConnectorProviderDefinition = {
  id: "google_drive",
  name: "Google Drive",
  description: "Search and read Drive files through scoped Google OAuth.",
  auth: {
    type: "oauth2",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
  },
  scopes: [
    { id: "https://www.googleapis.com/auth/drive.readonly", label: "Read Drive files" },
    { id: "https://www.googleapis.com/auth/drive.file", label: "Create and edit selected Drive files", dangerous: true },
  ],
  actions: [
    {
      id: "drive_search_files",
      label: "Search files",
      description: "Search files in the connected Google Drive.",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      risk: "read",
    },
    {
      id: "drive_read_file",
      label: "Read file",
      description: "Read an authorized file from Google Drive.",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      risk: "read",
    },
  ],
};

export const mcpUrlConnector: ConnectorProviderDefinition = {
  id: "mcp_url",
  name: "MCP Server URL",
  description: "Connect a remote MCP server and expose discovered tools through Polpo permissions and traces.",
  auth: {
    type: "mcp",
    auth: "bearer",
    defaultScopes: ["tools:read", "tools:call"],
  },
  scopes: [
    { id: "tools:read", label: "Discover tools" },
    { id: "tools:call", label: "Call tools", dangerous: true },
  ],
  actions: [
    {
      id: "mcp_discover_tools",
      label: "Discover MCP tools",
      description: "List tools exposed by the connected MCP server.",
      scopes: ["tools:read"],
      risk: "read",
    },
    {
      id: "mcp_call_tool",
      label: "Call MCP tool",
      description: "Call an allowlisted tool on the connected MCP server.",
      scopes: ["tools:call"],
      risk: "write",
    },
  ],
};

export function createGenericOAuthConnector(input: {
  id: string;
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  defaultScopes?: string[];
  description?: string;
}): ConnectorProviderDefinition {
  return {
    id: input.id,
    name: input.name,
    description: input.description ?? "Custom OAuth2 connector.",
    allowCustomScopes: true,
    auth: {
      type: "oauth2",
      authorizationUrl: input.authorizationUrl,
      tokenUrl: input.tokenUrl,
      revokeUrl: input.revokeUrl,
      defaultScopes: input.defaultScopes,
    },
  };
}

export const defaultConnectors: ConnectorProviderDefinition[] = [
  apiKeyConnector,
  githubConnector,
  slackConnector,
  googleDriveConnector,
  mcpUrlConnector,
];
