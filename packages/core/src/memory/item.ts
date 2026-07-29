import { nanoid } from "nanoid";
import { MemoryContractError } from "./errors.js";
import { normalizeMemoryScope } from "./scope.js";
import {
  MEMORY_KINDS,
  MEMORY_PROVENANCE_SOURCES,
  MEMORY_STATUSES,
  type CreateMemoryItemInput,
  type MemoryItem,
  type MemoryItemFactoryOptions,
  type MemoryKind,
  type MemoryProvenance,
  type MemoryProvenanceActor,
  type MemoryProvenanceSource,
  type MemoryStatus,
} from "./types.js";

export const MAX_MEMORY_CONTENT_CHARACTERS = 32_000;
export const MAX_MEMORY_SUMMARY_CHARACTERS = 1_000;

const kinds = new Set<string>(MEMORY_KINDS);
const statuses = new Set<string>(MEMORY_STATUSES);
const provenanceSources = new Set<string>(MEMORY_PROVENANCE_SOURCES);
const provenanceActors = new Set<string>(["user", "agent", "system"]);

function text(
  value: unknown,
  path: string,
  max: number,
  required = true,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    throw new MemoryContractError(
      `${path} must be a string`,
      "invalid_item",
      path,
    );
  }
  const normalized = value.trim();
  if (
    (required && normalized.length === 0)
    || normalized.length > max
  ) {
    throw new MemoryContractError(
      `${path} must contain ${required ? "between 1 and" : "at most"} ${max} characters`,
      "invalid_item",
      path,
    );
  }
  return normalized || undefined;
}

function isoTimestamp(value: unknown, path: string): string {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new MemoryContractError(
      `${path} must be a valid timestamp`,
      "invalid_item",
      path,
    );
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MemoryContractError(
      `${path} must be a valid timestamp`,
      "invalid_item",
      path,
    );
  }
  return date.toISOString();
}

function optionalReference(value: unknown, path: string): string | undefined {
  return text(value, path, 512, false);
}

function normalizeProvenance(value: unknown): MemoryProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError(
      "Memory provenance must be an object",
      "invalid_provenance",
      "provenance",
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.source !== "string"
    || !provenanceSources.has(candidate.source)
  ) {
    throw new MemoryContractError(
      `Unknown Memory provenance source: ${String(candidate.source)}`,
      "invalid_provenance",
      "provenance.source",
    );
  }
  const source = candidate.source as MemoryProvenanceSource;
  let actor: MemoryProvenanceActor | undefined;
  if (candidate.actor !== undefined) {
    if (
      typeof candidate.actor !== "string"
      || !provenanceActors.has(candidate.actor)
    ) {
      throw new MemoryContractError(
        `Unknown Memory provenance actor: ${String(candidate.actor)}`,
        "invalid_provenance",
        "provenance.actor",
      );
    }
    actor = candidate.actor as MemoryProvenanceActor;
  }

  const sourceId = optionalReference(candidate.sourceId, "provenance.sourceId");
  const runId = optionalReference(candidate.runId, "provenance.runId");
  const sessionId = optionalReference(candidate.sessionId, "provenance.sessionId");
  const messageId = optionalReference(candidate.messageId, "provenance.messageId");
  const toolName = optionalReference(candidate.toolName, "provenance.toolName");
  const provenance: MemoryProvenance = {
    source,
    ...(actor ? { actor } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(toolName ? { toolName } : {}),
  };

  const hasReference = Boolean(
    provenance.sourceId
    || provenance.runId
    || provenance.sessionId
    || provenance.messageId
    || provenance.toolName,
  );
  if (source === "explicit" && !provenance.actor) {
    throw new MemoryContractError(
      "Explicit Memory provenance requires an actor",
      "invalid_provenance",
      "provenance.actor",
    );
  }
  if (source === "run" && !provenance.runId) {
    throw new MemoryContractError(
      "Run Memory provenance requires runId",
      "invalid_provenance",
      "provenance.runId",
    );
  }
  if (source === "session" && !provenance.sessionId) {
    throw new MemoryContractError(
      "Session Memory provenance requires sessionId",
      "invalid_provenance",
      "provenance.sessionId",
    );
  }
  if (source === "tool" && !provenance.toolName) {
    throw new MemoryContractError(
      "Tool Memory provenance requires toolName",
      "invalid_provenance",
      "provenance.toolName",
    );
  }
  if ((source === "import" || source === "extraction") && !hasReference) {
    throw new MemoryContractError(
      `${source} Memory provenance requires a source reference`,
      "invalid_provenance",
      "provenance",
    );
  }
  return Object.freeze(provenance);
}

function normalizeConfidence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new MemoryContractError(
      "Memory confidence must be a finite number between 0 and 1",
      "invalid_item",
      "confidence",
    );
  }
  return value;
}

function normalizeKind(value: unknown): MemoryKind {
  if (typeof value !== "string" || !kinds.has(value)) {
    throw new MemoryContractError(
      `Unknown Memory kind: ${String(value)}`,
      "invalid_item",
      "kind",
    );
  }
  return value as MemoryKind;
}

function normalizeStatus(value: unknown): MemoryStatus {
  if (typeof value !== "string" || !statuses.has(value)) {
    throw new MemoryContractError(
      `Unknown Memory status: ${String(value)}`,
      "invalid_item",
      "status",
    );
  }
  return value as MemoryStatus;
}

function freezeItem(input: {
  id: unknown;
  scope: unknown;
  kind: unknown;
  content: unknown;
  summary?: unknown;
  provenance: unknown;
  confidence?: unknown;
  status: unknown;
  expiresAt?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}): MemoryItem {
  const createdAt = isoTimestamp(input.createdAt, "createdAt");
  const updatedAt = isoTimestamp(input.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new MemoryContractError(
      "Memory updatedAt cannot precede createdAt",
      "invalid_item",
      "updatedAt",
    );
  }
  const confidence = normalizeConfidence(input.confidence);
  const summary = text(
    input.summary,
    "summary",
    MAX_MEMORY_SUMMARY_CHARACTERS,
    false,
  );
  const expiresAt = input.expiresAt === undefined
    ? undefined
    : isoTimestamp(input.expiresAt, "expiresAt");
  return Object.freeze({
    id: text(input.id, "id", 256)!,
    scope: normalizeMemoryScope(input.scope),
    kind: normalizeKind(input.kind),
    content: text(input.content, "content", MAX_MEMORY_CONTENT_CHARACTERS)!,
    ...(summary ? { summary } : {}),
    provenance: normalizeProvenance(input.provenance),
    ...(confidence === undefined ? {} : { confidence }),
    status: normalizeStatus(input.status),
    ...(expiresAt ? { expiresAt } : {}),
    createdAt,
    updatedAt,
  });
}

export function createMemoryItem(
  input: CreateMemoryItemInput,
  factory: MemoryItemFactoryOptions = {},
): MemoryItem {
  if (!input || typeof input !== "object") {
    throw new MemoryContractError("Memory item input must be an object");
  }
  const status = input.status ?? "active";
  if (status !== "active" && status !== "pending") {
    throw new MemoryContractError(
      "New Memory items may only be active or pending",
      "invalid_item",
      "status",
    );
  }
  const nowValue = factory.now?.() ?? new Date();
  const now = isoTimestamp(nowValue, "now");
  return freezeItem({
    id: input.id ?? factory.createId?.() ?? `memory-${nanoid(16)}`,
    scope: input.scope,
    kind: input.kind,
    content: input.content,
    summary: input.summary,
    provenance: input.provenance,
    confidence: input.confidence,
    status,
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

export function normalizeMemoryItem(value: unknown): MemoryItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError("Memory item must be an object");
  }
  return freezeItem(value as Parameters<typeof freezeItem>[0]);
}
