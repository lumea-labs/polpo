import type {
  MemoryDedupeInput,
  MemoryItem,
  MemoryKind,
  MemoryScope,
  MemoryScopeAccess,
  MemoryStatus,
} from "./types.js";
import type {
  HybridRetrievalMode,
  TextEmbeddingProvider,
} from "../semantic-retrieval.js";

export type MemoryWriteSurface =
  | "api"
  | "chat"
  | "task"
  | "loop"
  | "schedule"
  | "channel"
  | "system";

export interface MemoryStoreContext {
  /** Host-owned hard isolation boundary, normally a project id. */
  readonly namespace: string;
  readonly access: MemoryScopeAccess;
  readonly surface?: MemoryWriteSurface;
  readonly channelVisibility?: "public" | "private";
  readonly now?: Date | string;
}

export interface MemoryItemPatch {
  readonly content?: string;
  readonly summary?: string | null;
  readonly confidence?: number | null;
  readonly status?: MemoryStatus;
  readonly expiresAt?: string | null;
}

export interface MemoryGetOptions {
  readonly includeInactive?: boolean;
  readonly includeExpired?: boolean;
  readonly now?: Date | string;
}

export interface MemoryListQuery {
  readonly kinds?: readonly MemoryKind[];
  readonly statuses?: readonly MemoryStatus[];
  readonly scope?: MemoryScope;
  readonly includeExpired?: boolean;
  readonly now?: Date | string;
  readonly limit?: number;
}

export interface MemoryListCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface MemoryListPageQuery extends MemoryListQuery {
  readonly after?: MemoryListCursor;
}

export interface MemoryListPage {
  readonly items: readonly MemoryItem[];
  readonly nextCursor?: MemoryListCursor;
}

export interface MemorySearchQuery {
  readonly query: string;
  readonly kinds?: readonly MemoryKind[];
  readonly scope?: MemoryScope;
  readonly tokenBudget?: number;
  readonly maxResults?: number;
  readonly now?: Date | string;
  readonly signal?: AbortSignal;
}

export interface MemorySearchResult {
  readonly item: MemoryItem;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly estimatedTokens: number;
  readonly scores?: {
    readonly lexical?: number;
    readonly semantic?: number;
    readonly rerank?: number;
  };
  readonly ranks?: {
    readonly lexical?: number;
    readonly semantic?: number;
  };
  readonly retrievalMode?: HybridRetrievalMode;
  readonly fallbackReason?: string;
}

export interface MemorySemanticRetrievalOptions {
  readonly embeddingProvider?: TextEmbeddingProvider;
  readonly embeddingFailureMode?: "fallback" | "strict";
}

export type MemoryUsageEventType =
  | "retrieved"
  | "written"
  | "updated"
  | "superseded"
  | "forgotten";

export interface MemoryUsageEvent {
  readonly id: string;
  readonly memoryId: string;
  readonly type: MemoryUsageEventType;
  readonly at: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
}

export interface MemorySupersedeResult {
  readonly superseded: MemoryItem;
  readonly replacement: MemoryItem;
}

export interface MemoryItemStore {
  create(item: MemoryItem, context: MemoryStoreContext): Promise<MemoryItem>;
  get(
    id: string,
    context: MemoryStoreContext,
    options?: MemoryGetOptions,
  ): Promise<MemoryItem | undefined>;
  list(
    query: MemoryListQuery,
    context: MemoryStoreContext,
  ): Promise<MemoryItem[]>;
  /**
   * Optional additive keyset-pagination capability. Hosts that do not
   * implement it retain the original `list()` contract.
   */
  listPage?(
    query: MemoryListPageQuery,
    context: MemoryStoreContext,
  ): Promise<MemoryListPage>;
  update(
    id: string,
    patch: MemoryItemPatch,
    context: MemoryStoreContext,
  ): Promise<MemoryItem | undefined>;
  supersede(
    id: string,
    replacement: MemoryItem,
    context: MemoryStoreContext,
  ): Promise<MemorySupersedeResult | undefined>;
  forget(id: string, context: MemoryStoreContext): Promise<boolean>;
  search(
    query: MemorySearchQuery,
    context: MemoryStoreContext,
  ): Promise<MemorySearchResult[]>;
  findDedupeCandidate(
    input: MemoryDedupeInput,
    context: MemoryStoreContext,
  ): Promise<MemoryItem | undefined>;
  appendUsage(
    event: MemoryUsageEvent,
    context: MemoryStoreContext,
  ): Promise<void>;
  listUsage(
    memoryId: string,
    context: MemoryStoreContext,
  ): Promise<MemoryUsageEvent[]>;
  close?(): Promise<void> | void;
}

export interface MemoryStoreSnapshotNamespace {
  readonly namespace: string;
  readonly items: readonly MemoryItem[];
  readonly usage: readonly MemoryUsageEvent[];
}

export interface MemoryItemStoreSnapshot {
  readonly version: 1;
  readonly namespaces: readonly MemoryStoreSnapshotNamespace[];
}
