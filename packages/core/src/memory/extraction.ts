import { nanoid } from "nanoid";
import { MemoryContractError } from "./errors.js";
import {
  MAX_MEMORY_CONTENT_CHARACTERS,
  MAX_MEMORY_SUMMARY_CHARACTERS,
} from "./item.js";
import { normalizeMemoryDedupeContent } from "./dedupe.js";
import { normalizeMemoryScope } from "./scope.js";
import {
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryProvenance,
  type MemoryScope,
  type MemoryScopeAccess,
} from "./types.js";
import type {
  MemorySensitiveContentFinding,
} from "./policy.js";
import { detectSensitiveMemoryContent } from "./policy.js";

export const MEMORY_EXTRACTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "applied",
] as const;

export type MemoryExtractionStatus =
  (typeof MEMORY_EXTRACTION_STATUSES)[number];

export const MEMORY_EXTRACTION_PROPOSAL_ACTIONS = [
  "create",
  "duplicate",
  "supersede",
] as const;

export type MemoryExtractionProposalAction =
  (typeof MEMORY_EXTRACTION_PROPOSAL_ACTIONS)[number];

export const MEMORY_EXTRACTION_AUDIT_TYPES = [
  "proposed",
  "approved",
  "rejected",
  "applied",
] as const;

export type MemoryExtractionAuditType =
  (typeof MEMORY_EXTRACTION_AUDIT_TYPES)[number];

export type MemoryExtractionMetadataValue =
  | null
  | boolean
  | number
  | string
  | readonly MemoryExtractionMetadataValue[]
  | { readonly [key: string]: MemoryExtractionMetadataValue };

export interface MemoryExtractionSource {
  readonly sourceId?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly extractorRevision?: string;
  readonly policyRevision?: string;
  readonly messageIds?: readonly string[];
}

export interface MemoryExtractionProposal {
  readonly action: MemoryExtractionProposalAction;
  readonly existingMemoryId?: string;
}

export interface MemoryExtractionReviewer {
  readonly actor: "user" | "system";
  readonly actorId: string;
}

export interface MemoryExtractionDecision {
  readonly decision: "approve" | "reject";
  readonly decidedBy: MemoryExtractionReviewer;
  readonly decidedAt: string;
  readonly reason?: string;
}

export interface MemoryExtractionCandidate {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly confidence?: number;
  readonly source: MemoryExtractionSource;
  readonly provenance: MemoryProvenance;
  readonly proposal: MemoryExtractionProposal;
  readonly sensitiveFindings: readonly MemorySensitiveContentFinding[];
  readonly metadata: Readonly<Record<string, MemoryExtractionMetadataValue>>;
  readonly status: MemoryExtractionStatus;
  readonly revision: number;
  readonly decision?: MemoryExtractionDecision;
  readonly appliedMemoryId?: string;
  readonly appliedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemoryExtractionCandidateInput {
  readonly idempotencyKey: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly confidence?: number;
  readonly source: MemoryExtractionSource;
  readonly proposal?: MemoryExtractionProposal;
  readonly sensitiveFindings?: readonly MemorySensitiveContentFinding[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryExtractionCandidateFactoryOptions {
  readonly createId?: () => string;
  readonly now?: () => Date | string;
}

export interface MemoryExtractionDecisionInput {
  readonly decision: "approve" | "reject";
  readonly decidedBy: MemoryExtractionReviewer;
  readonly reason?: string;
  readonly expectedRevision?: number;
}

export interface MemoryExtractionApplyInput {
  readonly memoryId: string;
  readonly expectedRevision?: number;
}

export interface MemoryExtractionListQuery {
  readonly statuses?: readonly MemoryExtractionStatus[];
  readonly scope?: MemoryScope;
  readonly limit?: number;
  /** Exclusive keyset in canonical descending-createdAt, ascending-id order. */
  readonly after?: {
    readonly createdAt: string;
    readonly id: string;
  };
}

export interface MemoryExtractionStoreContext {
  readonly namespace: string;
  readonly access: MemoryScopeAccess;
}

export interface MemoryExtractionProposeResult {
  readonly candidate: MemoryExtractionCandidate;
  readonly created: boolean;
}

export interface MemoryExtractionAuditEvent {
  readonly id: string;
  readonly candidateId: string;
  readonly type: MemoryExtractionAuditType;
  readonly at: string;
  readonly reviewer?: MemoryExtractionReviewer;
  readonly reason?: string;
  readonly memoryId?: string;
}

export interface MemoryExtractionCandidateStore {
  propose(
    candidate: MemoryExtractionCandidate,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionProposeResult>;
  get(
    id: string,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate | undefined>;
  /** Stable retry lookup scoped by the policy-controlled Memory scope. */
  getByIdempotencyKey?(
    idempotencyKey: string,
    scope: MemoryScope,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate | undefined>;
  list(
    query: MemoryExtractionListQuery,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate[]>;
  decide(
    id: string,
    input: MemoryExtractionDecisionInput,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate>;
  markApplied(
    id: string,
    input: MemoryExtractionApplyInput,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate>;
  listAudit(
    candidateId: string,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionAuditEvent[]>;
  close?(): Promise<void> | void;
}

export interface MemoryExtractionSnapshotNamespace {
  readonly namespace: string;
  readonly candidates: readonly MemoryExtractionCandidate[];
  readonly audit: readonly MemoryExtractionAuditEvent[];
}

export interface MemoryExtractionStoreSnapshot {
  readonly version: 1;
  readonly namespaces: readonly MemoryExtractionSnapshotNamespace[];
}

const memoryKinds = new Set<string>(MEMORY_KINDS);
const extractionStatuses = new Set<string>(MEMORY_EXTRACTION_STATUSES);
const proposalActions = new Set<string>(MEMORY_EXTRACTION_PROPOSAL_ACTIONS);
const auditTypes = new Set<string>(MEMORY_EXTRACTION_AUDIT_TYPES);
const MAX_REFERENCE_CHARACTERS = 512;
const MAX_IDEMPOTENCY_KEY_CHARACTERS = 2_048;
const MAX_REASON_CHARACTERS = 2_000;
const MAX_MESSAGE_IDS = 100;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 5_000;
const MAX_METADATA_CHARACTERS = 32_000;

function requiredText(
  value: unknown,
  path: string,
  max: number,
): string {
  if (typeof value !== "string") {
    throw new MemoryContractError(
      `${path} must be a string`,
      "invalid_item",
      path,
    );
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

function optionalText(
  value: unknown,
  path: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, path, max);
}

function timestamp(value: unknown, path: string): string {
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

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new MemoryContractError(
      `${path} must be a positive safe integer`,
      "invalid_item",
      path,
    );
  }
  return Number(value);
}

function confidence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new MemoryContractError(
      "confidence must be a finite number between 0 and 1",
      "invalid_item",
      "confidence",
    );
  }
  return value;
}

function kind(value: unknown): MemoryKind {
  if (typeof value !== "string" || !memoryKinds.has(value)) {
    throw new MemoryContractError(
      `Unknown Memory kind: ${String(value)}`,
      "invalid_item",
      "kind",
    );
  }
  return value as MemoryKind;
}

function normalizeSource(value: unknown): MemoryExtractionSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError(
      "source must be an object",
      "invalid_provenance",
      "source",
    );
  }
  const source = value as Record<string, unknown>;
  const sourceId = optionalText(
    source.sourceId,
    "source.sourceId",
    MAX_REFERENCE_CHARACTERS,
  );
  const runId = optionalText(
    source.runId,
    "source.runId",
    MAX_REFERENCE_CHARACTERS,
  );
  const sessionId = optionalText(
    source.sessionId,
    "source.sessionId",
    MAX_REFERENCE_CHARACTERS,
  );
  const turnId = optionalText(
    source.turnId,
    "source.turnId",
    MAX_REFERENCE_CHARACTERS,
  );
  const extractorRevision = optionalText(
    source.extractorRevision,
    "source.extractorRevision",
    MAX_REFERENCE_CHARACTERS,
  );
  const policyRevision = optionalText(
    source.policyRevision,
    "source.policyRevision",
    MAX_REFERENCE_CHARACTERS,
  );
  let messageIds: readonly string[] | undefined;
  if (source.messageIds !== undefined) {
    if (
      !Array.isArray(source.messageIds)
      || source.messageIds.length > MAX_MESSAGE_IDS
    ) {
      throw new MemoryContractError(
        `source.messageIds must contain at most ${MAX_MESSAGE_IDS} ids`,
        "invalid_provenance",
        "source.messageIds",
      );
    }
    messageIds = Object.freeze(
      [...new Set(source.messageIds.map((id, index) =>
        requiredText(
          id,
          `source.messageIds[${index}]`,
          MAX_REFERENCE_CHARACTERS,
        ),
      ))].sort(),
    );
    if (messageIds.length === 0) messageIds = undefined;
  }
  if (!sourceId && !runId && !sessionId && !turnId && !messageIds?.length) {
    throw new MemoryContractError(
      "source requires sourceId, runId, sessionId, or messageIds",
      "invalid_provenance",
      "source",
    );
  }
  return Object.freeze({
    ...(sourceId ? { sourceId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(extractorRevision ? { extractorRevision } : {}),
    ...(policyRevision ? { policyRevision } : {}),
    ...(messageIds ? { messageIds } : {}),
  });
}

function provenance(source: MemoryExtractionSource): MemoryProvenance {
  return Object.freeze({
    source: "extraction",
    actor: "system",
    ...(source.sourceId ? { sourceId: source.sourceId } : {}),
    ...(source.runId ? { runId: source.runId } : {}),
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    ...(source.messageIds?.[0]
      ? { messageId: source.messageIds[0] }
      : {}),
  });
}

function normalizeProposal(value: unknown): MemoryExtractionProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError(
      "proposal must be an object",
      "invalid_item",
      "proposal",
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.action !== "string"
    || !proposalActions.has(candidate.action)
  ) {
    throw new MemoryContractError(
      `Unknown extraction proposal: ${String(candidate.action)}`,
      "invalid_item",
      "proposal.action",
    );
  }
  const action = candidate.action as MemoryExtractionProposalAction;
  const existingMemoryId = optionalText(
    candidate.existingMemoryId,
    "proposal.existingMemoryId",
    MAX_REFERENCE_CHARACTERS,
  );
  if (action === "create" && existingMemoryId) {
    throw new MemoryContractError(
      "create proposals cannot reference an existing Memory item",
      "invalid_item",
      "proposal.existingMemoryId",
    );
  }
  if (action !== "create" && !existingMemoryId) {
    throw new MemoryContractError(
      `${action} proposals require existingMemoryId`,
      "invalid_item",
      "proposal.existingMemoryId",
    );
  }
  return Object.freeze({
    action,
    ...(existingMemoryId ? { existingMemoryId } : {}),
  });
}

function normalizeFinding(
  value: unknown,
  index: number,
): MemorySensitiveContentFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError(
      `sensitiveFindings[${index}] must be an object`,
      "invalid_item",
      `sensitiveFindings[${index}]`,
    );
  }
  const finding = value as Record<string, unknown>;
  const code =
    typeof finding.code === "string"
    && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(finding.code)
      ? finding.code
      : "custom_sensitive_content";
  const start = Number.isSafeInteger(finding.start) && Number(finding.start) >= 0
    ? Number(finding.start)
    : 0;
  const length = Number.isSafeInteger(finding.length) && Number(finding.length) >= 0
    ? Number(finding.length)
    : 0;
  return Object.freeze({ code, start, length });
}

function normalizeFindings(
  value: unknown,
): readonly MemorySensitiveContentFinding[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new MemoryContractError(
      "sensitiveFindings must be an array with at most 1000 entries",
      "invalid_item",
      "sensitiveFindings",
    );
  }
  const findings = value.map(normalizeFinding).sort((left, right) =>
    left.start - right.start
    || left.code.localeCompare(right.code)
    || left.length - right.length
  );
  return Object.freeze(findings.filter((finding, index) => {
    const previous = findings[index - 1];
    return !previous
      || previous.code !== finding.code
      || previous.start !== finding.start
      || previous.length !== finding.length;
  }));
}

function normalizeMetadata(
  value: unknown,
): Readonly<Record<string, MemoryExtractionMetadataValue>> {
  if (value === undefined) return Object.freeze({});
  let nodes = 0;
  const visit = (
    entry: unknown,
    path: string,
    depth: number,
  ): MemoryExtractionMetadataValue => {
    nodes += 1;
    if (nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) {
      throw new MemoryContractError(
        "metadata is too complex",
        "invalid_item",
        path,
      );
    }
    if (
      entry === null
      || typeof entry === "boolean"
      || typeof entry === "string"
    ) {
      return entry;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new MemoryContractError(
          `${path} must contain finite numbers`,
          "invalid_item",
          path,
        );
      }
      return entry;
    }
    if (Array.isArray(entry)) {
      return Object.freeze(entry.map((item, index) =>
        visit(item, `${path}[${index}]`, depth + 1),
      ));
    }
    if (
      !entry
      || typeof entry !== "object"
      || (
        Object.getPrototypeOf(entry) !== Object.prototype
        && Object.getPrototypeOf(entry) !== null
      )
    ) {
      throw new MemoryContractError(
        `${path} must contain JSON-compatible values`,
        "invalid_item",
        path,
      );
    }
    const result = Object.create(null) as Record<
      string,
      MemoryExtractionMetadataValue
    >;
    for (const [key, item] of Object.entries(entry).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      const normalizedKey = requiredText(key, `${path} key`, 256);
      if (Object.hasOwn(result, normalizedKey)) {
        throw new MemoryContractError(
          `${path} contains duplicate normalized key "${normalizedKey}"`,
          "invalid_item",
          path,
        );
      }
      result[normalizedKey] = visit(
        item,
        `${path}.${normalizedKey}`,
        depth + 1,
      );
    }
    return Object.freeze(result);
  };
  const normalized = visit(value, "metadata", 0);
  if (
    !normalized
    || Array.isArray(normalized)
    || typeof normalized !== "object"
  ) {
    throw new MemoryContractError(
      "metadata must be an object",
      "invalid_item",
      "metadata",
    );
  }
  if (JSON.stringify(normalized).length > MAX_METADATA_CHARACTERS) {
    throw new MemoryContractError(
      `metadata must contain at most ${MAX_METADATA_CHARACTERS} characters`,
      "invalid_item",
      "metadata",
    );
  }
  return normalized as Readonly<Record<string, MemoryExtractionMetadataValue>>;
}

function normalizeReviewer(value: unknown): MemoryExtractionReviewer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError(
      "decidedBy must be an object",
      "invalid_item",
      "decision.decidedBy",
    );
  }
  const reviewer = value as Record<string, unknown>;
  if (reviewer.actor !== "user" && reviewer.actor !== "system") {
    throw new MemoryContractError(
      "decision actor must be user or system",
      "invalid_item",
      "decision.decidedBy.actor",
    );
  }
  return Object.freeze({
    actor: reviewer.actor,
    actorId: requiredText(
      reviewer.actorId,
      "decision.decidedBy.actorId",
      MAX_REFERENCE_CHARACTERS,
    ),
  });
}

function normalizeDecision(value: unknown): MemoryExtractionDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError(
      "decision must be an object",
      "invalid_item",
      "decision",
    );
  }
  const decision = value as Record<string, unknown>;
  if (decision.decision !== "approve" && decision.decision !== "reject") {
    throw new MemoryContractError(
      "decision must be approve or reject",
      "invalid_item",
      "decision.decision",
    );
  }
  const reason = optionalText(
    decision.reason,
    "decision.reason",
    MAX_REASON_CHARACTERS,
  );
  if (decision.decision === "reject" && !reason) {
    throw new MemoryContractError(
      "rejection decisions require a reason",
      "invalid_item",
      "decision.reason",
    );
  }
  return Object.freeze({
    decision: decision.decision,
    decidedBy: normalizeReviewer(decision.decidedBy),
    decidedAt: timestamp(decision.decidedAt, "decision.decidedAt"),
    ...(reason ? { reason } : {}),
  });
}

function freezeCandidate(input: Record<string, unknown>): MemoryExtractionCandidate {
  const status = input.status;
  if (typeof status !== "string" || !extractionStatuses.has(status)) {
    throw new MemoryContractError(
      `Unknown extraction status: ${String(status)}`,
      "invalid_item",
      "status",
    );
  }
  const revision = positiveInteger(input.revision, "revision");
  const expectedRevision = status === "pending"
    ? 1
    : status === "applied"
      ? 3
      : 2;
  if (revision !== expectedRevision) {
    throw new MemoryContractError(
      `${status} candidates require revision ${expectedRevision}`,
      "invalid_transition",
      "revision",
    );
  }
  const createdAt = timestamp(input.createdAt, "createdAt");
  const updatedAt = timestamp(input.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new MemoryContractError(
      "updatedAt cannot precede createdAt",
      "invalid_item",
      "updatedAt",
    );
  }
  const source = normalizeSource(input.source);
  const decision = input.decision === undefined
    ? undefined
    : normalizeDecision(input.decision);
  const appliedMemoryId = optionalText(
    input.appliedMemoryId,
    "appliedMemoryId",
    MAX_REFERENCE_CHARACTERS,
  );
  const appliedAt = input.appliedAt === undefined
    ? undefined
    : timestamp(input.appliedAt, "appliedAt");

  if (status === "pending" && (decision || appliedMemoryId || appliedAt)) {
    throw new MemoryContractError(
      "pending candidates cannot contain a decision or applied Memory",
      "invalid_transition",
      "status",
    );
  }
  if (
    status === "approved"
    && (
      decision?.decision !== "approve"
      || appliedMemoryId
      || appliedAt
    )
  ) {
    throw new MemoryContractError(
      "approved candidates require an approval decision only",
      "invalid_transition",
      "status",
    );
  }
  if (
    status === "rejected"
    && (
      decision?.decision !== "reject"
      || appliedMemoryId
      || appliedAt
    )
  ) {
    throw new MemoryContractError(
      "rejected candidates require a rejection decision only",
      "invalid_transition",
      "status",
    );
  }
  if (
    status === "applied"
    && (
      decision?.decision !== "approve"
      || !appliedMemoryId
      || !appliedAt
    )
  ) {
    throw new MemoryContractError(
      "applied candidates require approval and an applied Memory reference",
      "invalid_transition",
      "status",
    );
  }
  if (decision && Date.parse(decision.decidedAt) < Date.parse(createdAt)) {
    throw new MemoryContractError(
      "decision cannot precede candidate creation",
      "invalid_item",
      "decision.decidedAt",
    );
  }
  if (decision && Date.parse(decision.decidedAt) > Date.parse(updatedAt)) {
    throw new MemoryContractError(
      "decision cannot follow candidate update time",
      "invalid_item",
      "decision.decidedAt",
    );
  }
  if (appliedAt && decision && Date.parse(appliedAt) < Date.parse(decision.decidedAt)) {
    throw new MemoryContractError(
      "appliedAt cannot precede approval",
      "invalid_item",
      "appliedAt",
    );
  }
  if (appliedAt && Date.parse(appliedAt) > Date.parse(updatedAt)) {
    throw new MemoryContractError(
      "appliedAt cannot follow candidate update time",
      "invalid_item",
      "appliedAt",
    );
  }

  const content = requiredText(
    input.content,
    "content",
    MAX_MEMORY_CONTENT_CHARACTERS,
  );
  const summary = optionalText(
    input.summary,
    "summary",
    MAX_MEMORY_SUMMARY_CHARACTERS,
  );
  const reportedFindings = normalizeFindings(input.sensitiveFindings);
  const detectedFindings = normalizeFindings([
    ...detectSensitiveMemoryContent(content),
    ...(summary ? detectSensitiveMemoryContent(summary) : []),
    ...reportedFindings,
  ]);
  const normalizedConfidence = confidence(input.confidence);
  const candidate: MemoryExtractionCandidate = {
    id: requiredText(input.id, "id", 256),
    idempotencyKey: requiredText(
      input.idempotencyKey,
      "idempotencyKey",
      MAX_IDEMPOTENCY_KEY_CHARACTERS,
    ),
    scope: normalizeMemoryScope(input.scope),
    kind: kind(input.kind),
    content,
    ...(summary ? { summary } : {}),
    ...(normalizedConfidence === undefined
      ? {}
      : { confidence: normalizedConfidence }),
    source,
    provenance: provenance(source),
    proposal: normalizeProposal(input.proposal),
    sensitiveFindings: detectedFindings,
    metadata: normalizeMetadata(input.metadata),
    status: status as MemoryExtractionStatus,
    revision,
    ...(decision ? { decision } : {}),
    ...(appliedMemoryId ? { appliedMemoryId } : {}),
    ...(appliedAt ? { appliedAt } : {}),
    createdAt,
    updatedAt,
  };
  return Object.freeze(candidate);
}

export function createMemoryExtractionCandidate(
  input: CreateMemoryExtractionCandidateInput,
  factory: MemoryExtractionCandidateFactoryOptions = {},
): MemoryExtractionCandidate {
  if (!input || typeof input !== "object") {
    throw new MemoryContractError("extraction candidate input must be an object");
  }
  const now = timestamp(factory.now?.() ?? new Date(), "now");
  return freezeCandidate({
    id: factory.createId?.() ?? `memory-candidate-${nanoid(16)}`,
    idempotencyKey: input.idempotencyKey,
    scope: input.scope,
    kind: input.kind,
    content: input.content,
    summary: input.summary,
    confidence: input.confidence,
    source: input.source,
    proposal: input.proposal ?? { action: "create" },
    sensitiveFindings: input.sensitiveFindings ?? [],
    metadata: input.metadata ?? {},
    status: "pending",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
}

export function normalizeMemoryExtractionCandidate(
  value: unknown,
): MemoryExtractionCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError("extraction candidate must be an object");
  }
  return freezeCandidate(value as Record<string, unknown>);
}

export function memoryExtractionCandidateIdentity(
  candidate: MemoryExtractionCandidate,
): string {
  const value = normalizeMemoryExtractionCandidate(candidate);
  return JSON.stringify({
    scope: value.scope,
    kind: value.kind,
    content: normalizeMemoryDedupeContent(value.content),
    summary: value.summary,
    confidence: value.confidence,
    source: value.source,
    proposal: value.proposal,
    sensitiveFindings: value.sensitiveFindings,
    metadata: value.metadata,
  });
}

export function createMemoryExtractionDecision(
  input: MemoryExtractionDecisionInput,
  now: Date | string = new Date(),
): MemoryExtractionDecision {
  return normalizeDecision({
    decision: input.decision,
    decidedBy: input.decidedBy,
    decidedAt: now,
    reason: input.reason,
  });
}

export function normalizeMemoryExtractionAuditEvent(
  value: unknown,
): MemoryExtractionAuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError("extraction audit event must be an object");
  }
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || !auditTypes.has(event.type)) {
    throw new MemoryContractError(
      `Unknown extraction audit type: ${String(event.type)}`,
      "invalid_item",
      "audit.type",
    );
  }
  const reviewer = event.reviewer === undefined
    ? undefined
    : normalizeReviewer(event.reviewer);
  const reason = optionalText(
    event.reason,
    "audit.reason",
    MAX_REASON_CHARACTERS,
  );
  const memoryId = optionalText(
    event.memoryId,
    "audit.memoryId",
    MAX_REFERENCE_CHARACTERS,
  );
  if (event.type === "proposed" && (reviewer || reason || memoryId)) {
    throw new MemoryContractError(
      "proposed audit events cannot contain decision fields",
      "invalid_item",
      "audit",
    );
  }
  if (
    (event.type === "approved" || event.type === "rejected")
    && !reviewer
  ) {
    throw new MemoryContractError(
      `${event.type} audit events require a reviewer`,
      "invalid_item",
      "audit.reviewer",
    );
  }
  if (
    (event.type === "approved" || event.type === "rejected")
    && memoryId
  ) {
    throw new MemoryContractError(
      `${event.type} audit events cannot contain memoryId`,
      "invalid_item",
      "audit.memoryId",
    );
  }
  if (event.type === "rejected" && !reason) {
    throw new MemoryContractError(
      "rejected audit events require a reason",
      "invalid_item",
      "audit.reason",
    );
  }
  if (event.type === "applied" && !memoryId) {
    throw new MemoryContractError(
      "applied audit events require memoryId",
      "invalid_item",
      "audit.memoryId",
    );
  }
  if (event.type === "applied" && (reviewer || reason)) {
    throw new MemoryContractError(
      "applied audit events cannot contain decision fields",
      "invalid_item",
      "audit",
    );
  }
  return Object.freeze({
    id: requiredText(event.id, "audit.id", 256),
    candidateId: requiredText(
      event.candidateId,
      "audit.candidateId",
      256,
    ),
    type: event.type as MemoryExtractionAuditType,
    at: timestamp(event.at, "audit.at"),
    ...(reviewer ? { reviewer } : {}),
    ...(reason ? { reason } : {}),
    ...(memoryId ? { memoryId } : {}),
  });
}
