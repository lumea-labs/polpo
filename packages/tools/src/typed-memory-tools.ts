import { Type } from "@sinclair/typebox";
import { nanoid } from "nanoid";
import {
  MEMORY_KINDS,
  MemoryConflictError,
  createMemoryItem,
  normalizeMemoryScope,
  type MemoryItem,
  type MemoryItemPatch,
  type MemoryItemStore,
  type MemoryKind,
  type MemoryProvenance,
  type MemoryScope,
  type MemoryScopeKind,
  type MemoryStoreContext,
  type MemoryUsageEvent,
  type MemoryUsageEventType,
  type PolpoTool,
} from "@polpo-ai/core";
import type { MemoryToolOperationCoordinator } from "./memory-tool-operations.js";

export const ALL_TYPED_MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_remember",
  "memory_update_item",
  "memory_forget",
] as const;

export type TypedMemoryToolName =
  (typeof ALL_TYPED_MEMORY_TOOL_NAMES)[number];

export interface TypedMemoryToolGrants {
  readonly search?: boolean;
  readonly remember?: boolean;
  readonly update?: boolean;
  readonly forget?: boolean;
  /** Required to execute remember/update/forget. Missing means fail closed. */
  readonly writableScopeKinds?: readonly MemoryScopeKind[];
  /** Required to execute remember/update/forget. Missing means fail closed. */
  readonly writableKinds?: readonly MemoryKind[];
}

export interface CreateTypedMemoryToolsOptions {
  readonly agentName: string;
  readonly context: MemoryStoreContext;
  readonly grants: TypedMemoryToolGrants;
  /** Fixed by the host; the model cannot choose a broader write scope. */
  readonly writeScope?: MemoryScope;
  /** Fixed by the host; the model cannot claim trusted provenance. */
  readonly provenance?: MemoryProvenance;
  readonly createId?: () => string;
  readonly createUsageId?: () => string;
  readonly now?: () => Date | string;
  /** Usage telemetry is best-effort and must not change tool semantics. */
  readonly onUsageError?: (
    error: unknown,
    event: MemoryUsageEvent,
  ) => void | Promise<void>;
  /** Host-owned idempotency boundary for stable tool-call retries. */
  readonly operationCoordinator?: MemoryToolOperationCoordinator;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function runOperation<T>(
  options: CreateTypedMemoryToolsOptions,
  toolName: TypedMemoryToolName,
  toolCallId: string,
  params: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  if (!options.operationCoordinator) return execute();
  const runId = options.provenance?.runId;
  if (!runId) return execute();
  return options.operationCoordinator.run({
    key: `${runId}:${options.agentName}:${toolName}:${toolCallId}`,
    fingerprint: canonicalJson(params),
  }, execute);
}

const memoryKindSchema = Type.Union(
  MEMORY_KINDS.map((kind) => Type.Literal(kind)),
);

const MemorySearchSchema = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: "What to recall from authorized typed Memory.",
  }),
  kinds: Type.Optional(Type.Array(memoryKindSchema, {
    maxItems: MEMORY_KINDS.length,
  })),
  token_budget: Type.Optional(Type.Integer({ minimum: 0, maximum: 32_000 })),
  max_results: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
});

const MemoryRememberSchema = Type.Object({
  kind: memoryKindSchema,
  content: Type.String({
    minLength: 1,
    maxLength: 32_000,
    description: "The durable fact, preference, or episode to remember.",
  }),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  expires_at: Type.Optional(Type.String({
    description: "Optional ISO-8601 expiry timestamp.",
  })),
  pending: Type.Optional(Type.Boolean({
    description: "Store as pending instead of active.",
  })),
});

const MemoryUpdateSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  content: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000 })),
  summary: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 2_000 }),
    Type.Null(),
  ])),
  confidence: Type.Optional(Type.Union([
    Type.Number({ minimum: 0, maximum: 1 }),
    Type.Null(),
  ])),
  expires_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const MemoryForgetSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
});

function operationTime(options: CreateTypedMemoryToolsOptions): string {
  const value = options.now?.() ?? options.context.now ?? new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Memory operation time must be valid");
  }
  return parsed.toISOString();
}

async function appendUsage(
  store: MemoryItemStore,
  options: CreateTypedMemoryToolsOptions,
  memoryId: string,
  type: MemoryUsageEventType,
  requestId: string,
): Promise<void> {
  const event: MemoryUsageEvent = {
    id: options.createUsageId?.() ?? `memory-usage-${nanoid(16)}`,
    memoryId,
    type,
    at: operationTime(options),
    ...(options.provenance?.runId
      ? { runId: options.provenance.runId }
      : {}),
    ...(options.provenance?.sessionId
      ? { sessionId: options.provenance.sessionId }
      : {}),
    requestId,
  };
  try {
    await store.appendUsage(event, options.context);
  } catch (error) {
    try {
      await options.onUsageError?.(error, event);
    } catch {
      // Usage telemetry cannot change the completed Memory operation.
    }
  }
}

function assertWriteGrant(
  options: CreateTypedMemoryToolsOptions,
  item: Pick<MemoryItem, "scope" | "kind">,
): void {
  const scopes = options.grants.writableScopeKinds;
  const kinds = options.grants.writableKinds;
  if (!scopes?.includes(item.scope.kind) || !kinds?.includes(item.kind)) {
    throw new Error("Memory write is not granted for this scope and kind");
  }
}

async function getWritableItem(
  store: MemoryItemStore,
  options: CreateTypedMemoryToolsOptions,
  id: string,
): Promise<MemoryItem> {
  const item = await store.get(id, options.context, {
    includeInactive: true,
    includeExpired: true,
  });
  if (!item) throw new Error("Memory item not found");
  assertWriteGrant(options, item);
  return item;
}

function resultText(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Creates typed Memory tools for one already-authorized invocation.
 *
 * No tool is returned unless its action is explicitly granted. Write scope and
 * provenance are host-owned closure values, never model-controlled arguments.
 */
export function createTypedMemoryTools(
  store: MemoryItemStore,
  value: CreateTypedMemoryToolsOptions,
): PolpoTool<any>[] {
  const hasWriteAction = Boolean(
    value.grants.remember
    || value.grants.update
    || value.grants.forget,
  );
  if (
    hasWriteAction
    && (
      !value.grants.writableScopeKinds?.length
      || !value.grants.writableKinds?.length
    )
  ) {
    throw new Error(
      "Memory write grants require writable scope kinds and Memory kinds",
    );
  }
  if (value.grants.remember && !value.writeScope) {
    throw new Error("Memory remember grant requires a host-fixed write scope");
  }
  const options: CreateTypedMemoryToolsOptions = {
    ...value,
    context: {
      ...value.context,
      access: { ...value.context.access },
    },
    ...(value.writeScope
      ? { writeScope: normalizeMemoryScope(value.writeScope) }
      : {}),
    provenance: {
      source: "tool",
      actor: "agent",
      toolName: "memory_remember",
      ...(value.provenance ?? {}),
    },
  };
  if (options.context.access.agentName !== options.agentName) {
    throw new Error("Memory tool context does not match the agent");
  }

  const tools: PolpoTool<any>[] = [];

  if (options.grants.search) {
    const search: PolpoTool<typeof MemorySearchSchema> = {
      name: "memory_search",
      label: "Search Memory",
      description:
        "Search only the typed Memory authorized for this agent and user context.",
      parameters: MemorySearchSchema,
      async execute(toolCallId, params) {
        return runOperation(
          options,
          "memory_search",
          toolCallId,
          params,
          async () => {
            const results = await store.search({
              query: params.query,
              kinds: params.kinds,
              tokenBudget: params.token_budget,
              maxResults: params.max_results,
            }, options.context);
            for (const result of results) {
              await appendUsage(
                store,
                options,
                result.item.id,
                "retrieved",
                toolCallId,
              );
            }
            const data = { total: results.length, results };
            return {
              content: [{ type: "text", text: resultText(data) }],
              details: data,
            };
          },
        );
      },
    };
    tools.push(search);
  }

  if (options.grants.remember) {
    const remember: PolpoTool<typeof MemoryRememberSchema> = {
      name: "memory_remember",
      label: "Remember",
      description:
        "Store one durable typed Memory item in the host-authorized scope.",
      parameters: MemoryRememberSchema,
      async execute(toolCallId, params) {
        return runOperation(
          options,
          "memory_remember",
          toolCallId,
          params,
          async () => {
            if (!options.writeScope) {
              throw new Error("Memory write scope is not configured");
            }
            assertWriteGrant(options, {
              scope: options.writeScope,
              kind: params.kind,
            });
            const item = createMemoryItem({
              scope: options.writeScope,
              kind: params.kind,
              content: params.content,
              summary: params.summary,
              provenance: options.provenance!,
              confidence: params.confidence,
              status: params.pending ? "pending" : "active",
              expiresAt: params.expires_at,
            }, {
              createId: options.createId,
              now: options.now,
            });
            const duplicate = await store.findDedupeCandidate(
              item,
              options.context,
            );
            if (duplicate) {
              throw new MemoryConflictError(
                "An equivalent Memory item already exists",
              );
            }
            const created = await store.create(item, options.context);
            await appendUsage(
              store,
              options,
              created.id,
              "written",
              toolCallId,
            );
            return {
              content: [{
                type: "text",
                text: resultText({ remembered: true, item: created }),
              }],
              details: { remembered: true, item: created },
            };
          },
        );
      },
    };
    tools.push(remember);
  }

  if (options.grants.update) {
    const update: PolpoTool<typeof MemoryUpdateSchema> = {
      name: "memory_update_item",
      label: "Update Memory",
      description:
        "Update one existing typed Memory item when the host grants its scope and kind.",
      parameters: MemoryUpdateSchema,
      async execute(toolCallId, params) {
        return runOperation(
          options,
          "memory_update_item",
          toolCallId,
          params,
          async () => {
            await getWritableItem(store, options, params.id);
            const patch: MemoryItemPatch = {
              ...(params.content === undefined ? {} : { content: params.content }),
              ...(params.summary === undefined ? {} : { summary: params.summary }),
              ...(params.confidence === undefined
                ? {}
                : { confidence: params.confidence }),
              ...(params.expires_at === undefined
                ? {}
                : { expiresAt: params.expires_at }),
            };
            if (Object.keys(patch).length === 0) {
              throw new Error("Memory update requires at least one field");
            }
            const item = await store.update(params.id, patch, options.context);
            if (!item) throw new Error("Memory item not found");
            await appendUsage(
              store,
              options,
              item.id,
              "updated",
              toolCallId,
            );
            return {
              content: [{
                type: "text",
                text: resultText({ updated: true, item }),
              }],
              details: { updated: true, item },
            };
          },
        );
      },
    };
    tools.push(update);
  }

  if (options.grants.forget) {
    const forget: PolpoTool<typeof MemoryForgetSchema> = {
      name: "memory_forget",
      label: "Forget Memory",
      description:
        "Soft-delete one typed Memory item when the host grants its scope and kind.",
      parameters: MemoryForgetSchema,
      async execute(toolCallId, params) {
        return runOperation(
          options,
          "memory_forget",
          toolCallId,
          params,
          async () => {
            await getWritableItem(store, options, params.id);
            const forgotten = await store.forget(params.id, options.context);
            if (!forgotten) throw new Error("Memory item not found");
            await appendUsage(
              store,
              options,
              params.id,
              "forgotten",
              toolCallId,
            );
            return {
              content: [{
                type: "text",
                text: resultText({ forgotten: true, itemId: params.id }),
              }],
              details: { forgotten: true, itemId: params.id },
            };
          },
        );
      },
    };
    tools.push(forget);
  }

  return tools;
}
