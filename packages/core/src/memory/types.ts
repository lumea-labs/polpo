export const MEMORY_SCOPE_KINDS = [
  "org",
  "project",
  "agent",
  "user",
  "channel",
  "session",
] as const;

export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

export interface MemoryScope {
  readonly kind: MemoryScopeKind;
  readonly subjectId?: string;
  readonly agentName?: string;
}

export const MEMORY_KINDS = [
  "fact",
  "preference",
  "open_thread",
  "style",
  "failure_pattern",
  "successful_episode",
  "procedure_hint",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = [
  "pending",
  "active",
  "superseded",
  "deleted",
] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_PROVENANCE_SOURCES = [
  "explicit",
  "run",
  "session",
  "tool",
  "import",
  "extraction",
] as const;

export type MemoryProvenanceSource =
  (typeof MEMORY_PROVENANCE_SOURCES)[number];

export type MemoryProvenanceActor = "user" | "agent" | "system";

export interface MemoryProvenance {
  readonly source: MemoryProvenanceSource;
  readonly actor?: MemoryProvenanceActor;
  readonly sourceId?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly messageId?: string;
  readonly toolName?: string;
}

export interface MemoryItem {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly provenance: MemoryProvenance;
  readonly confidence?: number;
  readonly status: MemoryStatus;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemoryItemInput {
  readonly id?: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly provenance: MemoryProvenance;
  readonly confidence?: number;
  readonly status?: Extract<MemoryStatus, "pending" | "active">;
  readonly expiresAt?: string;
}

export interface MemoryItemFactoryOptions {
  readonly createId?: () => string;
  readonly now?: () => Date | string;
}

export interface MemoryScopeAccess {
  readonly orgId?: string;
  readonly projectId?: string;
  readonly agentName?: string;
  /** Hosted application's end user, never the Polpo account/member id. */
  readonly externalUserId?: string;
  readonly channelId?: string;
  readonly sessionId?: string;
}

export interface MemoryDedupeInput {
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly content: string;
}

export interface RenderMemoryItemsOptions {
  readonly now?: Date | string;
  readonly includePending?: boolean;
}
