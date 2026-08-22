/**
 * Agent-native conversational Channel management.
 *
 * Credentials are intentionally absent from this command surface. Providers
 * that need authorization return an expiring secure setup URL.
 */
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { createApiClient, type ApiClient, type ApiResponse } from "./api.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";

type ApiEnvelope<T> = { code?: string; data?: T; error?: string; ok?: boolean };

class ChannelCliApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ChannelCliApiError";
  }
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function conversationChannelPath(...segments: string[]): string {
  const base = "/v1/channels/management";
  return `${base}${segments.length ? `/${segments.map(encodeURIComponent).join("/")}` : ""}`;
}

function parseJsonObject(value: string | undefined, label: string): Record<string, unknown> | undefined {
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

function parseJsonArray(value: string | undefined, label: string): unknown[] | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
  return parsed;
}

type IdentityResolverOptions = {
  disableIdentityResolver?: boolean;
  identityResolverConnection?: string;
  identityResolverEndpoint?: string;
  identityResolverTimeout?: string;
  settings?: string;
};

export function channelSettingsFromOptions(
  options: IdentityResolverOptions,
): Record<string, unknown> | undefined {
  const settings = parseJsonObject(options.settings, "--settings") ?? {};
  if (options.disableIdentityResolver) {
    if (options.identityResolverConnection || options.identityResolverEndpoint || options.identityResolverTimeout) {
      throw new Error("--disable-identity-resolver cannot be combined with identity resolver configuration options.");
    }
    return { ...settings, identityResolver: null };
  }
  const resolverValues = [
    options.identityResolverConnection,
    options.identityResolverEndpoint,
    options.identityResolverTimeout,
  ];
  if (resolverValues.every((value) => value === undefined)) {
    return Object.keys(settings).length > 0 ? settings : undefined;
  }
  if (!options.identityResolverConnection || !options.identityResolverEndpoint) {
    throw new Error(
      "--identity-resolver-endpoint and --identity-resolver-connection must be provided together.",
    );
  }
  const timeoutMs = options.identityResolverTimeout === undefined
    ? undefined
    : Number(options.identityResolverTimeout);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000)) {
    throw new Error("--identity-resolver-timeout must be an integer between 250 and 10000 milliseconds.");
  }
  return {
    ...settings,
    identityResolver: {
      connectionId: options.identityResolverConnection,
      endpoint: options.identityResolverEndpoint,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      type: "http",
      version: 1,
    },
  };
}

export function channelTestBody(to?: string): Record<string, string> | undefined {
  const recipient = to?.trim();
  return recipient ? { to: recipient } : undefined;
}

export function channelTemplateBody(input: {
  components?: string;
  idempotencyKey?: string;
  language: string;
  name: string;
  to: string;
}): Record<string, unknown> {
  const recipient = input.to.trim();
  const name = input.name.trim();
  const language = input.language.trim();
  if (!recipient) throw new Error("--to is required.");
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error("--name must use lowercase letters, numbers, and underscores.");
  }
  if (!/^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?$/.test(language)) {
    throw new Error("--language must be a valid WhatsApp language code.");
  }
  const components = parseJsonArray(input.components, "--components");
  return {
    idempotencyKey: input.idempotencyKey?.trim() || randomUUID(),
    to: recipient,
    template: {
      name,
      language,
      ...(components ? { components } : {}),
    },
  };
}

export function channelDataFrom<T>(response: ApiResponse<ApiEnvelope<T>>): T {
  if (response.status < 200 || response.status >= 300) {
    throw new ChannelCliApiError(
      response.data?.error ?? `Channel API returned HTTP ${response.status}`,
      response.data?.code ?? "CHANNEL_API_ERROR",
      response.status,
    );
  }
  const data = response.data?.data as T;
  if (
    data &&
    typeof data === "object" &&
    "status" in data &&
    (data as { status?: unknown }).status === "failed"
  ) {
    const failure = (data as {
      error?: { code?: unknown; message?: unknown };
    }).error;
    throw new ChannelCliApiError(
      typeof failure?.message === "string" ? failure.message : "Channel provisioning failed",
      typeof failure?.code === "string" ? failure.code : "CHANNEL_SETUP_FAILED",
      500,
    );
  }
  return data;
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      clack.log.info("No Channels found.");
      return;
    }
    clack.log.info(value.map((item: any) => {
      const detail = item.status ?? item.availability ?? item.agentName ?? "";
      return `  ${pc.bold(item.name ?? item.label ?? item.id)}${detail ? pc.dim(`  ${detail}`) : ""}`;
    }).join("\n"));
    return;
  }
  const result = value as any;
  if (result?.status === "setup_required" || result?.setup?.url) {
    clack.log.info(`${pc.bold("Secure setup required")}\n${result.setup.url}\n${pc.dim(`Expires ${result.setup.expiresAt}`)}`);
    return;
  }
  if (result?.status === "pending_external") {
    const requirements = Array.isArray(result.requirements) ? result.requirements : [];
    clack.log.info([
      pc.bold("Provider action required"),
      ...requirements.flatMap((requirement: any) => [
        requirement.label,
        ...(requirement.url ? [requirement.url] : []),
      ]),
    ].join("\n"));
    return;
  }
  clack.log.info(JSON.stringify(value, null, 2));
}

async function withChannelClient(
  operation: string,
  options: { json?: boolean },
  action: (client: ApiClient) => Promise<void>,
): Promise<void> {
  try {
    const creds = await requireAuth({ context: `${operation} requires an authenticated session.` });
    const projectId = loadProjectId();
    if (!projectId) throw new Error("No project linked. Run polpo create or polpo link first.");
    await action(createApiClient(creds, projectId));
  } catch (error) {
    if (options.json) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error instanceof ChannelCliApiError ? error.code : "CLI_ERROR",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ChannelCliApiError ? { status: error.status } : {}),
      })}\n`);
      process.exitCode = 1;
      return;
    }
    clack.log.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
    process.exitCode = 1;
  }
}

export function registerChannelsCommand(program: Command): void {
  const channels = program
    .command("channels")
    .description("Configure conversational Channels and agent Routes");

  channels.command("providers")
    .description("List supported Channel providers")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => withChannelClient("Listing Channel providers", opts, async (client) => {
      printResult(channelDataFrom(await client.get(conversationChannelPath("providers"))), Boolean(opts.json));
    }));

  channels.command("list")
    .description("List project Channels")
    .option("--provider <provider>", "Filter by provider")
    .option("--status <status>", "Filter by status")
    .option("--connection <id>", "Filter by Connection id")
    .option("--json", "Print JSON")
    .action((opts: { connection?: string; json?: boolean; provider?: string; status?: string }) =>
      withChannelClient("Listing Channels", opts, async (client) => {
        const query = new URLSearchParams();
        if (opts.provider) query.set("provider", opts.provider);
        if (opts.status) query.set("status", opts.status);
        if (opts.connection) query.set("connectionId", opts.connection);
        const suffix = query.size ? `?${query.toString()}` : "";
        printResult(channelDataFrom(await client.get(`${conversationChannelPath()}${suffix}`)), Boolean(opts.json));
      }));

  channels.command("get <channel-id>")
    .description("Inspect a Channel without exposing credentials")
    .option("--json", "Print JSON")
    .action((channelId: string, opts: { json?: boolean }) =>
      withChannelClient("Getting a Channel", opts, async (client) => {
        printResult(channelDataFrom(await client.get(conversationChannelPath(channelId))), Boolean(opts.json));
      }));

  channels.command("add <provider>")
    .description("Configure a Channel and grant it to an agent")
    .requiredOption("--agent <name>", "Agent receiving the Channel route")
    .option("--allowed-tool <pattern>", "Restrict tools for Channel turns (repeatable)", collectOption, [])
    .option("--connection <id>", "Existing project Connection id")
    .option("--destination <id>", "Provider destination id, when known")
    .option("--name <name>", "Channel display name")
    .option("--priority <number>", "Route priority", "100")
    .option("--settings <json>", "Channel settings as a JSON object")
    .option("--identity-resolver-endpoint <url>", "Trusted pre-run identity resolver HTTPS endpoint")
    .option("--identity-resolver-connection <id>", "Bearer Connection used by the identity resolver")
    .option("--identity-resolver-timeout <ms>", "Identity resolver timeout in milliseconds")
    .option("--idempotency-key <key>", "Stable retry key")
    .option("--json", "Print JSON")
    .action((provider: string, opts: {
      agent: string;
      allowedTool: string[];
      connection?: string;
      destination?: string;
      idempotencyKey?: string;
      identityResolverConnection?: string;
      identityResolverEndpoint?: string;
      identityResolverTimeout?: string;
      json?: boolean;
      name?: string;
      priority: string;
      settings?: string;
    }) => withChannelClient("Configuring a Channel", opts, async (client) => {
      const priority = Number(opts.priority);
      if (!Number.isSafeInteger(priority)) throw new Error("--priority must be an integer.");
      const body = {
        provider,
        agentName: opts.agent,
        ...(opts.allowedTool.length > 0 ? { allowedTools: opts.allowedTool } : {}),
        connectionId: opts.connection,
        externalChannelId: opts.destination,
        idempotencyKey: opts.idempotencyKey ?? randomUUID(),
        name: opts.name,
        priority,
        settings: channelSettingsFromOptions(opts),
      };
      printResult(channelDataFrom(await client.post(conversationChannelPath("configure"), body)), Boolean(opts.json));
    }));

  channels.command("update <channel-id>")
    .description("Update Channel name, settings, or status")
    .option("--name <name>", "Channel display name")
    .option("--status <status>", "active or disabled")
    .option("--settings <json>", "Channel settings as a JSON object")
    .option("--identity-resolver-endpoint <url>", "Trusted pre-run identity resolver HTTPS endpoint")
    .option("--identity-resolver-connection <id>", "Bearer Connection used by the identity resolver")
    .option("--identity-resolver-timeout <ms>", "Identity resolver timeout in milliseconds")
    .option("--disable-identity-resolver", "Remove the trusted pre-run identity resolver")
    .option("--json", "Print JSON")
    .action((channelId: string, opts: IdentityResolverOptions & { json?: boolean; name?: string; status?: string }) =>
      withChannelClient("Updating a Channel", opts, async (client) => {
        const settings = channelSettingsFromOptions(opts);
        const body = {
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.status ? { status: opts.status } : {}),
          ...(settings ? { settings } : {}),
        };
        if (Object.keys(body).length === 0) throw new Error("Provide --name, --status, or --settings.");
        printResult(channelDataFrom(await client.patch(conversationChannelPath(channelId), body)), Boolean(opts.json));
      }));

  channels.command("test <channel-id>")
    .description("Test an active Channel")
    .option("--to <recipient>", "Provider recipient for direct-message tests such as WhatsApp")
    .option("--json", "Print JSON")
    .action((channelId: string, opts: { json?: boolean; to?: string }) =>
      withChannelClient("Testing a Channel", opts, async (client) => {
        printResult(
          channelDataFrom(await client.post(
            conversationChannelPath(channelId, "test"),
            channelTestBody(opts.to),
          )),
          Boolean(opts.json),
        );
      }));

  channels.command("send-template <channel-id>")
    .description("Send an approved WhatsApp template")
    .requiredOption("--to <recipient>", "WhatsApp recipient phone number")
    .requiredOption("--name <name>", "Approved WhatsApp template name")
    .requiredOption("--language <code>", "WhatsApp template language code")
    .option("--components <json>", "Template component substitutions as a JSON array")
    .option("--idempotency-key <key>", "Stable key for retry-safe delivery")
    .option("--json", "Print JSON")
    .action((channelId: string, opts: {
      components?: string;
      idempotencyKey?: string;
      json?: boolean;
      language: string;
      name: string;
      to: string;
    }) => withChannelClient("Sending a WhatsApp template", opts, async (client) => {
      printResult(channelDataFrom(await client.post(
        conversationChannelPath(channelId, "templates"),
        channelTemplateBody(opts),
      )), Boolean(opts.json));
    }));

  channels.command("remove <channel-id>")
    .alias("rm")
    .description("Remove a Channel and its Routes, but keep its Connection")
    .option("--yes", "Skip confirmation")
    .option("--json", "Print JSON")
    .action((channelId: string, opts: { json?: boolean; yes?: boolean }) =>
      withChannelClient("Removing a Channel", opts, async (client) => {
        if (!opts.yes) {
          if (!process.stdin.isTTY) throw new Error("Use --yes in non-interactive environments.");
          const confirmed = await clack.confirm({ message: `Remove Channel ${channelId}?` });
          if (clack.isCancel(confirmed) || !confirmed) return;
        }
        printResult(channelDataFrom(await client.delete(conversationChannelPath(channelId))), Boolean(opts.json));
      }));

  const routes = channels.command("routes").description("Manage agent Routes for a Channel");
  routes.command("list <channel-id>")
    .option("--json", "Print JSON")
    .action((channelId: string, opts: { json?: boolean }) =>
      withChannelClient("Listing Channel Routes", opts, async (client) => {
        printResult(channelDataFrom(await client.get(conversationChannelPath(channelId, "routes"))), Boolean(opts.json));
      }));
  routes.command("add <channel-id>")
    .requiredOption("--agent <name>", "Agent name")
    .option("--allowed-tool <pattern>", "Restrict tools for this Route (repeatable)", collectOption, [])
    .option("--destination <id>", "Route-specific destination")
    .option("--priority <number>", "Route priority", "100")
    .option("--disabled", "Create the Route disabled")
    .option("--json", "Print JSON")
    .action((channelId: string, opts: { agent: string; allowedTool: string[]; destination?: string; disabled?: boolean; json?: boolean; priority: string }) =>
      withChannelClient("Adding a Channel Route", opts, async (client) => {
        const priority = Number(opts.priority);
        if (!Number.isSafeInteger(priority)) throw new Error("--priority must be an integer.");
        printResult(channelDataFrom(await client.post(conversationChannelPath(channelId, "routes"), {
          agentName: opts.agent,
          ...(opts.allowedTool.length > 0 ? { allowedTools: opts.allowedTool } : {}),
          externalChannelId: opts.destination,
          enabled: !opts.disabled,
          priority,
        })), Boolean(opts.json));
      }));
  routes.command("remove <channel-id> <route-id>")
    .alias("rm")
    .option("--yes", "Skip confirmation")
    .option("--json", "Print JSON")
    .action((channelId: string, routeId: string, opts: { json?: boolean; yes?: boolean }) =>
      withChannelClient("Removing a Channel Route", opts, async (client) => {
        if (!opts.yes) {
          if (!process.stdin.isTTY) throw new Error("Use --yes in non-interactive environments.");
          const confirmed = await clack.confirm({ message: `Remove Route ${routeId}?` });
          if (clack.isCancel(confirmed) || !confirmed) return;
        }
        printResult(channelDataFrom(await client.delete(
          conversationChannelPath(channelId, "routes", routeId),
        )), Boolean(opts.json));
      }));

  channels.command("setup-status <setup-id>")
    .description("Inspect a resumable secure setup")
    .option("--json", "Print JSON")
    .action((setupId: string, opts: { json?: boolean }) =>
      withChannelClient("Getting Channel setup status", opts, async (client) => {
        printResult(channelDataFrom(await client.get(conversationChannelPath("setups", setupId))), Boolean(opts.json));
      }));
}
