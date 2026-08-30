import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import {
  MEMORY_EXTRACTION_STATUSES,
  type MemoryExtractionCandidate,
  type MemoryExtractionStatus,
} from "@polpo-ai/core/memory";
import { createApiClient, type ApiClient, type ApiResponse } from "./api.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";

const MEMORY_EXTERNAL_USER_HEADER = "x-polpo-external-user-id";
const MEMORY_EXTERNAL_USER_PREFIX = "v1:";
const MAX_EXTERNAL_USER_ID_LENGTH = 512;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_REASON_LENGTH = 2_000;
const statusSet = new Set<string>(MEMORY_EXTRACTION_STATUSES);

type ApiEnvelope<T> = { code?: string; data?: T; error?: string; ok?: boolean };

type CandidatePage = {
  candidates: MemoryExtractionCandidate[];
  nextCursor: string | null;
};

type CandidateResult = { candidate: MemoryExtractionCandidate };
type CandidateAuditResult = { events: unknown[] };
type AppliedCandidateResult = CandidateResult & { memoryId: string };

type CandidateIdentityOptions = {
  agent: string;
  json?: boolean;
  user: string;
};

type CandidateReviewOptions = CandidateIdentityOptions & {
  reason?: string;
  revision: string;
};

export class MemoryCandidateCliApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "MemoryCandidateCliApiError";
  }
}

function requiredIdentifier(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${label} must contain between 1 and ${max} characters.`);
  }
  return normalized;
}

function normalizedReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const reason = value.trim();
  if (!reason || value.length > MAX_REASON_LENGTH) {
    throw new Error(`--reason must contain between 1 and ${MAX_REASON_LENGTH} characters.`);
  }
  return reason;
}

export function memoryCandidateHeaders(externalUserId: string): Record<string, string> {
  const normalized = requiredIdentifier(
    externalUserId,
    "External user ID",
    MAX_EXTERNAL_USER_ID_LENGTH,
  );
  return {
    [MEMORY_EXTERNAL_USER_HEADER]:
      `${MEMORY_EXTERNAL_USER_PREFIX}${encodeURIComponent(normalized)}`,
  };
}

export function memoryCandidatePath(
  agentName: string,
  candidateId?: string,
  action?: "audit" | "decision" | "apply",
): string {
  const agent = requiredIdentifier(agentName, "Agent name", 128);
  let path = `/v1/memory/agents/${encodeURIComponent(agent)}/memory/candidates`;
  if (candidateId !== undefined) {
    const candidate = requiredIdentifier(candidateId, "Candidate ID", 512);
    path += `/${encodeURIComponent(candidate)}`;
  }
  if (action !== undefined) {
    if (candidateId === undefined) throw new Error("Candidate ID is required for an action.");
    path += `/${action}`;
  }
  return path;
}

export function memoryCandidateListPath(
  agentName: string,
  options: {
    cursor?: string;
    limit?: string;
    statuses?: readonly string[];
  },
): string {
  const params = new URLSearchParams();
  if (options.statuses?.length) {
    const statuses = [...new Set(options.statuses.map((status) => status.trim()))];
    if (statuses.some((status) => !statusSet.has(status))) {
      throw new Error(`--status must be one of: ${MEMORY_EXTRACTION_STATUSES.join(", ")}.`);
    }
    params.set("statuses", statuses.join(","));
  }
  if (options.limit !== undefined) {
    if (!/^[1-9]\d*$/u.test(options.limit)) {
      throw new Error("--limit must be an integer between 1 and 100.");
    }
    const limit = Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit > 100) {
      throw new Error("--limit must be an integer between 1 and 100.");
    }
    params.set("limit", String(limit));
  }
  if (options.cursor !== undefined) {
    const cursor = requiredIdentifier(options.cursor, "Cursor", MAX_CURSOR_LENGTH);
    params.set("cursor", cursor);
  }
  const query = params.toString();
  return `${memoryCandidatePath(agentName)}${query ? `?${query}` : ""}`;
}

export function memoryCandidateRevision(value: string | undefined): number {
  if (value === undefined) throw new Error("--revision is required.");
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("--revision must be a positive integer.");
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw new Error("--revision must be a positive integer.");
  }
  return revision;
}

export function memoryCandidateDataFrom<T>(response: ApiResponse<ApiEnvelope<T>>): T {
  if (response.status < 200 || response.status >= 300) {
    throw new MemoryCandidateCliApiError(
      response.data?.error ?? `Memory candidate API returned HTTP ${response.status}`,
      response.data?.code ?? "MEMORY_CANDIDATE_API_ERROR",
      response.status,
    );
  }
  if (response.data?.data === undefined) {
    throw new MemoryCandidateCliApiError(
      "Memory candidate API success response is missing data.",
      "INVALID_API_RESPONSE",
      502,
    );
  }
  return response.data.data;
}

export async function approveMemoryCandidate(
  client: ApiClient,
  input: {
    agent: string;
    apply: boolean;
    candidateId: string;
    expectedRevision: number;
    externalUserId: string;
    reason?: string;
  },
): Promise<CandidateResult | AppliedCandidateResult> {
  const headers = memoryCandidateHeaders(input.externalUserId);
  const reason = normalizedReason(input.reason);
  const approved = memoryCandidateDataFrom(await client.post<ApiEnvelope<CandidateResult>>(
    memoryCandidatePath(input.agent, input.candidateId, "decision"),
    {
      decision: "approve",
      expectedRevision: input.expectedRevision,
      ...(reason ? { reason } : {}),
    },
    { headers },
  ));
  if (!input.apply) return approved;
  return memoryCandidateDataFrom(await client.post<ApiEnvelope<AppliedCandidateResult>>(
    memoryCandidatePath(input.agent, input.candidateId, "apply"),
    { expectedRevision: approved.candidate.revision },
    { headers },
  ));
}

function collectStatus(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (value && typeof value === "object" && "candidates" in value) {
    const page = value as CandidatePage;
    if (page.candidates.length === 0) {
      clack.log.info("No Memory suggestions found.");
      return;
    }
    clack.log.info(page.candidates.map((candidate) => [
      `  ${pc.bold(candidate.summary ?? candidate.content)}`,
      pc.dim(`    ${candidate.id}  ${candidate.status}  revision ${candidate.revision}`),
    ].join("\n")).join("\n"));
    if (page.nextCursor) clack.log.info(pc.dim(`Next cursor: ${page.nextCursor}`));
    return;
  }
  clack.log.info(JSON.stringify(value, null, 2));
}

async function withMemoryClient(
  operation: string,
  options: { json?: boolean },
  action: (client: ApiClient) => Promise<void>,
): Promise<void> {
  try {
    const credentials = await requireAuth({
      context: `${operation} requires an authenticated session.`,
    });
    const projectId = loadProjectId();
    if (!projectId) throw new Error("No project linked. Run polpo create or polpo link first.");
    await action(createApiClient(credentials, projectId));
  } catch (error) {
    if (options.json) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error instanceof MemoryCandidateCliApiError ? error.code : "CLI_ERROR",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof MemoryCandidateCliApiError ? { status: error.status } : {}),
      })}\n`);
      process.exitCode = 1;
      return;
    }
    clack.log.error(pc.red(friendlyError(error instanceof Error ? error.message : String(error))));
    process.exitCode = 1;
  }
}

function addIdentityOptions(command: Command): Command {
  return command
    .requiredOption("--agent <name>", "Agent that owns the Memory policy")
    .requiredOption("--user <external-user-id>", "Trusted external user scope")
    .option("--json", "Print JSON");
}

export function registerMemoryCommands(program: Command): void {
  const memory = program.command("memory").description("Manage typed Memory operations");
  const candidates = memory.command("candidates")
    .description("Review automatic-learning Memory suggestions");

  addIdentityOptions(candidates.command("list").description("List Memory suggestions"))
    .option("--status <status>", "Filter by status (repeatable)", collectStatus, [])
    .option("--limit <count>", "Maximum results (1-100)", "50")
    .option("--cursor <cursor>", "Opaque pagination cursor")
    .action((options: CandidateIdentityOptions & {
      cursor?: string;
      limit: string;
      status: MemoryExtractionStatus[];
    }) => withMemoryClient("Listing Memory suggestions", options, async (client) => {
      const headers = memoryCandidateHeaders(options.user);
      const path = memoryCandidateListPath(options.agent, {
        cursor: options.cursor,
        limit: options.limit,
        statuses: options.status,
      });
      const page = memoryCandidateDataFrom(await client.get<ApiEnvelope<CandidatePage>>(
        path,
        { headers },
      ));
      printResult(page, Boolean(options.json));
    }));

  addIdentityOptions(candidates.command("get <candidate-id>").description("Inspect one Memory suggestion"))
    .action((candidateId: string, options: CandidateIdentityOptions) =>
      withMemoryClient("Inspecting a Memory suggestion", options, async (client) => {
        const data = memoryCandidateDataFrom(await client.get<ApiEnvelope<CandidateResult>>(
          memoryCandidatePath(options.agent, candidateId),
          { headers: memoryCandidateHeaders(options.user) },
        ));
        printResult(data, Boolean(options.json));
      }));

  addIdentityOptions(candidates.command("audit <candidate-id>").description("Inspect suggestion audit history"))
    .action((candidateId: string, options: CandidateIdentityOptions) =>
      withMemoryClient("Inspecting Memory suggestion audit", options, async (client) => {
        const data = memoryCandidateDataFrom(await client.get<ApiEnvelope<CandidateAuditResult>>(
          memoryCandidatePath(options.agent, candidateId, "audit"),
          { headers: memoryCandidateHeaders(options.user) },
        ));
        printResult(data, Boolean(options.json));
      }));

  addIdentityOptions(candidates.command("approve <candidate-id>").description("Approve a pending suggestion"))
    .requiredOption("--revision <revision>", "Expected candidate revision")
    .option("--reason <reason>", "Operator decision reason")
    .option("--apply", "Apply the approved suggestion immediately")
    .action((candidateId: string, options: CandidateReviewOptions & { apply?: boolean }) =>
      withMemoryClient("Approving a Memory suggestion", options, async (client) => {
        const data = await approveMemoryCandidate(client, {
          agent: options.agent,
          apply: Boolean(options.apply),
          candidateId,
          expectedRevision: memoryCandidateRevision(options.revision),
          externalUserId: options.user,
          reason: options.reason,
        });
        printResult(data, Boolean(options.json));
      }));

  addIdentityOptions(candidates.command("reject <candidate-id>").description("Reject a pending suggestion"))
    .requiredOption("--revision <revision>", "Expected candidate revision")
    .option("--reason <reason>", "Operator decision reason")
    .action((candidateId: string, options: CandidateReviewOptions) =>
      withMemoryClient("Rejecting a Memory suggestion", options, async (client) => {
        const reason = normalizedReason(options.reason);
        const data = memoryCandidateDataFrom(await client.post<ApiEnvelope<CandidateResult>>(
          memoryCandidatePath(options.agent, candidateId, "decision"),
          {
            decision: "reject",
            expectedRevision: memoryCandidateRevision(options.revision),
            ...(reason ? { reason } : {}),
          },
          { headers: memoryCandidateHeaders(options.user) },
        ));
        printResult(data, Boolean(options.json));
      }));

  addIdentityOptions(candidates.command("apply <candidate-id>").description("Apply an approved suggestion"))
    .requiredOption("--revision <revision>", "Expected approved candidate revision")
    .action((candidateId: string, options: CandidateReviewOptions) =>
      withMemoryClient("Applying a Memory suggestion", options, async (client) => {
        const data = memoryCandidateDataFrom(await client.post<ApiEnvelope<AppliedCandidateResult>>(
          memoryCandidatePath(options.agent, candidateId, "apply"),
          { expectedRevision: memoryCandidateRevision(options.revision) },
          { headers: memoryCandidateHeaders(options.user) },
        ));
        printResult(data, Boolean(options.json));
      }));
}
