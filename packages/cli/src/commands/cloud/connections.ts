import { Option, type Command } from "commander";
import { readFile } from "node:fs/promises";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { createApiClient, type ApiClient, type ApiResponse } from "./api.js";
import type { Credentials } from "./config.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { openBrowser } from "../../util/browser.js";
import { friendlyError } from "../../util/errors.js";
import { dashboardUrlFor } from "../../util/base-url.js";

type ApiEnvelope<T> = { code?: string; data?: T; error?: string; ok?: boolean };

class ConnectionCliApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "ConnectionCliApiError";
  }
}

export function projectConnectionsPath(projectId: string, ...segments: string[]): string {
  const suffix = segments.length
    ? `/${segments.map(encodeURIComponent).join("/")}`
    : "";
  return `/v1/projects/${encodeURIComponent(projectId)}/connect${suffix}`;
}

export function parseJsonObject(
  value: string | undefined,
  label: string,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function parseJsonArray(
  value: string | undefined,
  label: string,
): unknown[] | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed;
}

export function connectionDataFrom<T>(response: ApiResponse<ApiEnvelope<T>>): T {
  if (response.status < 200 || response.status >= 300) {
    throw new ConnectionCliApiError(
      response.data?.error ?? `Connections API returned HTTP ${response.status}`,
      response.data?.code ?? "CONNECTION_API_ERROR",
      response.status,
    );
  }
  return response.data?.data as T;
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  clack.log.info(JSON.stringify(value, null, 2));
}

async function withAuthenticatedConnection(
  operation: string,
  options: { json?: boolean },
  action: (credentials: Credentials) => Promise<void>,
): Promise<void> {
  try {
    const credentials = await requireAuth({
      context: `${operation} requires an authenticated session.`,
    });
    await action(credentials);
  } catch (error) {
    if (options.json) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error instanceof ConnectionCliApiError ? error.code : "CLI_ERROR",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ConnectionCliApiError ? { status: error.status } : {}),
      })}\n`);
      process.exitCode = 1;
      return;
    }
    clack.log.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
    process.exitCode = 1;
  }
}

function withConnectionClient(
  operation: string,
  options: { json?: boolean },
  action: (client: ApiClient, projectId: string, apiUrl: string) => Promise<void>,
): Promise<void> {
  return withAuthenticatedConnection(operation, options, async credentials => {
    const projectId = loadProjectId();
    if (!projectId) {
      throw new Error("No project linked. Run polpo create or polpo link first.");
    }
    await action(createApiClient(credentials, projectId), projectId, credentials.baseUrl);
  });
}

function withScopedConnectionClient(
  operation: string,
  options: { json?: boolean; organization?: string },
  action: (client: ApiClient, connectPath: string) => Promise<void>,
): Promise<void> {
  const organization = options.organization;
  if (organization !== undefined) {
    return withAuthenticatedConnection(operation, options, credentials => {
      if (!organization.trim()) throw new Error("--organization requires a non-empty organization ID.");
      return action(createApiClient(credentials), `/v1/orgs/${encodeURIComponent(organization)}/connect`);
    });
  }
  return withConnectionClient(operation, options, (client, projectId) => action(
    client, projectConnectionsPath(projectId),
  ));
}

export function registerConnectionsCommand(program: Command): void {
  const connections = program
    .command("connections")
    .description("Inspect Connections and manage trusted runtime bindings");

  const connectors = connections.command("connectors")
    .description("Manage custom API and MCP Connector definitions");
  connectors.command("register <file>")
    .description("Register an immutable Connector definition from JSON; credentials are configured separately")
    .option("--json", "Print JSON")
    .action((file: string, options: { json?: boolean }) => withConnectionClient("Registering a Connector", options, async (client, projectId) => {
      const definition = parseJsonObject(await readFile(file, "utf8"), "Connector file");
      if (!definition) throw new Error("Connector file must contain a JSON object.");
      printResult(connectionDataFrom(await client.post<ApiEnvelope<unknown>>(
        projectConnectionsPath(projectId, "connectors"), definition,
      )), Boolean(options.json));
    }));
  connectors.command("disable <connector-id>")
    .description("Disable this custom Connector identity")
    .option("--json", "Print JSON")
    .action((id: string, options: { json?: boolean }) => withConnectionClient("Disabling a Connector", options, async (client, projectId) => {
      printResult(connectionDataFrom(await client.post<ApiEnvelope<unknown>>(
        projectConnectionsPath(projectId, "connectors", id, "disable"),
      )), Boolean(options.json));
    }));

  connections.command("setup-readiness <provider-id>")
    .description("Check Connector/OAuth setup prerequisites; this does not test an authorized account")
    .option("--authentication <id>", "Select the Connector authentication method")
    .option("--oauth-client-mode <mode>", "Select managed or customer OAuth setup")
    .option("--json", "Print JSON")
    .action((providerId: string, options: { authentication?: string; oauthClientMode?: string; json?: boolean }) =>
      withConnectionClient("Checking Connector setup", options, async (client, projectId) => {
        if (options.oauthClientMode && !["managed", "customer"].includes(options.oauthClientMode)) {
          throw new Error("OAuth Client mode must be managed or customer.");
        }
        printResult(connectionDataFrom(await client.post<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "setup-readiness"), {
            providerId, authenticationId: options.authentication, oauthClientMode: options.oauthClientMode,
          },
        )), Boolean(options.json));
      }));

  connections.command("create <kind> <file>")
    .description("Create a public, api-key, or mcp Connection from a private JSON file")
    .option("--json", "Print the non-secret Connection result")
    .action((kind: string, file: string, options: { json?: boolean }) =>
      withConnectionClient("Creating a Connection", options, async (client, projectId) => {
        if (!["public", "api-key", "mcp"].includes(kind)) throw new Error("Connection kind must be public, api-key, or mcp.");
        const input = parseJsonObject(await readFile(file, "utf8"), "Connection file");
        if (!input) throw new Error("Connection file must contain a JSON object.");
        printResult(connectionDataFrom(await client.post<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "connections", kind), input,
        )), Boolean(options.json));
      }));

  const setupConfig = connections.command("setup-config")
    .description("Manage this project's approved application return origins for OAuth setup");
  setupConfig.command("show")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean }) => withConnectionClient("Reading setup configuration", options, async (client, projectId) => {
      printResult(connectionDataFrom(await client.get<ApiEnvelope<unknown>>(projectConnectionsPath(projectId, "setup-configuration"))), Boolean(options.json));
    }));
  setupConfig.command("set")
    .description("Replace approved HTTPS origins; use --clear to remove all project origins")
    .option("--origin <origin...>", "Exact HTTPS origins, without paths or wildcards")
    .option("--clear", "Remove all project-approved return origins")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean; origin?: string[]; clear?: boolean }) => {
      if ((!options.clear && !options.origin?.length) || (options.clear && options.origin?.length)) {
        throw new Error("Specify --origin or --clear");
      }
      return withConnectionClient("Updating setup configuration", options, async (client, projectId) => {
        printResult(connectionDataFrom(await client.put<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "setup-configuration"), { returnOrigins: options.clear ? [] : options.origin },
        )), Boolean(options.json));
      });
    });

  connections.command("catalog")
    .description("List available Connectors, setup modes, scopes, and health")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean }) =>
      withConnectionClient("Listing the Connector catalog", options, async (client, projectId) => {
        const response = await client.get<ApiEnvelope<unknown[]>>(
          projectConnectionsPath(projectId, "catalog"),
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("list")
    .description("List non-secret project Connections")
    .option("--provider <provider>", "Filter by provider")
    .option("--status <status>", "Filter by status")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean; provider?: string; status?: string }) =>
      withConnectionClient("Listing Connections", options, async (client, projectId) => {
        const query = new URLSearchParams();
        if (options.provider) query.set("providerId", options.provider);
        if (options.status) query.set("status", options.status);
        const suffix = query.size ? `?${query.toString()}` : "";
        const response = await client.get<ApiEnvelope<unknown[]>>(
          `${projectConnectionsPath(projectId, "connections")}${suffix}`,
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  const endUsers = connections.command("end-users")
    .description("Manage Connections owned by external application users");

  endUsers.command("list <user-id>")
    .description("List an external user's non-secret Connections in this project")
    .requiredOption("--namespace <namespace>", "Application namespace of the external user")
    .option("--json", "Print JSON")
    .action((userId: string, options: { json?: boolean; namespace: string }) =>
      withConnectionClient("Listing external-user Connections", options, async (client, projectId) => {
        const query = new URLSearchParams({ namespace: options.namespace });
        const response = await client.get<ApiEnvelope<unknown[]>>(
          `${projectConnectionsPath(projectId, "end-users", userId, "connections")}?${query}`,
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  endUsers.command("revoke <user-id> <connection-id>")
    .description("Revoke one exact Connection owned by an external application user")
    .requiredOption("--namespace <namespace>", "Application namespace of the external user")
    .option("--json", "Print JSON")
    .action((userId: string, connectionId: string, options: { json?: boolean; namespace: string }) =>
      withConnectionClient("Revoking an external-user Connection", options, async (client, projectId) => {
        const query = new URLSearchParams({ namespace: options.namespace });
        const response = await client.post<ApiEnvelope<unknown>>(
          `${projectConnectionsPath(projectId, "end-users", userId, "connections", connectionId, "revoke")}?${query}`,
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  const mcp = connections.command("mcp")
    .description("Inspect and authorize remote MCP servers");

  const mcpConfigurations = mcp.command("configurations")
    .description("Manage reusable MCP OAuth setup separately from user Connections");
  type McpConfigurationOptions = { organization?: string; json?: boolean; revision?: string };
  mcpConfigurations.command("list").option("--organization <id>", "Organization-owned configurations").option("--json", "Print JSON")
    .action((options: McpConfigurationOptions) => withScopedConnectionClient("Listing MCP OAuth configurations", options, async (client, connectPath) => {
      printResult(connectionDataFrom(await client.get<ApiEnvelope<unknown>>(`${connectPath}/mcp-oauth-configurations`)), Boolean(options.json));
    }));
  mcpConfigurations.command("create <file>").description("Create from a private JSON file; callback and owner are assigned by the host")
    .option("--organization <id>", "Organization-owned configuration").option("--json", "Print JSON")
    .action((file: string, options: McpConfigurationOptions) => withScopedConnectionClient("Creating an MCP OAuth configuration", options, async (client, connectPath) => {
      const input = parseJsonObject(await readFile(file, "utf8"), "Configuration file");
      printResult(connectionDataFrom(await client.post<ApiEnvelope<unknown>>(`${connectPath}/mcp-oauth-configurations`, input)), Boolean(options.json));
    }));
  mcpConfigurations.command("update <id> <file>").description("Update from a private JSON file using the last observed revision")
    .requiredOption("--revision <revision>", "Current configuration revision")
    .option("--organization <id>", "Organization-owned configuration").option("--json", "Print JSON")
    .action((id: string, file: string, options: McpConfigurationOptions) => withScopedConnectionClient("Updating an MCP OAuth configuration", options, async (client, connectPath) => {
      const input = parseJsonObject(await readFile(file, "utf8"), "Configuration file");
      printResult(connectionDataFrom(await client.put<ApiEnvelope<unknown>>(`${connectPath}/mcp-oauth-configurations/${encodeURIComponent(id)}`,
        { ...input, expectedRevision: options.revision })), Boolean(options.json));
    }));
  mcpConfigurations.command("revoke <id>").description("Disable this client configuration for new setup and credential delivery")
    .requiredOption("--revision <revision>", "Current configuration revision")
    .option("--organization <id>", "Organization-owned configuration").option("--json", "Print JSON")
    .action((id: string, options: McpConfigurationOptions) => withScopedConnectionClient("Revoking an MCP OAuth configuration", options, async (client, connectPath) => {
      const path = `${connectPath}/mcp-oauth-configurations/${encodeURIComponent(id)}?${new URLSearchParams({ expectedRevision: options.revision! })}`;
      printResult(connectionDataFrom(await client.delete<ApiEnvelope<unknown>>(path)), Boolean(options.json));
    }));

  connections.command("verify <connection-id>")
    .description("Run a configured non-destructive check and report its actual outcome")
    .option("--json", "Print JSON")
    .action((connectionId: string, options: { json?: boolean }) =>
      withConnectionClient("Verifying a Connection", options, async (client, projectId) => {
        const result = connectionDataFrom(await client.post<ApiEnvelope<{ outcome: string }>>(
          projectConnectionsPath(projectId, "connections", connectionId, "verify"),
        ));
        printResult(result, Boolean(options.json));
        if (result.outcome !== "passed") process.exitCode = 1;
      }));

  mcp.command("catalog")
    .description("List curated remote MCP servers and their setup modes")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean }) =>
      withConnectionClient("Listing the MCP catalog", options, async (client, projectId) => {
        const response = await client.get<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "mcp", "catalog"),
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  mcp.command("inspect <url>")
    .description("Inspect a custom MCP endpoint without sending credentials")
    .option("--transport <transport>", "http or sse", "http")
    .option("--json", "Print JSON")
    .action((url: string, options: { json?: boolean; transport: string }) =>
      withConnectionClient("Inspecting an MCP endpoint", options, async (client, projectId) => {
        if (options.transport !== "http" && options.transport !== "sse") {
          throw new Error("--transport must be http or sse.");
        }
        const response = await client.post<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "mcp", "inspect"),
          { url, transport: options.transport },
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  mcp.command("connect <server>")
    .description("Open MCP setup for review and confirmation in your authenticated dashboard")
    .option("--dashboard-url <url>", "Dashboard origin for a local or custom installation")
    .option("--name <name>", "Connection display name")
    .addOption(new Option("--provider <provider>", "Unsupported in browser setup").hideHelp())
    .addOption(new Option("--authentication <id>", "Unsupported in browser setup").hideHelp())
    .addOption(new Option("--audience <audience>", "Unsupported in browser setup").default("shared").hideHelp())
    .addOption(new Option("--subject <json>", "Unsupported in browser setup").hideHelp())
    .addOption(new Option("--binding <json>", "Unsupported in browser setup").hideHelp())
    .option("--transport <transport>", "http or sse", "http")
    .addOption(new Option("--scope <scope...>", "Unsupported in browser setup").default([]).hideHelp())
    .option("--no-open", "Print the setup URL without opening a browser")
    .option("--json", "Print JSON and do not open a browser")
    .action((server: string, options: {
      json?: boolean;
      name?: string;
      dashboardUrl?: string;
      provider?: string;
      authentication?: string;
      audience: string;
      subject?: string;
      binding?: string;
      open: boolean;
      scope: string[];
      transport: string;
    }) => withConnectionClient("Opening MCP setup", options, async (_client, projectId, apiUrl) => {
      if (options.provider || options.authentication || options.subject || options.binding || options.scope.length || options.audience !== "shared") {
        throw new Error("Browser MCP setup does not support custom authentication, owner, binding, scopes, or audience flags. Configure the account in the dashboard; no OAuth request was started.");
      }
      if (options.transport !== "http" && options.transport !== "sse") throw new Error("--transport must be http or sse.");
      const dashboard = new URL(options.dashboardUrl ?? dashboardUrlFor(apiUrl));
      const localHttp = dashboard.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(dashboard.hostname);
      if ((dashboard.protocol !== "https:" && !localHttp) || dashboard.username || dashboard.password || dashboard.search || dashboard.hash || dashboard.pathname !== "/") {
        throw new Error("Dashboard URL must be an HTTPS origin, or HTTP on localhost.");
      }
      const link = new URL(`/projects/${encodeURIComponent(projectId)}/connections/browse`, dashboard);
      link.searchParams.set("provider", "mcp_url");
      if (/^[a-z0-9][a-z0-9_-]{0,127}$/.test(server)) {
        if (options.transport !== "http") throw new Error("Catalog servers use their configured transport. Use --transport only with a custom endpoint.");
        link.searchParams.set("mcpPreset", server);
      } else {
        let endpoint: URL;
        try { endpoint = new URL(server); } catch { throw new Error("Use a catalog ID or a clean HTTPS MCP endpoint."); }
        if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || server.length > 2048) {
          throw new Error("Use a clean HTTPS MCP endpoint without credentials, query parameters, or fragments. Enter other endpoints directly in the dashboard.");
        }
        link.searchParams.set("mcpUrl", endpoint.href);
        link.searchParams.set("mcpTransport", options.transport);
      }
      if (options.name !== undefined) {
        if (!options.name.trim() || options.name.length > 120) throw new Error("Connection name must contain 1–120 characters.");
        link.searchParams.set("mcpName", options.name.trim());
      }
      const setupUrl = link.href;
      printResult({ setupUrl, requiresBrowserSession: true }, Boolean(options.json));
      if (options.open && !options.json) await openBrowser(setupUrl);
    }));

  mcp.command("reconnect <connection-id>", { hidden: true })
    .description("Unsupported: create and explicitly assign a new MCP Connection instead")
    .option("--no-open", "Do not open the authorization URL in a browser")
    .option("--json", "Print JSON and do not open a browser")
    .action((connectionId: string, options: { json?: boolean; open: boolean }) =>
      withConnectionClient("Reconnecting an MCP server", options, async (client, projectId) => {
        const response = await client.post<ApiEnvelope<{ authorizationUrl: string }>>(
          projectConnectionsPath(projectId, "connections", connectionId, "reconnect"),
        );
        const result = connectionDataFrom(response);
        printResult(result, Boolean(options.json));
        if (options.open && !options.json) await openBrowser(result.authorizationUrl);
      }));

  connections.command("grants")
    .description("List Connection grants")
    .option("--agent <name>", "Filter by agent")
    .option("--connection <id>", "Filter by Connection")
    .option("--status <status>", "Filter by active or revoked status")
    .option("--json", "Print JSON")
    .action((options: { agent?: string; connection?: string; json?: boolean; status?: string }) =>
      withConnectionClient("Listing Connection grants", options, async (client, projectId) => {
        const query = new URLSearchParams();
        if (options.agent) query.set("agentName", options.agent);
        if (options.connection) query.set("connectionId", options.connection);
        if (options.status) query.set("status", options.status);
        const suffix = query.size ? `?${query.toString()}` : "";
        const response = await client.get<ApiEnvelope<unknown[]>>(
          `${projectConnectionsPath(projectId, "grants")}${suffix}`,
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("links")
    .description("List active and revoked project Connection links")
    .option("--status <status>", "Filter by active or revoked status")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean; status?: string }) =>
      withConnectionClient("Listing Connection links", options, async (client, projectId) => {
        const query = new URLSearchParams();
        if (options.status) query.set("status", options.status);
        const response = await client.get<ApiEnvelope<unknown[]>>(
          `${projectConnectionsPath(projectId, "links")}${query.size ? `?${query}` : ""}`,
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("link <connection-id>")
    .description("Link an authorized Connection to the current project")
    .option("--json", "Print JSON")
    .action((connectionId: string, options: { json?: boolean }) =>
      withConnectionClient("Linking a Connection", options, async (client, projectId) => {
        const response = await client.post<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "connections", connectionId, "link"),
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("unlink <connection-id>")
    .description("Revoke the current project's link without deleting a shared Connection")
    .option("--json", "Print JSON")
    .action((connectionId: string, options: { json?: boolean }) =>
      withConnectionClient("Unlinking a Connection", options, async (client, projectId) => {
        const response = await client.delete<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "connections", connectionId, "link"),
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("setup-session <provider>")
    .description("Create a short-lived end-user Connection setup session")
    .requiredOption("--audience <audience>", "personal, shared, or end_user")
    .requiredOption("--subject <json>", "Trusted Connection owner JSON")
    .requiredOption("--return-url <url>", "Approved application return URL")
    .option("--binding <json>", "Trusted principal/tenant/resource binding JSON")
    .option("--authentication <id>", "Connector authentication method ID")
    .option("--configuration <id>", "Reusable MCP OAuth client configuration ID")
    .option("--scope <scope...>", "Requested Connector scopes", [])
    .option("--oauth-client-mode <mode>", "managed, customer, or instance", "managed")
    .option("--json", "Print JSON")
    .action((providerId: string, options: {
      audience: string;
      authentication?: string;
      configuration?: string;
      binding?: string;
      json?: boolean;
      oauthClientMode: string;
      returnUrl: string;
      scope: string[];
      subject: string;
    }) => withConnectionClient("Creating a Connection setup session", options, async (client, projectId) => {
      const response = await client.post<ApiEnvelope<unknown>>(
        projectConnectionsPath(projectId, "setup-sessions"),
        {
          providerId,
          authenticationId: options.authentication,
          configurationId: options.configuration,
          audience: options.audience,
          subject: parseJsonObject(options.subject, "--subject"),
          binding: parseJsonObject(options.binding, "--binding"),
          scopes: options.scope,
          returnUrl: options.returnUrl,
          oauthClientMode: options.oauthClientMode,
        },
      );
      printResult(connectionDataFrom(response), Boolean(options.json));
    }));

  connections.command("setup-status <token>")
    .description("Inspect a public embedded Connection setup session")
    .option("--json", "Print JSON")
    .action((token: string, options: { json?: boolean }) =>
      withConnectionClient("Inspecting a Connection setup session", options, async (client) => {
        const response = await client.get<ApiEnvelope<unknown>>(
          `/v1/connect/setup/${encodeURIComponent(token)}/status`,
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  const capabilities = connections.command("capabilities")
    .description("Manage logical application Connection capabilities");

  capabilities.command("list")
    .description("List application capabilities without exposing provider credentials")
    .option("--status <status>", "Filter by pending, active, or revoked", "active")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean; status: string }) =>
      withConnectionClient("Listing application capabilities", options, async (client, projectId) => {
        const query = new URLSearchParams({ status: options.status });
        const response = await client.get<ApiEnvelope<unknown[]>>(
          `${projectConnectionsPath(projectId, "application-capabilities")}?${query}`,
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  capabilities.command("set <capability-id>")
    .description("Bind a logical application capability to a trusted Connection")
    .requiredOption("--connection <id>", "Physical Connection selected only in the trusted control plane")
    .option("--scope <scope...>", "Scopes the application capability may request", [])
    .requiredOption("--operations <json>", "Allowed operation policies as a JSON array")
    .option("--binding <json>", "Optional trusted principal/tenant/resource binding JSON")
    .option("--json", "Print JSON")
    .action((capabilityId: string, options: {
      binding?: string;
      connection: string;
      json?: boolean;
      operations: string;
      scope: string[];
    }) => withConnectionClient("Configuring an application capability", options, async (client, projectId) => {
      const response = await client.put<ApiEnvelope<unknown>>(
        projectConnectionsPath(projectId, "application-capabilities", capabilityId),
        {
          connectionId: options.connection,
          scopes: options.scope,
          allowedOperations: parseJsonArray(options.operations, "--operations"),
          binding: parseJsonObject(options.binding, "--binding"),
        },
      );
      printResult(connectionDataFrom(response), Boolean(options.json));
    }));

  connections.command("setup-start <token>")
    .description("Start a bound OAuth setup directly, without opening the hosted Polpo page")
    .option("--no-open", "Do not open the provider authorization URL")
    .option("--json", "Print JSON without opening a browser")
    .action((token: string, options: { json?: boolean; open: boolean }) =>
      withConnectionClient("Starting a Connection setup", options, async (client) => {
        const result = connectionDataFrom(await client.post<ApiEnvelope<{ authorizationUrl: string }>>(
          `/v1/connect/setup/${encodeURIComponent(token)}/oauth/start`,
        ));
        printResult(result, Boolean(options.json));
        if (options.open && !options.json) await openBrowser(result.authorizationUrl);
      }));

  capabilities.command("revoke <capability-id>")
    .description("Revoke a logical application capability")
    .option("--json", "Print JSON")
    .action((capabilityId: string, options: { json?: boolean }) =>
      withConnectionClient("Revoking an application capability", options, async (client, projectId) => {
        const response = await client.delete<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "application-capabilities", capabilityId),
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  const oauthClients = connections.command("oauth-clients")
    .description("Manage customer-owned OAuth applications separately from Connections");

  oauthClients.command("list")
    .description("List non-secret OAuth Client registrations")
    .option("--organization <id>", "List organization-owned clients instead of project-owned clients")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean; organization?: string }) =>
      withScopedConnectionClient("Listing OAuth Clients", options, async (client, connectPath) => {
        const path = `${connectPath}/oauth-clients`;
        const response = await client.get<ApiEnvelope<unknown[]>>(path);
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  oauthClients.command("set <provider>")
    .description("Create or update a customer OAuth Client; the secret is read from an environment variable")
    .requiredOption("--client-id <id>", "Provider OAuth client ID")
    .option("--authentication <id>", "Connector authentication method; omit for the default")
    .option("--client-secret-env <name>", "Environment variable containing the write-only client secret")
    .option("--name <name>", "Display name")
    .option("--origin <origin...>", "Approved application return origins", [])
    .option("--organization <id>", "Configure an organization-owned client instead of a project-owned client")
    .option("--json", "Print JSON")
    .action((provider: string, options: {
      clientId: string;
      authentication?: string;
      clientSecretEnv?: string;
      json?: boolean;
      name?: string;
      origin: string[];
      organization?: string;
    }) => withScopedConnectionClient("Configuring an OAuth Client", options, async (client, connectPath) => {
      const secret = options.clientSecretEnv
        ? process.env[options.clientSecretEnv]
        : undefined;
      if (options.clientSecretEnv && !secret) {
        throw new Error(`Environment variable ${options.clientSecretEnv} is empty or unavailable.`);
      }
      const base = `${connectPath}/oauth-clients`;
      const response = await client.put<ApiEnvelope<unknown>>(
        `${base}/${encodeURIComponent(provider)}`,
        {
          clientId: options.clientId,
          ...(options.authentication ? { authenticationId: options.authentication } : {}),
          ...(secret ? { clientSecret: secret } : {}),
          ...(options.name ? { name: options.name } : {}),
          returnOrigins: options.origin,
        },
      );
      printResult(connectionDataFrom(response), Boolean(options.json));
    }));

  oauthClients.command("revoke <provider>")
    .description("Revoke a customer OAuth Client without revoking existing Connections")
    .option("--authentication <id>", "Connector authentication method; omit for the default")
    .option("--organization <id>", "Revoke an organization-owned client instead of a project-owned client")
    .option("--json", "Print JSON")
    .action((provider: string, options: { authentication?: string; json?: boolean; organization?: string }) =>
      withScopedConnectionClient("Revoking an OAuth Client", options, async (client, connectPath) => {
        const base = `${connectPath}/oauth-clients`;
        const query = options.authentication
          ? `?${new URLSearchParams({ authenticationId: options.authentication })}`
          : "";
        const response = await client.delete<ApiEnvelope<unknown>>(
          `${base}/${encodeURIComponent(provider)}${query}`,
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("events <connection-id>")
    .description("List sanitized Connection audit events")
    .option("--limit <count>", "Maximum events to return", "50")
    .option("--json", "Print JSON")
    .action((connectionId: string, options: { json?: boolean; limit: string }) =>
      withConnectionClient("Listing Connection events", options, async (client, projectId) => {
        const limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new Error("--limit must be an integer between 1 and 200.");
        }
        const response = await client.get<ApiEnvelope<unknown[]>>(
          `${projectConnectionsPath(projectId, "connections", connectionId, "events")}?limit=${limit}`,
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("health")
    .description("Check Connection links, grants, OAuth clients, and secret readiness")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean }) =>
      withConnectionClient("Checking Connection health", options, async (client, projectId) => {
        const response = await client.get<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "health"),
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("reconcile")
    .description("Audit Connection state and interrupted agent assignments or revocations")
    .option("--apply", "Apply repairs and resume assignment or revocation recovery (default is dry-run)")
    .option("--limit <count>", "Maximum records per resource type", "200")
    .option("--json", "Print JSON")
    .action((options: { apply?: boolean; json?: boolean; limit: string }) =>
      withConnectionClient("Reconciling Connections", options, async (client, projectId) => {
        const limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw new Error("--limit must be an integer between 1 and 500.");
        }
        const response = await client.post<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "reconcile"),
          { dryRun: !options.apply, limit },
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("bind <connection-id>")
    .description("Set or clear a non-secret trusted scope binding")
    .option("--binding <json>", "Canonical principal/tenant/resource binding JSON")
    .option("--clear", "Clear the existing binding")
    .option("--json", "Print JSON")
    .action((connectionId: string, options: { binding?: string; clear?: boolean; json?: boolean }) =>
      withConnectionClient("Binding a trusted Connection", options, async (client, projectId) => {
        if (options.clear === Boolean(options.binding)) {
          throw new Error("Provide exactly one of --binding or --clear.");
        }
        const binding = options.clear
          ? null
          : parseJsonObject(options.binding, "--binding");
        const response = await client.patch<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "connections", connectionId),
          { binding },
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("grant-slot <connection-id>")
    .description("Assign a trusted Connection and enable the agent's custom tool")
    .requiredOption("--agent <name>", "Exact agent name")
    .requiredOption("--tool <name>", "Exact custom tool name")
    .option("--scope <scope...>", "Scopes the tool may request", [])
    .option("--json", "Print JSON")
    .action((connectionId: string, options: {
      agent: string;
      json?: boolean;
      scope: string[];
      tool: string;
    }) => withConnectionClient("Granting a trusted Connection slot", options, async (client, projectId) => {
      const response = await client.post<ApiEnvelope<unknown>>(
        projectConnectionsPath(projectId, "grants"),
        {
          connectionId,
          agentName: options.agent,
          grantType: "connection_slot",
          toolName: options.tool,
          scopes: options.scope,
          metadata: { source: "cli" },
        },
      );
      printResult(connectionDataFrom(response), Boolean(options.json));
    }));

  connections.command("revoke-slot <grant-id>")
    .description("Revoke a trusted Connection slot grant")
    .option("--json", "Print JSON")
    .action((grantId: string, options: { json?: boolean }) =>
      withConnectionClient("Revoking a trusted Connection slot", options, async (client, projectId) => {
        const response = await client.post<ApiEnvelope<unknown>>(
          projectConnectionsPath(projectId, "grants", grantId, "revoke"),
        );
        printResult(connectionDataFrom(response), Boolean(options.json));
      }));

  connections.command("readiness")
    .description("Verify one trusted Connection slot against test invocation scope")
    .requiredOption("--agent <name>", "Exact agent name")
    .requiredOption("--tool <name>", "Exact custom tool name")
    .requiredOption("--slot <name>", "Logical Connection slot name")
    .option("--provider <provider>", "Required provider")
    .option("--scope <scope...>", "Required scopes", [])
    .option("--user <id>", "Trusted external user ID")
    .option("--metadata <json>", "Trusted invocation metadata JSON")
    .option("--scope-key <key>", "Trusted partition key")
    .option("--scope-version <version>", "Trusted partition epoch")
    .option("--json", "Print JSON")
    .action((options: {
      agent: string;
      json?: boolean;
      metadata?: string;
      provider?: string;
      scope: string[];
      scopeKey?: string;
      scopeVersion?: string;
      slot: string;
      tool: string;
      user?: string;
    }) => withConnectionClient("Checking trusted Connection readiness", options, async (client, projectId) => {
      if (options.scopeVersion && !options.scopeKey) {
        throw new Error("--scope-version requires --scope-key.");
      }
      const response = await client.post<ApiEnvelope<unknown>>(
        projectConnectionsPath(projectId, "readiness"),
        {
          agentName: options.agent,
          toolName: options.tool,
          slot: options.slot,
          provider: options.provider,
          scopes: options.scope,
          user: options.user,
          metadata: parseJsonObject(options.metadata, "--metadata"),
          ...(options.scopeKey
            ? { scope: { key: options.scopeKey, version: options.scopeVersion } }
            : {}),
        },
      );
      printResult(connectionDataFrom(response), Boolean(options.json));
    }));
}
