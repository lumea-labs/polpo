import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import pc from "picocolors";
import type { SteeringMode, SteeringReceipt } from "@polpo-ai/core/steering";
import { createApiClient } from "./api.js";
import {
  addEnvironmentOptions,
  resolveCliEnvironment,
  type EnvironmentOptions,
} from "./environment.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";

type RunOptions = EnvironmentOptions & { dir?: string; json?: boolean };

async function context(opts: RunOptions) {
  const credentials = await requireAuth({ context: "Run control requires an authenticated session." });
  const projectId = loadProjectId(opts.dir ?? ".");
  if (!projectId) throw new Error("No project linked. Run polpo create or polpo link first.");
  return createApiClient(credentials, projectId, resolveCliEnvironment(opts));
}

function receiptPath(runId: string, messageId?: string): string {
  const base = `/v1/runs/${encodeURIComponent(runId)}/steering`;
  return messageId === undefined ? base : `${base}/${encodeURIComponent(messageId)}`;
}

function printReceipt(receipt: SteeringReceipt, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  console.log(pc.bold(`Steering ${receipt.messageId}`));
  console.log(`Admission: ${receipt.admission}`);
  console.log(`Delivery: ${receipt.delivery}`);
  console.log(`Policy: ${receipt.acceptance} (${receipt.policySource})`);
  if (receipt.reasonCode) console.log(`Reason: ${receipt.reasonCode}`);
  if (receipt.response) console.log(`Response [${receipt.response.locale}]: ${receipt.response.text}`);
}

function failure(response: { status: number; data: any }): Error {
  return new Error(response.data?.error ?? `Runs API returned ${response.status}`);
}

export function registerRunsCommands(program: Command): void {
  const runs = program.command("runs").description("Steer, inspect, or abort active Runs");

  addEnvironmentOptions(runs.command("steer <run-id>"))
    .description("Send an instruction at the next safe agent boundary")
    .requiredOption("-m, --message <text>", "Instruction text")
    .option("--id <message-id>", "Idempotency key; generated when omitted")
    .option("--mode <mode>", "steer or follow_up", "steer")
    .option("--locale <tag>", "BCP 47 language tag for deterministic outcome messages")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--json", "Print machine-readable JSON")
    .action(async (runId: string, opts: RunOptions & {
      message: string;
      id?: string;
      mode: SteeringMode;
      locale?: string;
    }) => {
      try {
        if (opts.mode !== "steer" && opts.mode !== "follow_up") {
          throw new Error("--mode must be steer or follow_up");
        }
        const client = await context(opts);
        const response = await client.post<any>(receiptPath(runId), {
          id: opts.id ?? `steer-${randomUUID()}`,
          mode: opts.mode,
          ...(opts.locale ? { locale: opts.locale } : {}),
          content: { text: opts.message },
        });
        const receipt = response.data?.data?.receipt as SteeringReceipt | undefined;
        if ((response.status !== 200 && response.status !== 202) || !receipt) throw failure(response);
        printReceipt(receipt, opts.json);
      } catch (error) {
        console.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
        process.exitCode = 1;
      }
    });

  const steering = runs.command("steering").description("Inspect steering delivery receipts");
  addEnvironmentOptions(steering.command("get <run-id> <message-id>"))
    .description("Get one admission and delivery receipt")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--json", "Print machine-readable JSON")
    .action(async (runId: string, messageId: string, opts: RunOptions) => {
      try {
        const client = await context(opts);
        const response = await client.get<any>(receiptPath(runId, messageId));
        const receipt = response.data?.data?.receipt as SteeringReceipt | undefined;
        if (response.status !== 200 || !receipt) throw failure(response);
        printReceipt(receipt, opts.json);
      } catch (error) {
        console.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
        process.exitCode = 1;
      }
    });

  addEnvironmentOptions(runs.command("abort <run-id>"))
    .description("Abort an active Run")
    .option("--reason <text>", "Caller-visible abort reason")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--json", "Print machine-readable JSON")
    .action(async (runId: string, opts: RunOptions & { reason?: string }) => {
      try {
        const client = await context(opts);
        const response = await client.post<any>(`/v1/runs/${encodeURIComponent(runId)}/abort`,
          opts.reason ? { reason: opts.reason } : {});
        if (response.status !== 202) throw failure(response);
        const value = response.data?.data ?? response.data;
        if (opts.json) console.log(JSON.stringify(value, null, 2));
        else console.log(pc.green(`Abort accepted for Run ${runId}`));
      } catch (error) {
        console.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
        process.exitCode = 1;
      }
    });
}
