import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { createApiClient, type ApiClient, type ApiResponse } from "./api.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";

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

async function withConnectionClient(
  operation: string,
  options: { json?: boolean },
  action: (client: ApiClient, projectId: string) => Promise<void>,
): Promise<void> {
  try {
    const credentials = await requireAuth({
      context: `${operation} requires an authenticated session.`,
    });
    const projectId = loadProjectId();
    if (!projectId) {
      throw new Error("No project linked. Run polpo create or polpo link first.");
    }
    await action(createApiClient(credentials, projectId), projectId);
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

export function registerConnectionsCommand(program: Command): void {
  const connections = program
    .command("connections")
    .description("Inspect Connections and manage trusted runtime bindings");

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
    .description("Grant a custom tool access to one trusted Connection")
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
