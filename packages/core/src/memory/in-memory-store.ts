import { MemoryContractError } from "./errors.js";
import { createMemoryDedupeIdentity } from "./dedupe.js";
import { normalizeMemoryItem } from "./item.js";
import {
  assertMemoryStatusTransition,
  isMemoryItemExpired,
  isMemoryItemRetrievable,
} from "./lifecycle.js";
import { evaluateMemoryWrite, type MemoryWritePolicy } from "./policy.js";
import { rankMemoryItems, selectMemoryResultsWithinBudget } from "./ranking.js";
import {
  canAccessMemoryScope,
  memoryScopeKey,
  normalizeMemoryScope,
} from "./scope.js";
import {
  MemoryAuthorizationError,
  MemoryConflictError,
  MemoryPolicyError,
} from "./store-errors.js";
import type {
  MemoryGetOptions,
  MemoryItemPatch,
  MemoryItemStore,
  MemoryItemStoreSnapshot,
  MemoryListQuery,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryStoreContext,
  MemoryStoreSnapshotNamespace,
  MemorySupersedeResult,
  MemoryUsageEvent,
  MemoryUsageEventType,
} from "./store-types.js";
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type MemoryDedupeInput,
  type MemoryItem,
  type MemoryKind,
  type MemoryStatus,
} from "./types.js";

interface NamespaceState {
  readonly items: Map<string, MemoryItem>;
  readonly usage: MemoryUsageEvent[];
}

const memoryKinds = new Set<string>(MEMORY_KINDS);
const memoryStatuses = new Set<string>(MEMORY_STATUSES);
const usageTypes = new Set<MemoryUsageEventType>([
  "retrieved",
  "written",
  "updated",
  "superseded",
  "forgotten",
]);

function text(value: unknown, path: string, max = 512): string {
  if (typeof value !== "string") {
    throw new MemoryContractError(`${path} must be a string`, "invalid_item", path);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new MemoryContractError(
      `${path} must contain between 1 and ${max} characters`,
      "invalid_item",
      path,
    );
  }
  return normalized;
}

function timestamp(value: unknown, path: string): string {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new MemoryContractError(`${path} must be a timestamp`, "invalid_item", path);
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new MemoryContractError(`${path} must be a timestamp`, "invalid_item", path);
  }
  return parsed.toISOString();
}

function normalizeContext(context: MemoryStoreContext): MemoryStoreContext {
  if (!context || typeof context !== "object") {
    throw new MemoryContractError("Memory store context is required");
  }
  if (
    !context.access
    || typeof context.access !== "object"
    || Array.isArray(context.access)
  ) {
    throw new MemoryContractError(
      "Memory store access context is required",
      "invalid_scope",
      "access",
    );
  }
  return {
    ...context,
    namespace: text(context.namespace, "namespace"),
    access: { ...context.access },
    ...(context.now ? { now: timestamp(context.now, "now") } : {}),
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new MemoryContractError(
      "Memory list limit must be an integer between 0 and 10000",
      "invalid_item",
      "limit",
    );
  }
  return value;
}

function normalizeUsageEvent(value: MemoryUsageEvent): MemoryUsageEvent {
  if (!value || typeof value !== "object" || !usageTypes.has(value.type)) {
    throw new MemoryContractError("Invalid Memory usage event");
  }
  return Object.freeze({
    id: text(value.id, "usage.id", 256),
    memoryId: text(value.memoryId, "usage.memoryId", 256),
    type: value.type,
    at: timestamp(value.at, "usage.at"),
    ...(value.runId ? { runId: text(value.runId, "usage.runId") } : {}),
    ...(value.sessionId
      ? { sessionId: text(value.sessionId, "usage.sessionId") }
      : {}),
    ...(value.requestId
      ? { requestId: text(value.requestId, "usage.requestId") }
      : {}),
  });
}

function cloneItem(item: MemoryItem): MemoryItem {
  return normalizeMemoryItem(JSON.parse(JSON.stringify(item)));
}

function cloneUsage(event: MemoryUsageEvent): MemoryUsageEvent {
  return normalizeUsageEvent(JSON.parse(JSON.stringify(event)));
}

export class InMemoryMemoryItemStore implements MemoryItemStore {
  private readonly namespaces = new Map<string, NamespaceState>();

  constructor(
    private readonly writePolicy: MemoryWritePolicy = {},
    snapshot?: MemoryItemStoreSnapshot,
  ) {
    if (snapshot) this.replaceSnapshot(snapshot);
  }

  private state(namespace: string): NamespaceState {
    let state = this.namespaces.get(namespace);
    if (!state) {
      state = { items: new Map(), usage: [] };
      this.namespaces.set(namespace, state);
    }
    return state;
  }

  private existing(
    id: string,
    context: MemoryStoreContext,
  ): MemoryItem | undefined {
    const normalized = normalizeContext(context);
    const item = this.namespaces.get(normalized.namespace)?.items.get(
      text(id, "id", 256),
    );
    if (!item || !canAccessMemoryScope(item.scope, normalized.access)) {
      return undefined;
    }
    return item;
  }

  private async assertWriteAllowed(
    item: MemoryItem,
    context: MemoryStoreContext,
  ): Promise<void> {
    const decision = await evaluateMemoryWrite(item, context, this.writePolicy);
    const unauthorized = decision.violations.some(
      (violation) => violation.code === "unauthorized_scope",
    );
    if (unauthorized) throw new MemoryAuthorizationError();
    if (!decision.allowed) {
      throw new MemoryPolicyError(
        `Memory write denied: ${decision.violations
          .map((violation) => violation.code)
          .join(", ")}`,
      );
    }
  }

  async create(
    value: MemoryItem,
    context: MemoryStoreContext,
  ): Promise<MemoryItem> {
    const normalizedContext = normalizeContext(context);
    const item = cloneItem(value);
    if (item.status !== "active" && item.status !== "pending") {
      throw new MemoryContractError(
        "New Memory items may only be active or pending",
        "invalid_item",
        "status",
      );
    }
    await this.assertWriteAllowed(item, normalizedContext);
    const state = this.state(normalizedContext.namespace);
    if (state.items.has(item.id)) {
      throw new MemoryConflictError(
        `Memory item "${item.id}" already exists in this namespace`,
      );
    }
    state.items.set(item.id, item);
    return cloneItem(item);
  }

  async get(
    id: string,
    context: MemoryStoreContext,
    options: MemoryGetOptions = {},
  ): Promise<MemoryItem | undefined> {
    const item = this.existing(id, context);
    if (!item) return undefined;
    const now = options.now ?? context.now ?? new Date();
    if (!options.includeInactive && item.status !== "active") return undefined;
    if (!options.includeExpired && isMemoryItemExpired(item, now)) return undefined;
    return cloneItem(item);
  }

  async list(
    query: MemoryListQuery,
    context: MemoryStoreContext,
  ): Promise<MemoryItem[]> {
    const normalized = normalizeContext(context);
    const state = this.namespaces.get(normalized.namespace);
    if (!state) return [];
    const statuses = query.statuses ?? ["active"];
    for (const status of statuses) {
      if (!memoryStatuses.has(status)) {
        throw new MemoryContractError(`Unknown Memory status: ${status}`);
      }
    }
    const kinds = query.kinds;
    if (kinds) {
      for (const kind of kinds) {
        if (!memoryKinds.has(kind)) {
          throw new MemoryContractError(`Unknown Memory kind: ${kind}`);
        }
      }
    }
    const scopeKey = query.scope
      ? memoryScopeKey(normalizeMemoryScope(query.scope))
      : undefined;
    const now = query.now ?? normalized.now ?? new Date();
    const limit = normalizeLimit(query.limit);

    return [...state.items.values()]
      .filter((item) => canAccessMemoryScope(item.scope, normalized.access))
      .filter((item) => statuses.includes(item.status))
      .filter((item) => !kinds || kinds.includes(item.kind))
      .filter((item) => !scopeKey || memoryScopeKey(item.scope) === scopeKey)
      .filter((item) => query.includeExpired || !isMemoryItemExpired(item, now))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, limit)
      .map(cloneItem);
  }

  async update(
    id: string,
    patch: MemoryItemPatch,
    context: MemoryStoreContext,
  ): Promise<MemoryItem | undefined> {
    const normalized = normalizeContext(context);
    const current = this.existing(id, normalized);
    if (!current) return undefined;
    const status = patch.status ?? current.status;
    assertMemoryStatusTransition(current.status, status);
    const candidate = normalizeMemoryItem({
      ...current,
      ...(patch.content === undefined ? {} : { content: patch.content }),
      ...(patch.summary === undefined
        ? {}
        : patch.summary === null
          ? { summary: undefined }
          : { summary: patch.summary }),
      ...(patch.confidence === undefined
        ? {}
        : patch.confidence === null
          ? { confidence: undefined }
          : { confidence: patch.confidence }),
      ...(patch.expiresAt === undefined
        ? {}
        : patch.expiresAt === null
          ? { expiresAt: undefined }
          : { expiresAt: patch.expiresAt }),
      status,
      updatedAt: timestamp(normalized.now ?? new Date(), "now"),
    });
    await this.assertWriteAllowed(candidate, normalized);
    const state = this.state(normalized.namespace);
    if (state.items.get(current.id) !== current) {
      throw new MemoryConflictError(
        `Memory item "${current.id}" changed during update`,
      );
    }
    state.items.set(candidate.id, candidate);
    return cloneItem(candidate);
  }

  async supersede(
    id: string,
    replacementValue: MemoryItem,
    context: MemoryStoreContext,
  ): Promise<MemorySupersedeResult | undefined> {
    const normalized = normalizeContext(context);
    const current = this.existing(id, normalized);
    if (!current) return undefined;
    assertMemoryStatusTransition(current.status, "superseded");
    const replacement = cloneItem(replacementValue);
    if (replacement.status !== "active") {
      throw new MemoryContractError(
        "A superseding Memory replacement must be active",
        "invalid_item",
        "status",
      );
    }
    if (replacement.id === current.id) {
      throw new MemoryConflictError("Replacement Memory id must be different");
    }
    const state = this.state(normalized.namespace);
    if (state.items.has(replacement.id)) {
      throw new MemoryConflictError(
        `Memory item "${replacement.id}" already exists in this namespace`,
      );
    }
    await this.assertWriteAllowed(replacement, normalized);
    if (state.items.get(current.id) !== current) {
      throw new MemoryConflictError(
        `Memory item "${current.id}" changed during supersede`,
      );
    }
    if (state.items.has(replacement.id)) {
      throw new MemoryConflictError(
        `Memory item "${replacement.id}" was created during supersede`,
      );
    }
    const updatedAt = timestamp(normalized.now ?? new Date(), "now");
    const superseded = normalizeMemoryItem({
      ...current,
      status: "superseded",
      updatedAt,
    });
    state.items.set(current.id, superseded);
    state.items.set(replacement.id, replacement);
    return {
      superseded: cloneItem(superseded),
      replacement: cloneItem(replacement),
    };
  }

  async forget(id: string, context: MemoryStoreContext): Promise<boolean> {
    const normalized = normalizeContext(context);
    const current = this.existing(id, normalized);
    if (!current) return false;
    assertMemoryStatusTransition(current.status, "deleted");
    const deleted = normalizeMemoryItem({
      ...current,
      status: "deleted",
      updatedAt: timestamp(normalized.now ?? new Date(), "now"),
    });
    this.state(normalized.namespace).items.set(deleted.id, deleted);
    return true;
  }

  async search(
    query: MemorySearchQuery,
    context: MemoryStoreContext,
  ): Promise<MemorySearchResult[]> {
    const candidates = await this.list({
      statuses: ["active"],
      kinds: query.kinds,
      scope: query.scope,
      now: query.now,
      limit: 10_000,
    }, context);
    const ranked = rankMemoryItems(
      candidates.filter((item) => isMemoryItemRetrievable(
        item,
        query.now ?? context.now ?? new Date(),
      )),
      query.query,
    );
    return selectMemoryResultsWithinBudget(ranked, {
      tokenBudget: query.tokenBudget ?? Number.MAX_SAFE_INTEGER,
      maxResults: query.maxResults ?? 20,
    });
  }

  async findDedupeCandidate(
    input: MemoryDedupeInput,
    context: MemoryStoreContext,
  ): Promise<MemoryItem | undefined> {
    const identity = createMemoryDedupeIdentity(input);
    const normalized = normalizeContext(context);
    const state = this.namespaces.get(normalized.namespace);
    if (!state) return undefined;
    const now = normalized.now ?? new Date();
    const candidate = [...state.items.values()]
      .filter((item) => canAccessMemoryScope(item.scope, normalized.access))
      .filter((item) => item.status === "active" || item.status === "pending")
      .filter((item) => !isMemoryItemExpired(item, now))
      .filter((item) => createMemoryDedupeIdentity(item) === identity)
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      ))[0];
    return candidate ? cloneItem(candidate) : undefined;
  }

  async appendUsage(
    value: MemoryUsageEvent,
    context: MemoryStoreContext,
  ): Promise<void> {
    const normalized = normalizeContext(context);
    const item = this.existing(value.memoryId, normalized);
    if (!item) throw new MemoryAuthorizationError();
    const event = normalizeUsageEvent(value);
    const state = this.state(normalized.namespace);
    if (state.usage.some((existing) => existing.id === event.id)) {
      throw new MemoryConflictError(
        `Memory usage event "${event.id}" already exists`,
      );
    }
    state.usage.push(event);
  }

  async listUsage(
    memoryId: string,
    context: MemoryStoreContext,
  ): Promise<MemoryUsageEvent[]> {
    const normalized = normalizeContext(context);
    const item = this.existing(memoryId, normalized);
    if (!item) return [];
    return (this.namespaces.get(normalized.namespace)?.usage ?? [])
      .filter((event) => event.memoryId === item.id)
      .slice()
      .sort((left, right) => (
        left.at.localeCompare(right.at)
        || left.id.localeCompare(right.id)
      ))
      .map(cloneUsage);
  }

  exportSnapshot(): MemoryItemStoreSnapshot {
    const namespaces: MemoryStoreSnapshotNamespace[] = [...this.namespaces]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([namespace, state]) => ({
        namespace,
        items: [...state.items.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(cloneItem),
        usage: state.usage
          .slice()
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(cloneUsage),
      }));
    return Object.freeze({
      version: 1,
      namespaces: Object.freeze(namespaces),
    });
  }

  replaceSnapshot(value: MemoryItemStoreSnapshot): void {
    if (!value || value.version !== 1 || !Array.isArray(value.namespaces)) {
      throw new MemoryContractError("Invalid Memory item store snapshot");
    }
    const next = new Map<string, NamespaceState>();
    for (const namespaceState of value.namespaces) {
      const namespace = text(namespaceState.namespace, "snapshot.namespace");
      if (next.has(namespace)) {
        throw new MemoryConflictError(`Duplicate Memory namespace "${namespace}"`);
      }
      if (
        !Array.isArray(namespaceState.items)
        || !Array.isArray(namespaceState.usage)
      ) {
        throw new MemoryContractError("Invalid Memory namespace snapshot");
      }
      const items = new Map<string, MemoryItem>();
      for (const valueItem of namespaceState.items) {
        const item = cloneItem(valueItem);
        if (items.has(item.id)) {
          throw new MemoryConflictError(`Duplicate Memory item "${item.id}"`);
        }
        items.set(item.id, item);
      }
      const usage: MemoryUsageEvent[] = namespaceState.usage.map(
        (event: MemoryUsageEvent) => cloneUsage(event),
      );
      if (new Set(usage.map((event) => event.id)).size !== usage.length) {
        throw new MemoryConflictError("Duplicate Memory usage event");
      }
      for (const event of usage) {
        if (!items.has(event.memoryId)) {
          throw new MemoryContractError(
            `Memory usage references missing item "${event.memoryId}"`,
          );
        }
      }
      next.set(namespace, { items, usage });
    }
    this.namespaces.clear();
    for (const [namespace, state] of next) {
      this.namespaces.set(namespace, state);
    }
  }
}
