import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { createApiClient, type ApiClient, type ApiResponse } from "./api.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";

type VolumeStrategy = "mounted" | "hydrated";
type VolumeAccess = "read-only" | "read-write";
type VolumeWriteBack = "auto" | "manual";

type VolumeResource = {
  id: string;
  name: string;
  label: string | null;
  strategy: VolumeStrategy;
  access: VolumeAccess;
  writeBack: VolumeWriteBack | null;
  mountPath: string;
  revision: number;
  syncState: "ready" | "syncing" | "failed";
  syncError: string | null;
  lastSyncedAt: string | null;
  totalFiles: number;
  totalSize: number;
};

type VolumeGrant = {
  agentName: string;
  volumeId: string;
  access: VolumeAccess;
  writeBack: VolumeWriteBack | null;
  createdAt: string;
  updatedAt: string;
};

type VolumeCatalog = {
  volumes: VolumeResource[];
  defaults: {
    strategies: VolumeStrategy[];
    accessModes: VolumeAccess[];
    writeBackModes: VolumeWriteBack[];
  };
};

type ApiEnvelope<T> = { code?: string; data?: T; error?: string; ok?: boolean };

export class VolumeCliApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "VolumeCliApiError";
  }
}

export function volumePath(...segments: string[]): string {
  const grantPath = segments[0] === "grants";
  const base = grantPath ? "/v1/files/volume-grants" : "/v1/files/volumes";
  const rest = grantPath ? segments.slice(1) : segments;
  return `${base}${rest.length ? `/${rest.map(encodeURIComponent).join("/")}` : ""}`;
}

export function volumeDataFrom<T>(response: ApiResponse<ApiEnvelope<T>>): T {
  if (response.status < 200 || response.status >= 300) {
    throw new VolumeCliApiError(
      response.data?.error ?? `Volumes API returned HTTP ${response.status}`,
      response.data?.code ?? "VOLUME_API_ERROR",
      response.status,
    );
  }
  if (response.data?.data === undefined) {
    throw new VolumeCliApiError("Volumes API success response is missing data.", "INVALID_API_RESPONSE", 502);
  }
  return response.data.data;
}

type VolumeWriteOptions = {
  access?: string;
  clearLabel?: boolean;
  clearWriteBack?: boolean;
  defaultMountPath?: boolean;
  label?: string;
  mountPath?: string;
  name?: string;
  strategy?: string;
  writeBack?: string;
};

function oneOf<T extends string>(value: string | undefined, values: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) {
    throw new Error(`${label} must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

export function volumeWriteBody(
  options: VolumeWriteOptions,
  create: boolean,
): Record<string, unknown> {
  if (options.clearLabel && options.label !== undefined) {
    throw new Error("--clear-label cannot be combined with --label.");
  }
  if (options.defaultMountPath && options.mountPath !== undefined) {
    throw new Error("--default-mount-path cannot be combined with --mount-path.");
  }
  if (options.clearWriteBack && options.writeBack !== undefined) {
    throw new Error("--clear-write-back cannot be combined with --write-back.");
  }
  const name = options.name?.trim();
  if (create && !name) throw new Error("Volume name is required.");
  if (name && !/^[a-z][a-z0-9_-]{1,62}$/.test(name)) {
    throw new Error("Volume name must start with a lowercase letter and contain 2-63 lowercase letters, numbers, dashes, or underscores.");
  }
  const strategy = oneOf(options.strategy, ["mounted", "hydrated"] as const, "--strategy");
  const access = oneOf(options.access, ["read-only", "read-write"] as const, "--access");
  const writeBack = oneOf(options.writeBack, ["auto", "manual"] as const, "--write-back");
  if (create && strategy === undefined) throw new Error("--strategy is required when creating a volume.");
  if (strategy === "mounted" && writeBack !== undefined) {
    throw new Error("Mounted volumes do not support writeback.");
  }
  if (access === "read-only" && writeBack !== undefined) {
    throw new Error("Read-only volumes do not support writeback.");
  }

  const body: Record<string, unknown> = {};
  if (create) body.name = name;
  if (strategy !== undefined) body.strategy = strategy;
  if (access !== undefined) body.access = access;
  if (options.clearLabel) body.label = null;
  else if (options.label !== undefined) body.label = options.label.trim() || null;
  if (options.defaultMountPath) body.mountPath = null;
  else if (options.mountPath !== undefined) body.mountPath = options.mountPath.trim() || null;
  if (options.clearWriteBack) body.writeBack = null;
  else if (writeBack !== undefined) body.writeBack = writeBack;
  else if (strategy === "mounted" || access === "read-only") body.writeBack = null;
  if (!create && Object.keys(body).length === 0) {
    throw new Error("Specify at least one volume field to update.");
  }
  return body;
}

export function volumeGrantBody(options: {
  access?: string;
  writeBack?: string;
}): Record<string, unknown> {
  const access = oneOf(options.access, ["read-only", "read-write"] as const, "--access");
  const writeBack = oneOf(options.writeBack, ["auto", "manual"] as const, "--write-back");
  if (access === "read-only" && writeBack !== undefined) {
    throw new Error("Read-only grants do not support writeback.");
  }
  return {
    ...(access === undefined ? {} : { access }),
    ...(writeBack === undefined ? {} : { writeBack }),
  };
}

export function findVolumeByName(
  volumes: Array<Pick<VolumeResource, "id" | "name">>,
  name: string,
): Pick<VolumeResource, "id" | "name"> {
  const normalized = name.trim();
  const volume = volumes.find((item) => item.name === normalized);
  if (!volume) throw new Error(`Sandbox volume not found: ${normalized}`);
  return volume;
}

function printValue(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  clack.log.info(JSON.stringify(value, null, 2));
}

function printVolumes(catalog: VolumeCatalog, json: boolean): void {
  if (json) return printValue(catalog, true);
  if (catalog.volumes.length === 0) {
    clack.log.info("No persistent sandbox volumes.");
    return;
  }
  clack.log.info(catalog.volumes.map((volume) => {
    const writeBack = volume.writeBack ? `, ${volume.writeBack} writeback` : "";
    const state = volume.syncState === "ready" ? "" : `, ${volume.syncState}`;
    return `  ${pc.bold(volume.name)}${pc.dim(`  ${volume.strategy}, ${volume.access}${writeBack}${state}`)}`;
  }).join("\n"));
}

async function getCatalog(client: ApiClient): Promise<VolumeCatalog> {
  return volumeDataFrom(await client.get<ApiEnvelope<VolumeCatalog>>(volumePath()));
}

async function withVolumeClient(
  operation: string,
  options: { json?: boolean },
  action: (client: ApiClient) => Promise<void>,
): Promise<void> {
  try {
    const credentials = await requireAuth({ context: `${operation} requires an authenticated session.` });
    const projectId = loadProjectId();
    if (!projectId) throw new Error("No project linked. Run polpo create or polpo link first.");
    await action(createApiClient(credentials, projectId));
  } catch (error) {
    if (options.json) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error instanceof VolumeCliApiError ? error.code : "CLI_ERROR",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof VolumeCliApiError ? { status: error.status } : {}),
      })}\n`);
      process.exitCode = 1;
      return;
    }
    clack.log.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
    process.exitCode = 1;
  }
}

function addVolumePolicyOptions(command: Command, create: boolean): Command {
  command
    .option("--label <label>", "Human-readable label")
    .option("--strategy <strategy>", "mounted or hydrated")
    .option("--access <access>", "read-only or read-write")
    .option("--write-back <mode>", "auto or manual (hydrated read-write only)")
    .option("--mount-path <path>", "Path below the host-approved project root")
    .option("--json", "Print JSON");
  if (!create) {
    command
      .option("--clear-label", "Remove the human-readable label")
      .option("--clear-write-back", "Clear writeback when switching policy")
      .option("--default-mount-path", "Restore the host default mount path");
  }
  return command;
}

export function registerVolumesCommand(program: Command): void {
  const volumes = program
    .command("volumes")
    .description("Manage persistent sandbox volumes and agent grants");

  volumes.command("list")
    .description("List project sandbox volumes")
    .option("--json", "Print JSON")
    .action((options: { json?: boolean }) => withVolumeClient("Listing sandbox volumes", options, async (client) => {
      printVolumes(await getCatalog(client), Boolean(options.json));
    }));

  volumes.command("get <name>")
    .description("Inspect one project sandbox volume")
    .option("--json", "Print JSON")
    .action((name: string, options: { json?: boolean }) => withVolumeClient("Inspecting a sandbox volume", options, async (client) => {
      const catalog = await getCatalog(client);
      const volume = findVolumeByName(catalog.volumes, name) as VolumeResource;
      printValue(volume, Boolean(options.json));
    }));

  addVolumePolicyOptions(
    volumes.command("create <name>").description("Create a project sandbox volume"),
    true,
  ).action((name: string, options: VolumeWriteOptions & { json?: boolean }) =>
    withVolumeClient("Creating a sandbox volume", options, async (client) => {
      const body = volumeWriteBody({ ...options, name }, true);
      const volume = volumeDataFrom(await client.post<ApiEnvelope<VolumeResource>>(volumePath(), body));
      printValue(volume, Boolean(options.json));
    }));

  addVolumePolicyOptions(
    volumes.command("update <name>").description("Update a project sandbox volume policy"),
    false,
  ).action((name: string, options: VolumeWriteOptions & { json?: boolean }) =>
    withVolumeClient("Updating a sandbox volume", options, async (client) => {
      const body = volumeWriteBody(options, false);
      const volume = volumeDataFrom(await client.patch<ApiEnvelope<VolumeResource>>(volumePath(name), body));
      printValue(volume, Boolean(options.json));
    }));

  volumes.command("remove <name>")
    .alias("rm")
    .description("Delete a project sandbox volume")
    .option("--yes", "Skip confirmation")
    .option("--json", "Print JSON")
    .action((name: string, options: { json?: boolean; yes?: boolean }) =>
      withVolumeClient("Deleting a sandbox volume", options, async (client) => {
        if (!options.yes) {
          if (!process.stdin.isTTY) throw new Error("Use --yes in non-interactive environments.");
          const confirmed = await clack.confirm({ message: `Delete sandbox volume ${name}?` });
          if (clack.isCancel(confirmed) || !confirmed) return;
        }
        const result = volumeDataFrom(await client.delete<ApiEnvelope<{ removed: true; name: string }>>(volumePath(name)));
        printValue(result, Boolean(options.json));
      }));

  const grants = volumes.command("grants").description("Manage per-agent sandbox volume grants");

  grants.command("list")
    .description("List sandbox volume grants for an agent")
    .requiredOption("--agent <name>", "Agent name")
    .option("--json", "Print JSON")
    .action((options: { agent: string; json?: boolean }) =>
      withVolumeClient("Listing sandbox volume grants", options, async (client) => {
        const [catalog, response] = await Promise.all([
          getCatalog(client),
          client.get<ApiEnvelope<{ grants: VolumeGrant[] }>>(volumePath("grants", options.agent)),
        ]);
        const { grants: rows } = volumeDataFrom(response);
        const byId = new Map(catalog.volumes.map((volume) => [volume.id, volume]));
        const enriched = rows.map((grant) => ({
          ...grant,
          volumeName: byId.get(grant.volumeId)?.name ?? null,
        }));
        printValue({ grants: enriched }, Boolean(options.json));
      }));

  grants.command("set <volume>")
    .description("Create or narrow an agent's sandbox volume grant")
    .requiredOption("--agent <name>", "Agent name")
    .option("--access <access>", "read-only or read-write")
    .option("--write-back <mode>", "auto or manual (hydrated read-write only)")
    .option("--json", "Print JSON")
    .action((volumeName: string, options: { access?: string; agent: string; json?: boolean; writeBack?: string }) =>
      withVolumeClient("Setting a sandbox volume grant", options, async (client) => {
        const volume = findVolumeByName((await getCatalog(client)).volumes, volumeName);
        const grant = volumeDataFrom(await client.put<ApiEnvelope<VolumeGrant>>(
          volumePath("grants", options.agent, volume.id),
          volumeGrantBody(options),
        ));
        printValue({ ...grant, volumeName: volume.name }, Boolean(options.json));
      }));

  grants.command("revoke <volume>")
    .description("Revoke an agent's sandbox volume grant")
    .requiredOption("--agent <name>", "Agent name")
    .option("--yes", "Skip confirmation")
    .option("--json", "Print JSON")
    .action((volumeName: string, options: { agent: string; json?: boolean; yes?: boolean }) =>
      withVolumeClient("Revoking a sandbox volume grant", options, async (client) => {
        if (!options.yes) {
          if (!process.stdin.isTTY) throw new Error("Use --yes in non-interactive environments.");
          const confirmed = await clack.confirm({ message: `Revoke ${volumeName} from ${options.agent}?` });
          if (clack.isCancel(confirmed) || !confirmed) return;
        }
        const volume = findVolumeByName((await getCatalog(client)).volumes, volumeName);
        const result = volumeDataFrom(await client.delete<ApiEnvelope<{ removed: true }>>(
          volumePath("grants", options.agent, volume.id),
        ));
        printValue({ ...result, agentName: options.agent, volumeName: volume.name }, Boolean(options.json));
      }));
}
