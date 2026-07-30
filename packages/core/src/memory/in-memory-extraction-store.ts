import { nanoid } from "nanoid";
import {
  createMemoryExtractionDecision,
  memoryExtractionCandidateIdentity,
  normalizeMemoryExtractionAuditEvent,
  normalizeMemoryExtractionCandidate,
  type MemoryExtractionApplyInput,
  type MemoryExtractionAuditEvent,
  type MemoryExtractionCandidate,
  type MemoryExtractionCandidateStore,
  type MemoryExtractionDecisionInput,
  type MemoryExtractionListQuery,
  type MemoryExtractionProposeResult,
  type MemoryExtractionSnapshotNamespace,
  type MemoryExtractionStatus,
  type MemoryExtractionStoreContext,
  type MemoryExtractionStoreSnapshot,
} from "./extraction.js";
import { MemoryContractError } from "./errors.js";
import {
  canAccessMemoryScope,
  memoryScopeKey,
  normalizeMemoryScope,
} from "./scope.js";
import {
  MemoryAuthorizationError,
  MemoryConflictError,
} from "./store-errors.js";

interface NamespaceState {
  readonly candidates: Map<string, MemoryExtractionCandidate>;
  readonly idempotency: Map<string, string>;
  readonly audit: MemoryExtractionAuditEvent[];
}

export interface InMemoryMemoryExtractionStoreOptions {
  readonly snapshot?: MemoryExtractionStoreSnapshot;
  readonly createAuditId?: () => string;
  readonly now?: () => Date | string;
}

function namespace(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryContractError(
      "Memory extraction namespace is required",
      "invalid_scope",
      "namespace",
    );
  }
  return value.trim();
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MemoryContractError(
      "Memory extraction time must be valid",
      "invalid_item",
      "now",
    );
  }
  return date.toISOString();
}

function cloneCandidate(
  value: MemoryExtractionCandidate,
): MemoryExtractionCandidate {
  return normalizeMemoryExtractionCandidate(value);
}

function cloneAudit(
  value: MemoryExtractionAuditEvent,
): MemoryExtractionAuditEvent {
  return normalizeMemoryExtractionAuditEvent(value);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new MemoryContractError(
      "Memory extraction limit must be between 1 and 1000",
      "invalid_item",
      "limit",
    );
  }
  return value;
}

function assertAuditConsistency(
  candidate: MemoryExtractionCandidate,
  events: readonly MemoryExtractionAuditEvent[],
): void {
  const expected = candidate.status === "pending"
    ? ["proposed"]
    : candidate.status === "approved"
      ? ["proposed", "approved"]
      : candidate.status === "rejected"
        ? ["proposed", "rejected"]
        : ["proposed", "approved", "applied"];
  if (
    events.length !== expected.length
    || events.some((event, index) => event.type !== expected[index])
  ) {
    throw new MemoryContractError(
      `Memory extraction audit is inconsistent for candidate "${candidate.id}"`,
    );
  }
  for (let index = 1; index < events.length; index += 1) {
    if (Date.parse(events[index].at) < Date.parse(events[index - 1].at)) {
      throw new MemoryContractError(
        `Memory extraction audit is out of order for candidate "${candidate.id}"`,
      );
    }
  }
  const decisionEvent = events.find(
    (event) => event.type === "approved" || event.type === "rejected",
  );
  if (
    candidate.decision
    && (
      !decisionEvent
      || decisionEvent.type
        !== (candidate.decision.decision === "approve" ? "approved" : "rejected")
      || decisionEvent.reviewer?.actor !== candidate.decision.decidedBy.actor
      || decisionEvent.reviewer?.actorId !== candidate.decision.decidedBy.actorId
      || decisionEvent.reason !== candidate.decision.reason
      || decisionEvent.at !== candidate.decision.decidedAt
    )
  ) {
    throw new MemoryContractError(
      `Memory extraction decision audit is inconsistent for candidate "${candidate.id}"`,
    );
  }
  const appliedEvent = events.find((event) => event.type === "applied");
  if (
    candidate.status === "applied"
    && (
      !appliedEvent
      || appliedEvent.memoryId !== candidate.appliedMemoryId
      || appliedEvent.at !== candidate.appliedAt
    )
  ) {
    throw new MemoryContractError(
      `Memory extraction application audit is inconsistent for candidate "${candidate.id}"`,
    );
  }
}

export class InMemoryMemoryExtractionStore
implements MemoryExtractionCandidateStore {
  private readonly namespaces = new Map<string, NamespaceState>();
  private readonly auditIds = new Set<string>();
  private readonly createAuditId: () => string;
  private readonly now: () => Date | string;

  constructor(options: InMemoryMemoryExtractionStoreOptions = {}) {
    this.createAuditId = options.createAuditId
      ?? (() => `memory-audit-${nanoid(16)}`);
    this.now = options.now ?? (() => new Date());
    if (options.snapshot) this.restore(options.snapshot);
  }

  private state(context: MemoryExtractionStoreContext): NamespaceState {
    const key = namespace(context.namespace);
    let state = this.namespaces.get(key);
    if (!state) {
      state = {
        candidates: new Map(),
        idempotency: new Map(),
        audit: [],
      };
      this.namespaces.set(key, state);
    }
    return state;
  }

  private existingState(
    context: MemoryExtractionStoreContext,
  ): NamespaceState | undefined {
    return this.namespaces.get(namespace(context.namespace));
  }

  private authorize(
    candidate: MemoryExtractionCandidate,
    context: MemoryExtractionStoreContext,
  ): void {
    if (!canAccessMemoryScope(candidate.scope, context.access)) {
      throw new MemoryAuthorizationError(
        "Memory extraction scope is not authorized",
      );
    }
  }

  private requiredCandidate(
    id: string,
    context: MemoryExtractionStoreContext,
  ): {
    readonly state: NamespaceState;
    readonly candidate: MemoryExtractionCandidate;
  } {
    const candidateId = typeof id === "string" ? id.trim() : "";
    if (!candidateId) {
      throw new MemoryContractError(
        "Memory extraction candidate id is required",
        "invalid_item",
        "id",
      );
    }
    const state = this.existingState(context);
    const candidate = state?.candidates.get(candidateId);
    if (!state || !candidate) {
      throw new MemoryConflictError("Memory extraction candidate was not found");
    }
    this.authorize(candidate, context);
    return { state, candidate };
  }

  private assertRevision(
    candidate: MemoryExtractionCandidate,
    expectedRevision: number | undefined,
  ): void {
    if (
      expectedRevision !== undefined
      && (
        !Number.isSafeInteger(expectedRevision)
        || expectedRevision < 1
        || candidate.revision !== expectedRevision
      )
    ) {
      throw new MemoryConflictError(
        "Memory extraction candidate changed; retry the decision",
      );
    }
  }

  private auditEvent(
    candidateId: string,
    input: Omit<MemoryExtractionAuditEvent, "id" | "candidateId" | "at">,
    at: Date | string = this.now(),
  ): MemoryExtractionAuditEvent {
    return normalizeMemoryExtractionAuditEvent({
      id: this.createAuditId(),
      candidateId,
      at,
      ...input,
    });
  }

  private appendAudit(
    state: NamespaceState,
    event: MemoryExtractionAuditEvent,
  ): void {
    if (this.auditIds.has(event.id)) {
      throw new MemoryConflictError(
        `Duplicate Memory extraction audit event "${event.id}"`,
      );
    }
    this.auditIds.add(event.id);
    state.audit.push(event);
  }

  private idempotencyIndexKey(
    candidate: MemoryExtractionCandidate,
  ): string {
    return JSON.stringify([
      memoryScopeKey(candidate.scope),
      candidate.idempotencyKey,
    ]);
  }

  async propose(
    input: MemoryExtractionCandidate,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionProposeResult> {
    const candidate = normalizeMemoryExtractionCandidate(input);
    if (candidate.status !== "pending" || candidate.revision !== 1) {
      throw new MemoryConflictError(
        "Only new pending extraction candidates can be proposed",
      );
    }
    this.authorize(candidate, context);
    const state = this.state(context);
    const idempotencyKey = this.idempotencyIndexKey(candidate);
    const existingId = state.idempotency.get(idempotencyKey);
    if (existingId) {
      const existing = state.candidates.get(existingId);
      if (!existing) {
        throw new MemoryContractError(
          "Memory extraction idempotency index is corrupted",
        );
      }
      if (
        memoryExtractionCandidateIdentity(existing)
        !== memoryExtractionCandidateIdentity(candidate)
      ) {
        throw new MemoryConflictError(
          "Memory extraction idempotency key was reused for different content",
        );
      }
      return Object.freeze({
        candidate: cloneCandidate(existing),
        created: false,
      });
    }
    if (state.candidates.has(candidate.id)) {
      throw new MemoryConflictError(
        `Duplicate Memory extraction candidate "${candidate.id}"`,
      );
    }
    const audit = this.auditEvent(candidate.id, { type: "proposed" });
    if (this.auditIds.has(audit.id)) {
      throw new MemoryConflictError(
        `Duplicate Memory extraction audit event "${audit.id}"`,
      );
    }
    state.candidates.set(candidate.id, candidate);
    state.idempotency.set(idempotencyKey, candidate.id);
    this.appendAudit(state, audit);
    return Object.freeze({
      candidate: cloneCandidate(candidate),
      created: true,
    });
  }

  async get(
    id: string,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate | undefined> {
    const candidateId = typeof id === "string" ? id.trim() : "";
    if (!candidateId) {
      throw new MemoryContractError(
        "Memory extraction candidate id is required",
        "invalid_item",
        "id",
      );
    }
    const candidate = this.existingState(context)?.candidates.get(candidateId);
    if (!candidate) return undefined;
    this.authorize(candidate, context);
    return cloneCandidate(candidate);
  }

  async list(
    query: MemoryExtractionListQuery,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate[]> {
    const limit = boundedLimit(query.limit);
    const requestedScope = query.scope
      ? normalizeMemoryScope(query.scope)
      : undefined;
    if (
      requestedScope
      && !canAccessMemoryScope(requestedScope, context.access)
    ) {
      throw new MemoryAuthorizationError(
        "Memory extraction scope is not authorized",
      );
    }
    const statuses = query.statuses
      ? new Set<MemoryExtractionStatus>(query.statuses)
      : undefined;
    if (
      statuses
      && [...statuses].some((status) =>
        !["pending", "approved", "rejected", "applied"].includes(status)
      )
    ) {
      throw new MemoryContractError(
        "Unknown Memory extraction status",
        "invalid_item",
        "statuses",
      );
    }
    const result: MemoryExtractionCandidate[] = [];
    for (const candidate of this.existingState(context)?.candidates.values() ?? []) {
      if (!canAccessMemoryScope(candidate.scope, context.access)) continue;
      if (
        requestedScope
        && memoryScopeKey(candidate.scope) !== memoryScopeKey(requestedScope)
      ) continue;
      if (statuses && !statuses.has(candidate.status)) continue;
      result.push(cloneCandidate(candidate));
    }
    return result
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || left.id.localeCompare(right.id)
      )
      .slice(0, limit);
  }

  async decide(
    id: string,
    input: MemoryExtractionDecisionInput,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate> {
    const { state, candidate } = this.requiredCandidate(id, context);
    this.assertRevision(candidate, input.expectedRevision);
    if (candidate.status !== "pending") {
      throw new MemoryConflictError(
        "Only pending extraction candidates can be decided",
      );
    }
    const decidedAt = timestamp(this.now());
    const decision = createMemoryExtractionDecision(input, decidedAt);
    const status = decision.decision === "approve" ? "approved" : "rejected";
    const updated = normalizeMemoryExtractionCandidate({
      ...candidate,
      status,
      revision: candidate.revision + 1,
      decision,
      updatedAt: decidedAt,
    });
    const audit = this.auditEvent(candidate.id, {
      type: status,
      reviewer: decision.decidedBy,
      ...(decision.reason ? { reason: decision.reason } : {}),
    }, decidedAt);
    if (this.auditIds.has(audit.id)) {
      throw new MemoryConflictError(
        `Duplicate Memory extraction audit event "${audit.id}"`,
      );
    }
    state.candidates.set(candidate.id, updated);
    this.appendAudit(state, audit);
    return cloneCandidate(updated);
  }

  async markApplied(
    id: string,
    input: MemoryExtractionApplyInput,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionCandidate> {
    const { state, candidate } = this.requiredCandidate(id, context);
    this.assertRevision(candidate, input.expectedRevision);
    if (candidate.status !== "approved") {
      throw new MemoryConflictError(
        "Only approved extraction candidates can be applied",
      );
    }
    const memoryId = typeof input.memoryId === "string"
      ? input.memoryId.trim()
      : "";
    if (!memoryId || memoryId.length > 512) {
      throw new MemoryContractError(
        "Applied Memory id is required",
        "invalid_item",
        "memoryId",
      );
    }
    const appliedAt = timestamp(this.now());
    const updated = normalizeMemoryExtractionCandidate({
      ...candidate,
      status: "applied",
      revision: candidate.revision + 1,
      appliedMemoryId: memoryId,
      appliedAt,
      updatedAt: appliedAt,
    });
    const audit = this.auditEvent(candidate.id, {
      type: "applied",
      memoryId,
    }, appliedAt);
    if (this.auditIds.has(audit.id)) {
      throw new MemoryConflictError(
        `Duplicate Memory extraction audit event "${audit.id}"`,
      );
    }
    state.candidates.set(candidate.id, updated);
    this.appendAudit(state, audit);
    return cloneCandidate(updated);
  }

  async listAudit(
    candidateId: string,
    context: MemoryExtractionStoreContext,
  ): Promise<MemoryExtractionAuditEvent[]> {
    const { state, candidate } = this.requiredCandidate(candidateId, context);
    this.authorize(candidate, context);
    return state.audit
      .filter((event) => event.candidateId === candidate.id)
      .map(cloneAudit);
  }

  snapshot(): MemoryExtractionStoreSnapshot {
    const namespaces: MemoryExtractionSnapshotNamespace[] = [];
    for (const [key, state] of [...this.namespaces].sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      namespaces.push(Object.freeze({
        namespace: key,
        candidates: Object.freeze(
          [...state.candidates.values()]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(cloneCandidate),
        ),
        audit: Object.freeze(state.audit.map(cloneAudit)),
      }));
    }
    return Object.freeze({
      version: 1,
      namespaces: Object.freeze(namespaces),
    });
  }

  private restore(snapshot: MemoryExtractionStoreSnapshot): void {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.namespaces)) {
      throw new MemoryContractError(
        "Unsupported Memory extraction snapshot",
      );
    }
    const next = new Map<string, NamespaceState>();
    const auditIds = new Set<string>();
    for (const entry of snapshot.namespaces) {
      const key = namespace(entry.namespace);
      if (next.has(key)) {
        throw new MemoryConflictError(
          `Duplicate Memory extraction namespace "${key}"`,
        );
      }
      if (!Array.isArray(entry.candidates) || !Array.isArray(entry.audit)) {
        throw new MemoryContractError(
          "Invalid Memory extraction snapshot namespace",
        );
      }
      const candidates = new Map<string, MemoryExtractionCandidate>();
      const idempotency = new Map<string, string>();
      for (const rawCandidate of entry.candidates) {
        const candidate = normalizeMemoryExtractionCandidate(rawCandidate);
        if (candidates.has(candidate.id)) {
          throw new MemoryConflictError(
            `Duplicate Memory extraction candidate "${candidate.id}"`,
          );
        }
        const idempotencyKey = this.idempotencyIndexKey(candidate);
        const previous = idempotency.get(idempotencyKey);
        if (previous) {
          throw new MemoryConflictError(
            `Duplicate Memory extraction idempotency key "${candidate.idempotencyKey}"`,
          );
        }
        candidates.set(candidate.id, candidate);
        idempotency.set(idempotencyKey, candidate.id);
      }
      const audit = entry.audit.map((rawEvent: unknown) => {
        const event = normalizeMemoryExtractionAuditEvent(rawEvent);
        if (auditIds.has(event.id)) {
          throw new MemoryConflictError(
            `Duplicate Memory extraction audit event "${event.id}"`,
          );
        }
        if (!candidates.has(event.candidateId)) {
          throw new MemoryContractError(
            `Memory extraction audit references missing candidate "${event.candidateId}"`,
          );
        }
        auditIds.add(event.id);
        return event;
      });
      for (const candidate of candidates.values()) {
        assertAuditConsistency(
          candidate,
          audit.filter(
            (event: MemoryExtractionAuditEvent) =>
              event.candidateId === candidate.id,
          ),
        );
      }
      next.set(key, { candidates, idempotency, audit });
    }
    this.namespaces.clear();
    this.auditIds.clear();
    for (const [key, state] of next) this.namespaces.set(key, state);
    for (const state of next.values()) {
      for (const event of state.audit) this.auditIds.add(event.id);
    }
  }
}
