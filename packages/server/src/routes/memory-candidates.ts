import { Hono, type Context } from "hono";
import {
  MEMORY_EXTRACTION_STATUSES,
  MemoryAuthorizationError,
  MemoryConflictError,
  MemoryContractError,
  applyMemoryExtractionCandidate,
  type MemoryExtractionCandidate,
  type MemoryExtractionStatus,
  type MemoryExtractionStoreContext,
  type MemoryStoreContext,
} from "@polpo-ai/core";
import type { MemoryRouteDeps } from "../deps.js";

const statuses = new Set<string>(MEMORY_EXTRACTION_STATUSES);
const queryKeys = new Set(["statuses", "limit", "cursor"]);
const decisionKeys = new Set(["decision", "reason", "expectedRevision"]);
const applyKeys = new Set(["expectedRevision"]);
const CURSOR_PREFIX = "mc1.";
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_SIZE = 4_096;

class InvalidCandidateRequestError extends Error {}

interface ResolvedCandidateRoute {
  readonly deps: MemoryRouteDeps;
  readonly agent: string;
  readonly candidateContext: MemoryExtractionStoreContext;
  readonly itemContext: MemoryStoreContext;
}

interface CandidateCursor {
  readonly createdAt: string;
  readonly id: string;
  readonly filter: string;
}

export function memoryCandidateRoutes(
  getDeps: (requestContext: unknown) => MemoryRouteDeps,
): Hono {
  const app = new Hono();

  app.get("/agents/:agentName/memory/candidates", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      const url = new URL(context.req.url);
      for (const key of url.searchParams.keys()) {
        if (!queryKeys.has(key)) throw new InvalidCandidateRequestError();
      }
      const requestedStatuses = parseStatuses(url.searchParams.get("statuses"));
      const limit = parseLimit(url.searchParams.get("limit"));
      const filter = JSON.stringify({
        agent: resolved.agent,
        statuses: requestedStatuses ? [...requestedStatuses].sort() : null,
      });
      const cursor = parseCursor(url.searchParams.get("cursor"), filter);
      const candidates = await resolved.deps.memoryExtractionStore!.list({
        ...(requestedStatuses ? { statuses: requestedStatuses } : {}),
        ...(cursor ? { after: { createdAt: cursor.createdAt, id: cursor.id } } : {}),
        limit: limit + 1,
      }, resolved.candidateContext);
      const items = candidates.slice(0, limit);
      const nextCursor = candidates.length > limit && items.length > 0
        ? encodeCursor(items.at(-1)!, filter)
        : null;
      return context.json({ ok: true, data: { candidates: items, nextCursor } }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.get("/agents/:agentName/memory/candidates/:candidateId", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      const candidate = await requiredCandidate(context, resolved);
      return context.json({ ok: true, data: { candidate } }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.get("/agents/:agentName/memory/candidates/:candidateId/audit", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      const candidate = await requiredCandidate(context, resolved);
      const events = await resolved.deps.memoryExtractionStore!.listAudit(
        candidate.id,
        resolved.candidateContext,
      );
      return context.json({ ok: true, data: { events } }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post("/agents/:agentName/memory/candidates/:candidateId/decision", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      if (!resolved.deps.resolveMemoryReviewer) {
        return context.json({
          ok: false,
          error: "Memory candidate review is not available",
          code: "MEMORY_REVIEW_UNAVAILABLE",
        }, 503);
      }
      const input = await body(context, decisionKeys);
      if (input.decision !== "approve" && input.decision !== "reject") {
        throw new InvalidCandidateRequestError();
      }
      const reason = optionalText(input.reason, "reason", 2_000);
      const expectedRevision = optionalRevision(input.expectedRevision);
      const reviewer = await resolved.deps.resolveMemoryReviewer(
        resolved.agent,
        context,
      );
      const candidate = await resolved.deps.memoryExtractionStore!.decide(
        context.req.param("candidateId"),
        {
          decision: input.decision,
          decidedBy: reviewer,
          ...(reason ? { reason } : {}),
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        },
        resolved.candidateContext,
      );
      return context.json({ ok: true, data: { candidate } }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post("/agents/:agentName/memory/candidates/:candidateId/apply", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      const input = await body(context, applyKeys);
      const expectedRevision = optionalRevision(input.expectedRevision);
      let candidate = await requiredCandidate(context, resolved);
      if (
        expectedRevision !== undefined
        && candidate.revision !== expectedRevision
      ) {
        throw new MemoryConflictError("Memory extraction revision changed");
      }
      if (candidate.status !== "approved" && candidate.status !== "applied") {
        throw new MemoryConflictError("Memory candidate is not approved");
      }
      const memoryId = await applyMemoryExtractionCandidate(
        candidate,
        resolved.deps.memoryItemStore!,
        resolved.itemContext,
        resolved.deps.now,
      );
      if (candidate.status !== "applied") {
        candidate = await resolved.deps.memoryExtractionStore!.markApplied(
          candidate.id,
          { memoryId, expectedRevision: candidate.revision },
          resolved.candidateContext,
        );
      }
      return context.json({ ok: true, data: { candidate, memoryId } }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return app;
}

async function resolve(
  context: Context,
  getDeps: (requestContext: unknown) => MemoryRouteDeps,
): Promise<ResolvedCandidateRoute | Response> {
  try {
    const agent = context.req.param("agentName").trim();
    if (!agent || agent.length > 128) throw new InvalidCandidateRequestError();
    const deps = getDeps(context);
    if (!deps.memoryExtractionStore || !deps.memoryItemStore) {
      return context.json({
        ok: false,
        error: "Memory candidate review is not available",
        code: "MEMORY_REVIEW_UNAVAILABLE",
      }, 503);
    }
    const itemContext = await deps.resolveMemoryContext(agent, context);
    if (itemContext.access.agentName !== agent) throw new MemoryAuthorizationError();
    return {
      deps,
      agent,
      itemContext,
      candidateContext: {
        namespace: itemContext.namespace,
        access: itemContext.access,
      },
    };
  } catch (error) {
    return errorResponse(context, error);
  }
}

async function requiredCandidate(
  context: Context,
  resolved: ResolvedCandidateRoute,
): Promise<MemoryExtractionCandidate> {
  const candidate = await resolved.deps.memoryExtractionStore!.get(
    context.req.param("candidateId"),
    resolved.candidateContext,
  );
  if (!candidate) throw new MemoryContractError("Memory candidate not found", "invalid_item", "id");
  return candidate;
}

async function body(context: Context, allowed: ReadonlySet<string>): Promise<Record<string, unknown>> {
  const parsed = await context.req.json().catch(() => {
    throw new InvalidCandidateRequestError();
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidCandidateRequestError();
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new InvalidCandidateRequestError();
  }
  return value;
}

function parseStatuses(value: string | null): MemoryExtractionStatus[] | undefined {
  if (value === null) return undefined;
  const values = value.split(",").map((item) => item.trim());
  if (!values.length || values.some((item) => !statuses.has(item))) {
    throw new InvalidCandidateRequestError();
  }
  return [...new Set(values)] as MemoryExtractionStatus[];
}

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^[1-9]\d*$/u.test(value)) throw new InvalidCandidateRequestError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_PAGE_SIZE) {
    throw new InvalidCandidateRequestError();
  }
  return parsed;
}

function optionalRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new InvalidCandidateRequestError();
  }
  return value as number;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new InvalidCandidateRequestError(`Invalid ${field}`);
  }
  return value.trim();
}

function encodeCursor(candidate: MemoryExtractionCandidate, filter: string): string {
  const payload = JSON.stringify({
    v: 1,
    createdAt: candidate.createdAt,
    id: candidate.id,
    filter,
  });
  return `${CURSOR_PREFIX}${base64UrlEncode(payload)}`;
}

function parseCursor(value: string | null, filter: string): CandidateCursor | undefined {
  if (value === null) return undefined;
  if (value.length > MAX_CURSOR_SIZE || !value.startsWith(CURSOR_PREFIX)) {
    throw new InvalidCandidateRequestError();
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(value.slice(CURSOR_PREFIX.length)));
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || parsed.v !== 1
      || typeof parsed.createdAt !== "string"
      || typeof parsed.id !== "string"
      || parsed.filter !== filter
      || new Date(parsed.createdAt).toISOString() !== parsed.createdAt
    ) {
      throw new InvalidCandidateRequestError();
    }
    return { createdAt: parsed.createdAt, id: parsed.id, filter };
  } catch (error) {
    if (error instanceof InvalidCandidateRequestError) throw error;
    throw new InvalidCandidateRequestError();
  }
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new InvalidCandidateRequestError();
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function errorResponse(context: Context, error: unknown): Response {
  if (error instanceof MemoryAuthorizationError) {
    return context.json({ ok: false, error: "Memory access denied", code: "MEMORY_FORBIDDEN" }, 403);
  }
  if (error instanceof MemoryConflictError) {
    return context.json({ ok: false, error: "Memory conflict", code: "MEMORY_CONFLICT" }, 409);
  }
  if (error instanceof InvalidCandidateRequestError) {
    return context.json({ ok: false, error: "Invalid Memory request", code: "INVALID_MEMORY_REQUEST" }, 400);
  }
  if (error instanceof MemoryContractError && error.path === "id") {
    return context.json({ ok: false, error: "Memory candidate not found", code: "MEMORY_CANDIDATE_NOT_FOUND" }, 404);
  }
  if (error instanceof MemoryContractError) {
    return context.json({ ok: false, error: "Invalid Memory request", code: "INVALID_MEMORY_REQUEST" }, 400);
  }
  return context.json({ ok: false, error: "Memory operation failed", code: "MEMORY_OPERATION_FAILED" }, 500);
}
