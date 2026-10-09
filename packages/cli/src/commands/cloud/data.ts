import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import {
  CreateDataSchema,
  DataBatchSchema,
  MigrateDataSchema,
  parseData,
} from "@polpo-ai/core/data";
import { createApiClient, type ApiClient } from "./api.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";

export async function readDataJson(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length > 262144) throw new Error("Data input exceeds 256 KiB");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid Data JSON file");
  }
}
async function run(
  action: (client: ApiClient) => Promise<{ status: number; data: any }>,
  options: { project?: string; url?: string },
) {
  try {
    const credentials =
      process.env.POLPO_DATA_API_KEY && options.url
        ? { apiKey: process.env.POLPO_DATA_API_KEY, baseUrl: options.url }
        : await requireAuth({
            context: "Data requires an authenticated session.",
          });
    const projectId = options.project ?? loadProjectId();
    if (!projectId && !options.url)
      throw new Error(
        "No project linked. Use --project or link a project first.",
      );
    const response = await action(
      createApiClient(
        options.url ? { ...credentials, baseUrl: options.url } : credentials,
        projectId,
      ),
    );
    if (response.status >= 400 || !response.data?.ok)
      throw new Error(
        response.data?.error ?? `Data API returned ${response.status}`,
      );
    process.stdout.write(`${JSON.stringify(response.data.data, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Data command failed"}\n`,
    );
    process.exitCode = 1;
  }
}
export function registerDataCommand(program: Command): void {
  const data = program
    .command("data")
    .description("Manage structured application Data");
  const command = (signature: string, description: string) =>
    data
      .command(signature)
      .description(description)
      .option("--project <id>", "Project ID")
      .option(
        "--url <url>",
        "API origin override (including /api for self-hosted)",
      );
  command("list", "List granted Data resources").action((opts) =>
    run((client) => client.get("/v1/data"), opts),
  );
  command("describe <resource>", "Inspect tables and schema version").action(
    (ref, opts) =>
      run((client) => client.get(`/v1/data/${encodeURIComponent(ref)}`), opts),
  );
  command(
    "create <file>",
    "Create Data from a JSON {name,schema} document",
  ).action((file, opts) =>
    run(
      async (client) =>
        client.post(
          "/v1/data",
          parseData(CreateDataSchema, await readDataJson(file)),
        ),
      opts,
    ),
  );
  command(
    "migrate <resource> <file>",
    "Apply {expectedVersion,schema} additively",
  ).action((ref, file, opts) =>
    run(
      async (client) =>
        client.put(
          `/v1/data/${encodeURIComponent(ref)}/schema`,
          parseData(MigrateDataSchema, await readDataJson(file)),
        ),
      opts,
    ),
  );
  command(
    "execute <resource> <file>",
    "Execute an atomic {operations,idempotencyKey?} JSON batch",
  ).action((ref, file, opts) =>
    run(
      async (client) =>
        client.post(
          `/v1/data/${encodeURIComponent(ref)}/transactions`,
          parseData(DataBatchSchema, await readDataJson(file)),
        ),
      opts,
    ),
  );
  command(
    "rename <resource> <name>",
    "Rename Data without changing its identity",
  )
    .requiredOption("--version <version>", "Expected schema version")
    .action((ref, name, opts) =>
      run(
        (client) =>
          client.patch(`/v1/data/${encodeURIComponent(ref)}`, {
            name,
            expectedVersion: Number(opts.version),
          }),
        opts,
      ),
    );
  command("delete <resource>", "Delete Data and its records")
    .requiredOption("--version <version>", "Expected schema version")
    .requiredOption(
      "--confirm <resource>",
      "Repeat the exact resource name or ID",
    )
    .action((ref, opts) =>
      run(async (client) => {
        if (opts.confirm !== ref)
          throw new Error("--confirm must match the resource exactly");
        return client.delete(
          `/v1/data/${encodeURIComponent(ref)}?expectedVersion=${encodeURIComponent(opts.version)}`,
        );
      }, opts),
    );
}
