import { Hono, type Context } from "hono";
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  MemoryAuthorizationError,
  MemoryConflictError,
  MemoryContractError,
  MemoryPolicyError,
  createMemoryItem,
  normalizeMemoryScope,
  type CreateMemoryItemInput,
  type MemoryItemPatch,
  type MemoryItemStore,
  type MemoryKind,
  type MemoryListCursor,
  type MemoryListPageQuery,
  type MemoryListQuery,
  type MemorySearchQuery,
  type MemoryStatus,
  type MemoryStoreContext,
  type MemoryUsageEvent,
  type MemoryUsageEventType,
} from "@polpo-ai/core";
import { nanoid } from "nanoid";
import type { MemoryRouteDeps } from "../deps.js";

export type { MemoryRouteDeps } from "../deps.js";

class InvalidMemoryRequestError extends Error {
  constructor(message = "Invalid Memory request") {
    super(message);
    this.name = "InvalidMemoryRequestError";
  }
}

const memoryKinds = new Set<string>(MEMORY_KINDS);
const memoryStatuses = new Set<string>(MEMORY_STATUSES);
const createKeys = new Set([
  "id",
  "scope",
  "kind",
  "content",
  "summary",
  "provenance",
  "confidence",
  "status",
  "expiresAt",
]);
const patchKeys = new Set([
  "content",
  "summary",
  "confidence",
  "status",
  "expiresAt",
]);
const listQueryKeys = new Set([
  "kinds",
  "statuses",
  "scopeKind",
  "scopeSubjectId",
  "scopeAgentName",
  "includeExpired",
  "limit",
  "cursor",
]);
const searchKeys = new Set([
  "query",
  "kinds",
  "scope",
  "tokenBudget",
  "maxResults",
]);

function object(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidMemoryRequestError();
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new InvalidMemoryRequestError(`Unknown Memory field: ${key}`);
    }
  }
  return record;
}

async function jsonObject(
  context: Context,
  allowedKeys: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const value = await context.req.json().catch(() => {
    throw new InvalidMemoryRequestError();
  });
  return object(value, allowedKeys);
}

function agentName(context: Context): string {
  const value = context.req.param("agentName").trim();
  if (value.length === 0 || value.length > 128) {
    throw new InvalidMemoryRequestError("Invalid agent name");
  }
  return value;
}

function commaList(
  value: string | undefined,
  allowed: ReadonlySet<string>,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",").map((entry) => entry.trim());
  if (
    values.length === 0
    || values.some((entry) => entry.length === 0 || !allowed.has(entry))
  ) {
    throw new InvalidMemoryRequestError(`Invalid ${field}`);
  }
  return [...new Set(values)];
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidMemoryRequestError("Invalid boolean query value");
}

function optionalInteger(
  value: string | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new InvalidMemoryRequestError(`Invalid ${field}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidMemoryRequestError(`Invalid ${field}`);
  }
  return parsed;
}

interface ParsedMemoryListQuery {
  readonly query: MemoryListQuery;
  readonly cursor?: string;
  readonly filterSignature: string;
}

function listFilterSignature(
  agent: string,
  query: MemoryListQuery,
): string {
  return JSON.stringify({
    agent,
    kinds: query.kinds ? [...query.kinds].sort() : null,
    statuses: query.statuses ? [...query.statuses].sort() : null,
    scope: query.scope
      ? {
          kind: query.scope.kind,
          subjectId: query.scope.subjectId ?? null,
          agentName: query.scope.agentName ?? null,
        }
      : null,
    includeExpired: query.includeExpired === true,
  });
}

function parseListQuery(
  context: Context,
  agent: string,
): ParsedMemoryListQuery {
  const url = new URL(context.req.url);
  for (const key of url.searchParams.keys()) {
    if (!listQueryKeys.has(key)) {
      throw new InvalidMemoryRequestError(`Unknown Memory query field: ${key}`);
    }
  }
  const get = (name: string) => url.searchParams.get(name) ?? undefined;
  const scopeKind = get("scopeKind");
  const scopeSubjectId = get("scopeSubjectId");
  const scopeAgentName = get("scopeAgentName");
  if (!scopeKind && (scopeSubjectId || scopeAgentName)) {
    throw new InvalidMemoryRequestError("scopeKind is required for scope filters");
  }
  const scope = scopeKind
    ? normalizeMemoryScope({
      kind: scopeKind,
      ...(scopeSubjectId ? { subjectId: scopeSubjectId } : {}),
      ...(scopeAgentName ? { agentName: scopeAgentName } : {}),
    })
    : undefined;
  const query: MemoryListQuery = {
    kinds: commaList(get("kinds"), memoryKinds, "kinds") as MemoryKind[] | undefined,
    statuses: commaList(
      get("statuses"),
      memoryStatuses,
      "statuses",
    ) as MemoryStatus[] | undefined,
    ...(scope ? { scope } : {}),
    includeExpired: optionalBoolean(get("includeExpired")),
    limit: optionalInteger(get("limit"), "limit"),
  };
  const cursor = url.searchParams.has("cursor")
    ? url.searchParams.get("cursor") ?? ""
    : undefined;
  if (cursor !== undefined && cursor.length === 0) {
    throw new InvalidMemoryRequestError("Invalid Memory cursor");
  }
  return {
    query,
    ...(cursor === undefined ? {} : { cursor }),
    filterSignature: listFilterSignature(agent, query),
  };
}

const MEMORY_CURSOR_PREFIX = "m1.";
const MAX_MEMORY_CURSOR_CHARACTERS = 4_096;

interface EncodedMemoryCursor {
  readonly v: 1;
  readonly at: string;
  readonly id: string;
  readonly filter: string;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new InvalidMemoryRequestError("Invalid Memory cursor");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (base64UrlEncode(decoded) !== value) {
      throw new InvalidMemoryRequestError("Invalid Memory cursor");
    }
    return decoded;
  } catch (error) {
    if (error instanceof InvalidMemoryRequestError) throw error;
    throw new InvalidMemoryRequestError("Invalid Memory cursor");
  }
}

function decodeMemoryCursor(
  value: string,
  filterSignature: string,
): MemoryListCursor {
  if (
    value.length > MAX_MEMORY_CURSOR_CHARACTERS
    || !value.startsWith(MEMORY_CURSOR_PREFIX)
  ) {
    throw new InvalidMemoryRequestError("Invalid Memory cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(value.slice(MEMORY_CURSOR_PREFIX.length)));
  } catch (error) {
    if (error instanceof InvalidMemoryRequestError) throw error;
    throw new InvalidMemoryRequestError("Invalid Memory cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidMemoryRequestError("Invalid Memory cursor");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(",") !== "at,filter,id,v"
    || record.v !== 1
    || typeof record.at !== "string"
    || typeof record.id !== "string"
    || typeof record.filter !== "string"
    || record.filter !== filterSignature
    || record.id.length === 0
    || record.id.length > 256
    || record.id.trim() !== record.id
  ) {
    throw new InvalidMemoryRequestError("Invalid Memory cursor");
  }
  const at = new Date(record.at);
  if (!Number.isFinite(at.getTime()) || at.toISOString() !== record.at) {
    throw new InvalidMemoryRequestError("Invalid Memory cursor");
  }
  return Object.freeze({ createdAt: record.at, id: record.id });
}

function encodeMemoryCursor(
  value: MemoryListCursor,
  filterSignature: string,
): string {
  const at = new Date(value.createdAt);
  if (
    !Number.isFinite(at.getTime())
    || at.toISOString() !== value.createdAt
    || typeof value.id !== "string"
    || value.id.length === 0
    || value.id.length > 256
    || value.id.trim() !== value.id
  ) {
    throw new Error("Memory store returned an invalid pagination cursor");
  }
  const payload: EncodedMemoryCursor = {
    v: 1,
    at: value.createdAt,
    id: value.id,
    filter: filterSignature,
  };
  return `${MEMORY_CURSOR_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`;
}

function parseSearchQuery(value: unknown): MemorySearchQuery {
  const input = object(value, searchKeys);
  if (typeof input.query !== "string") {
    throw new InvalidMemoryRequestError("Memory search query must be a string");
  }
  if (
    input.kinds !== undefined
    && (
      !Array.isArray(input.kinds)
      || input.kinds.some(
        (kind) => typeof kind !== "string" || !memoryKinds.has(kind),
      )
    )
  ) {
    throw new InvalidMemoryRequestError("Invalid Memory kinds");
  }
  return {
    query: input.query,
    ...(input.kinds === undefined
      ? {}
      : { kinds: input.kinds as readonly MemoryKind[] }),
    ...(input.scope === undefined
      ? {}
      : { scope: normalizeMemoryScope(input.scope) }),
    ...(input.tokenBudget === undefined
      ? {}
      : { tokenBudget: input.tokenBudget as number }),
    ...(input.maxResults === undefined
      ? {}
      : { maxResults: input.maxResults as number }),
  };
}

function parsePatch(value: unknown): MemoryItemPatch {
  const input = object(value, patchKeys);
  if (Object.keys(input).length === 0) {
    throw new InvalidMemoryRequestError("Memory patch cannot be empty");
  }
  return input as MemoryItemPatch;
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new MemoryContractError("Memory operation time must be valid");
  }
  return parsed.toISOString();
}

async function appendUsage(
  deps: MemoryRouteDeps,
  store: MemoryItemStore,
  context: MemoryStoreContext,
  memoryId: string,
  type: MemoryUsageEventType,
): Promise<void> {
  const event: MemoryUsageEvent = {
    id: deps.createUsageId?.() ?? `memory-usage-${nanoid(16)}`,
    memoryId,
    type,
    at: timestamp(deps.now?.() ?? context.now ?? new Date()),
  };
  try {
    await store.appendUsage(event, context);
  } catch (error) {
    try {
      await deps.onUsageError?.(error, event);
    } catch {
      // Usage telemetry cannot change the completed Memory operation.
    }
  }
}

function invalidResponse(context: Context): Response {
  return context.json({
    ok: false,
    error: "Invalid Memory request",
    code: "INVALID_MEMORY_REQUEST",
  }, 400);
}

function errorResponse(context: Context, error: unknown): Response {
  if (error instanceof MemoryAuthorizationError) {
    return context.json({
      ok: false,
      error: "Memory access denied",
      code: "MEMORY_FORBIDDEN",
    }, 403);
  }
  if (error instanceof MemoryConflictError) {
    const equivalent = error.message.startsWith("An equivalent Memory item");
    return context.json({
      ok: false,
      error: equivalent
        ? "An equivalent Memory item already exists"
        : "Memory conflict",
      code: "MEMORY_CONFLICT",
    }, 409);
  }
  if (error instanceof MemoryPolicyError) {
    return context.json({
      ok: false,
      error: "Memory write denied by policy",
      code: "MEMORY_POLICY_DENIED",
    }, 422);
  }
  if (
    error instanceof MemoryContractError
    || error instanceof InvalidMemoryRequestError
  ) {
    return invalidResponse(context);
  }
  return context.json({
    ok: false,
    error: "Memory operation failed",
    code: "MEMORY_OPERATION_FAILED",
  }, 500);
}

async function resolve(
  context: Context,
  getDeps: (requestContext: unknown) => MemoryRouteDeps,
): Promise<{
  deps: MemoryRouteDeps;
  store: MemoryItemStore;
  memoryContext: MemoryStoreContext;
  agent: string;
} | Response> {
  try {
    const agent = agentName(context);
    const deps = getDeps(context);
    if (!deps.memoryItemStore || typeof deps.resolveMemoryContext !== "function") {
      return context.json({
        ok: false,
        error: "Typed Memory is not available",
        code: "MEMORY_UNAVAILABLE",
      }, 503);
    }
    const memoryContext = await deps.resolveMemoryContext(agent, context);
    if (memoryContext.access.agentName !== agent) {
      throw new MemoryAuthorizationError();
    }
    return {
      deps,
      store: deps.memoryItemStore,
      memoryContext,
      agent,
    };
  } catch (error) {
    return errorResponse(context, error);
  }
}

/**
 * Host-neutral typed Memory API. Authentication and tenant/external-user
 * scoping are supplied by the composition root through `resolveMemoryContext`.
 */
export function memoryItemRoutes(
  getDeps: (requestContext: unknown) => MemoryRouteDeps,
): Hono {
  const app = new Hono();

  app.get("/agents/:agentName/memory/items", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      const parsed = parseListQuery(context, resolved.agent);
      if (parsed.cursor !== undefined && !resolved.store.listPage) {
        return context.json({
          ok: false,
          error: "Memory pagination is not available",
          code: "MEMORY_PAGINATION_UNAVAILABLE",
        }, 503);
      }
      if (!resolved.store.listPage) {
        const items = await resolved.store.list(
          parsed.query,
          resolved.memoryContext,
        );
        return context.json({
          ok: true,
          data: { items, nextCursor: null },
        }, 200);
      }
      const pageQuery: MemoryListPageQuery = {
        ...parsed.query,
        ...(parsed.cursor === undefined
          ? {}
          : {
              after: decodeMemoryCursor(
                parsed.cursor,
                parsed.filterSignature,
              ),
            }),
      };
      const page = await resolved.store.listPage(
        pageQuery,
        resolved.memoryContext,
      );
      const nextCursor = page.nextCursor
        ? encodeMemoryCursor(page.nextCursor, parsed.filterSignature)
        : null;
      return context.json({
        ok: true,
        data: { items: page.items, nextCursor },
      }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post("/agents/:agentName/memory/items", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      const input = await jsonObject(context, createKeys);
      const item = createMemoryItem(input as unknown as CreateMemoryItemInput, {
        createId: resolved.deps.createId,
        now: resolved.deps.now,
      });
      const duplicate = await resolved.store.findDedupeCandidate(
        item,
        resolved.memoryContext,
      );
      if (duplicate) {
        throw new MemoryConflictError(
          "An equivalent Memory item already exists",
        );
      }
      const created = await resolved.store.create(item, resolved.memoryContext);
      await appendUsage(
        resolved.deps,
        resolved.store,
        resolved.memoryContext,
        created.id,
        "written",
      );
      return context.json({ ok: true, data: { item: created } }, 201);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post("/agents/:agentName/memory/search", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      const input = await jsonObject(context, searchKeys);
      const results = await resolved.store.search(
        parseSearchQuery(input),
        resolved.memoryContext,
      );
      for (const result of results) {
        await appendUsage(
          resolved.deps,
          resolved.store,
          resolved.memoryContext,
          result.item.id,
          "retrieved",
        );
      }
      return context.json({ ok: true, data: { results } }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.patch("/agents/:agentName/memory/items/:itemId", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      const itemId = context.req.param("itemId");
      const patch = parsePatch(await jsonObject(context, patchKeys));
      const item = await resolved.store.update(
        itemId,
        patch,
        resolved.memoryContext,
      );
      if (!item) {
        return context.json({
          ok: false,
          error: "Memory item not found",
          code: "MEMORY_NOT_FOUND",
        }, 404);
      }
      await appendUsage(
        resolved.deps,
        resolved.store,
        resolved.memoryContext,
        item.id,
        "updated",
      );
      return context.json({ ok: true, data: { item } }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.delete("/agents/:agentName/memory/items/:itemId", async (context) => {
    const resolved = await resolve(context, getDeps);
    if (resolved instanceof Response) return resolved;
    try {
      const itemId = context.req.param("itemId");
      const forgotten = await resolved.store.forget(
        itemId,
        resolved.memoryContext,
      );
      if (!forgotten) {
        return context.json({
          ok: false,
          error: "Memory item not found",
          code: "MEMORY_NOT_FOUND",
        }, 404);
      }
      await appendUsage(
        resolved.deps,
        resolved.store,
        resolved.memoryContext,
        itemId,
        "forgotten",
      );
      return context.json({
        ok: true,
        data: { forgotten: true, itemId },
      }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return app;
}
