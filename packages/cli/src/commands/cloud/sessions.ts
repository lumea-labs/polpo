import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import pc from "picocolors";
import type {
  ClientToolResolution,
  ClientToolSettlementOutcome,
  SettledClientTool,
} from "@polpo-ai/core/session-client-tool-settlement";
import { createApiClient, type ApiClient } from "./api.js";
import {
  addEnvironmentOptions,
  resolveCliEnvironment,
  type EnvironmentOptions,
} from "./environment.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";

type SessionOptions = EnvironmentOptions & {
  agent?: string;
  dir?: string;
  json?: boolean;
  user?: string;
};

async function context(opts: SessionOptions): Promise<ApiClient> {
  const credentials = await requireAuth({
    context: "Session operations require an authenticated session.",
  });
  const projectId = loadProjectId(opts.dir ?? ".");
  if (!projectId) throw new Error("No project linked. Run polpo create or polpo link first.");
  return createApiClient(credentials, projectId, resolveCliEnvironment(opts));
}

export function sessionToolCallPath(
  sessionId: string,
  toolCallId: string,
  identity?: { agent?: string; user?: string },
): string {
  const params = new URLSearchParams();
  if (identity?.agent !== undefined) params.set("agent", identity.agent);
  if (identity?.user !== undefined) params.set("user", identity.user);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return `/v1/chat/sessions/${encodeURIComponent(sessionId)}`
    + `/tool-calls/${encodeURIComponent(toolCallId)}${query}`;
}

function settlementPath(sessionId: string, toolCallId: string): string {
  return `${sessionToolCallPath(sessionId, toolCallId)}/settlement`;
}

function parseSessionVersion(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("--session-version must be a non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("--session-version exceeds the supported integer range");
  }
  return parsed;
}

function parseOutcome(value: string): ClientToolSettlementOutcome {
  if (value !== "success" && value !== "failed" && value !== "cancelled") {
    throw new Error("--outcome must be success, failed, or cancelled");
  }
  return value;
}

function responseFailure(response: { status: number; data: any }): Error {
  const code = response.data?.code ? ` (${response.data.code})` : "";
  return new Error(response.data?.error
    ? `${response.data.error}${code}`
    : `Session API returned ${response.status}${code}`);
}

function printResolution(value: ClientToolResolution, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(pc.bold(`Client tool ${value.toolCallId}`));
  console.log(`Session: ${value.sessionId}`);
  console.log(`Version: ${value.sessionVersion}`);
  console.log(`Resolution: ${value.status}`);
  if (value.status === "settled") {
    console.log(`Outcome: ${value.receipt.outcome}`);
    console.log(`Settled: ${value.receipt.settledAt}`);
  } else if (value.status === "continuation") {
    console.log(`Continuation Run: ${value.receipt.runId}`);
    console.log(`Run status: ${(value as ClientToolResolution & { runStatus?: string }).runStatus ?? "unknown"}`);
  }
}

function printSettlement(value: SettledClientTool, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(pc.green(value.status === "replay"
    ? "Existing client-tool settlement receipt"
    : "Client tool settled"));
  console.log(`Receipt: ${value.receipt.id}`);
  console.log(`Outcome: ${value.receipt.outcome}`);
  console.log(`Session version: ${value.receipt.sessionVersion}`);
}

export function registerSessionCommands(program: Command): void {
  const sessions = program.command("sessions")
    .description("Inspect Sessions, rename titles, or settle durable client-tool calls");

  addEnvironmentOptions(sessions.command("show <session-id>"))
    .description("Read Session metadata, including automatic title state, without loading messages")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (id: string, opts: SessionOptions) => {
      try {
        const response = await (await context(opts)).get<any>(`/v1/chat/sessions/${encodeURIComponent(id)}`);
        if (response.status !== 200 || !response.data?.data) throw responseFailure(response);
        console.log(JSON.stringify(response.data.data, null, 2));
      } catch (error) { console.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error)))); process.exitCode = 1; }
    });

  addEnvironmentOptions(sessions.command("rename <session-id> <title>"))
    .description("Set a manual Session title; automatic generation will never overwrite it")
    .option("--title-revision <revision>", "Expected title revision (independent from conversation version)")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (id: string, title: string, opts: SessionOptions & { titleRevision?: string }) => {
      try {
        if (!title.trim()) throw new Error("Title must not be empty");
        const expectedTitleRevision = opts.titleRevision === undefined ? undefined : parseSessionVersion(opts.titleRevision);
        const response = await (await context(opts)).patch<any>(`/v1/chat/sessions/${encodeURIComponent(id)}`, { title, ...(expectedTitleRevision === undefined ? {} : { expectedTitleRevision }) });
        if (response.status !== 200 || !response.data?.data) throw responseFailure(response);
        console.log(JSON.stringify(response.data.data, null, 2));
      } catch (error) { console.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error)))); process.exitCode = 1; }
    });

  addEnvironmentOptions(sessions.command("tool-call <session-id> <tool-call-id>"))
    .description("Inspect one client-tool resolution without executing work")
    .option("--agent <name>", "Exact Session agent; omit only for an agentless Session")
    .option("--user <id>", "Exact Session external user; omit only for a userless Session")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--json", "Print machine-readable JSON")
    .action(async (sessionId: string, toolCallId: string, opts: SessionOptions) => {
      try {
        const client = await context(opts);
        const response = await client.get<{ ok: true; data: ClientToolResolution }>(
          sessionToolCallPath(sessionId, toolCallId, opts),
        );
        const value = response.data?.data;
        if (response.status !== 200 || !value) throw responseFailure(response);
        printResolution(value, opts.json);
      } catch (error) {
        console.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
        process.exitCode = 1;
      }
    });

  addEnvironmentOptions(sessions.command("settle-tool-call <session-id> <tool-call-id>"))
    .description("Close one never-accepted client tool without invoking the agent")
    .requiredOption("--outcome <outcome>", "success, failed, or cancelled")
    .requiredOption("--session-version <version>", "Expected current Session version")
    .requiredOption("--idempotency-key <key>", "Stable key retained for exact retries")
    .option("--result-file <path>", "Read the exact result string from a UTF-8 file")
    .option("--reason <text>", "Failure or cancellation reason")
    .option("--agent <name>", "Exact Session agent; omit only for an agentless Session")
    .option("--user <id>", "Exact Session external user; omit only for a userless Session")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--json", "Print machine-readable JSON")
    .action(async (sessionId: string, toolCallId: string, opts: SessionOptions & {
      idempotencyKey: string;
      outcome: string;
      reason?: string;
      resultFile?: string;
      sessionVersion: string;
    }) => {
      try {
        const outcome = parseOutcome(opts.outcome);
        const expectedSessionVersion = parseSessionVersion(opts.sessionVersion);
        const result = opts.resultFile === undefined
          ? undefined
          : await readFile(opts.resultFile, "utf8");
        if (outcome === "success" && result === undefined) {
          throw new Error("--result-file is required when --outcome is success");
        }
        if (outcome === "success" && opts.reason !== undefined) {
          throw new Error("--reason is not valid when --outcome is success");
        }
        const client = await context(opts);
        const response = await client.put<{ ok: true; data: SettledClientTool }>(
          settlementPath(sessionId, toolCallId),
          {
            ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
            ...(opts.user !== undefined ? { user: opts.user } : {}),
            expectedSessionVersion,
            outcome,
            ...(result !== undefined ? { result } : {}),
            ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          },
          { headers: { "Idempotency-Key": opts.idempotencyKey } },
        );
        const value = response.data?.data;
        if (response.status !== 200 || !value) throw responseFailure(response);
        printSettlement(value, opts.json);
      } catch (error) {
        console.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
        process.exitCode = 1;
      }
    });
}
