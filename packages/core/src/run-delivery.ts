export const RUN_STREAM_EVENT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RUN_EVENT_PAGE_SIZE = 100;
export const MAX_RUN_EVENT_PAGE_SIZE = 1_000;
export const MAX_RUN_EVENT_BYTES = 256 * 1024;
export const MAX_RUN_EVENT_ID_LENGTH = 500;
export const MAX_RUN_ID_LENGTH = 200;
export const MAX_RUN_EVENT_TYPE_LENGTH = 200;

export type RunDisconnectPolicy = "cancel" | "continue";

export interface RunDeliveryPolicy {
  onDisconnect: RunDisconnectPolicy;
}

export type RunStreamEventType =
  | "run.accepted"
  | "run.started"
  | "run.cancelling"
  | "run.cancelled"
  | "run.completed"
  | "run.failed"
  | "output.text.delta"
  | "output.reasoning.delta"
  | "tool.started"
  | "tool.arguments"
  | "tool.completed"
  | "tool.failed"
  | "loop.step.started"
  | "loop.step.completed"
  | "loop.step.failed"
  | "interaction.ask_user"
  | "interaction.resumed"
  | "approval.requested"
  | "approval.resolved"
  | "outcome.registered"
  | "usage.completed";

export type RunEventJsonValue =
  | null
  | boolean
  | number
  | string
  | RunEventJsonValue[]
  | { [key: string]: RunEventJsonValue };

export interface RunStreamEvent<
  TData extends Record<string, RunEventJsonValue> = Record<string, RunEventJsonValue>,
> {
  id: string;
  runId: string;
  sequence: number;
  schemaVersion: typeof RUN_STREAM_EVENT_SCHEMA_VERSION;
  type: RunStreamEventType;
  data: TData;
  createdAt: string;
}

export interface AppendRunStreamEvent {
  /** Stable producer identity. Reusing it with different content is a conflict. */
  id?: string;
  type: RunStreamEventType;
  data: Record<string, RunEventJsonValue>;
  createdAt?: string;
}

export interface NormalizedRunStreamEventInput {
  id?: string;
  type: RunStreamEventType;
  data: Record<string, RunEventJsonValue>;
  createdAt: string;
  /** Generated timestamps are not part of producer retry identity. */
  createdAtExplicit: boolean;
}

export interface RunEventPage {
  events: RunStreamEvent[];
  nextCursor: string;
  hasMore: boolean;
}

export interface RunEventBounds {
  firstCursor: string;
  lastCursor: string;
  count: number;
}

export interface RunEventStore {
  append(runId: string, event: AppendRunStreamEvent): Promise<RunStreamEvent>;
  listAfter(runId: string, cursor?: string, limit?: number): Promise<RunEventPage>;
  bounds(runId: string): Promise<RunEventBounds | null>;
}

export interface RunExecutionLease {
  owner: string;
  token: string;
  expiresAt: string;
}

export interface RunExecutionLeaseStore {
  claim(runId: string, lease: RunExecutionLease): Promise<boolean>;
  renew(runId: string, lease: RunExecutionLease): Promise<boolean>;
  release(runId: string, lease: RunExecutionLease): Promise<boolean>;
  get(runId: string): Promise<RunExecutionLease | null>;
}

export class RunDeliveryValidationError extends Error {
  override readonly name: string = "RunDeliveryValidationError";
}

export class RunEventCursorError extends RunDeliveryValidationError {
  override readonly name = "RunEventCursorError";
}

export class RunEventConflictError extends Error {
  override readonly name = "RunEventConflictError";
}

export class RunExecutionLeaseValidationError extends RunDeliveryValidationError {
  override readonly name = "RunExecutionLeaseValidationError";
}

export function resolveRunDeliveryPolicy(input?: unknown): RunDeliveryPolicy {
  if (input === undefined) return { onDisconnect: "cancel" };
  if (!isPlainRecord(input)) {
    throw new RunDeliveryValidationError("Run delivery policy must be an object");
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "onDisconnect")) {
    throw new RunDeliveryValidationError("Run delivery policy contains unknown fields");
  }
  const onDisconnect = input.onDisconnect ?? "cancel";
  if (onDisconnect !== "cancel" && onDisconnect !== "continue") {
    throw new RunDeliveryValidationError(
      'Run delivery onDisconnect must be "cancel" or "continue"',
    );
  }
  return { onDisconnect };
}

/** Parse a run-scoped cursor. Empty means before the first event. */
export function parseRunEventCursor(cursor?: string): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new RunEventCursorError("Run event cursor must be a canonical non-negative integer");
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed)) {
    throw new RunEventCursorError("Run event cursor exceeds the supported range");
  }
  return parsed;
}

export function formatRunEventCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RunEventCursorError("Run event sequence must be a non-negative safe integer");
  }
  return String(sequence);
}

export function validateRunDeliveryRunId(runId: unknown): string {
  assertBoundedString(runId, "runId", MAX_RUN_ID_LENGTH);
  return runId;
}

export interface InMemoryRunEventStoreOptions {
  now?: () => Date;
  maxEventBytes?: number;
}

/** Reference store for conformance tests and ephemeral single-process runtimes. */
export class InMemoryRunEventStore implements RunEventStore {
  private readonly eventsByRun = new Map<string, RunStreamEvent[]>();
  private readonly eventsByProducerId = new Map<string, Map<string, RunStreamEvent>>();
  private readonly now: () => Date;
  private readonly maxEventBytes: number;

  constructor(options: InMemoryRunEventStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxEventBytes = options.maxEventBytes ?? MAX_RUN_EVENT_BYTES;
    assertPositiveInteger(this.maxEventBytes, "maxEventBytes");
  }

  async append(runId: string, input: AppendRunStreamEvent): Promise<RunStreamEvent> {
    const normalized = normalizeRunStreamEventInput(runId, input, { now: this.now });
    const existingById = this.eventsByProducerId.get(runId);
    if (normalized.id) {
      const existing = existingById?.get(normalized.id);
      if (existing) {
        if (!runStreamEventMatchesInput(existing, normalized)) {
          throw new RunEventConflictError(
            `Run event ${normalized.id} already exists with different content`,
          );
        }
        return cloneRunEvent(existing);
      }
    }

    const events = this.eventsByRun.get(runId) ?? [];
    const sequence = events.length === 0 ? 1 : events[events.length - 1]!.sequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new RunDeliveryValidationError("Run event sequence exceeds the supported range");
    }
    const event = materializeRunStreamEvent(runId, sequence, normalized, {
      maxEventBytes: this.maxEventBytes,
    });

    events.push(event);
    this.eventsByRun.set(runId, events);
    const byId = existingById ?? new Map<string, RunStreamEvent>();
    byId.set(event.id, event);
    this.eventsByProducerId.set(runId, byId);
    return cloneRunEvent(event);
  }

  async listAfter(
    runId: string,
    cursor?: string,
    limit = DEFAULT_RUN_EVENT_PAGE_SIZE,
  ): Promise<RunEventPage> {
    validateRunDeliveryRunId(runId);
    const sequence = parseRunEventCursor(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUN_EVENT_PAGE_SIZE) {
      throw new RunDeliveryValidationError(
        `Run event page limit must be between 1 and ${MAX_RUN_EVENT_PAGE_SIZE}`,
      );
    }
    const available = (this.eventsByRun.get(runId) ?? []).filter(
      (event) => event.sequence > sequence,
    );
    const selected = available.slice(0, limit);
    const lastSequence = selected.at(-1)?.sequence ?? sequence;
    return {
      events: selected.map(cloneRunEvent),
      nextCursor: formatRunEventCursor(lastSequence),
      hasMore: available.length > selected.length,
    };
  }

  async bounds(runId: string): Promise<RunEventBounds | null> {
    validateRunDeliveryRunId(runId);
    const events = this.eventsByRun.get(runId) ?? [];
    if (events.length === 0) return null;
    return {
      firstCursor: formatRunEventCursor(events[0]!.sequence),
      lastCursor: formatRunEventCursor(events[events.length - 1]!.sequence),
      count: events.length,
    };
  }
}

export interface InMemoryRunExecutionLeaseStoreOptions {
  now?: () => Date;
}

/** Compare-and-set reference lease store used by local runtimes and tests. */
export class InMemoryRunExecutionLeaseStore implements RunExecutionLeaseStore {
  private readonly leases = new Map<string, RunExecutionLease>();
  private readonly now: () => Date;

  constructor(options: InMemoryRunExecutionLeaseStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async claim(runId: string, input: RunExecutionLease): Promise<boolean> {
    const now = validNow(this.now);
    const lease = normalizeRunExecutionLease(runId, input, { now, requireFuture: true });
    const current = this.leases.get(runId);
    if (current && Date.parse(current.expiresAt) > now.getTime()) {
      return sameLease(current, lease);
    }
    this.leases.set(runId, lease);
    return true;
  }

  async renew(runId: string, input: RunExecutionLease): Promise<boolean> {
    const now = validNow(this.now);
    const lease = normalizeRunExecutionLease(runId, input, { now, requireFuture: true });
    const current = this.leases.get(runId);
    if (!current || Date.parse(current.expiresAt) <= now.getTime()) return false;
    if (current.owner !== lease.owner || current.token !== lease.token) return false;
    const currentExpiry = Date.parse(current.expiresAt);
    const nextExpiry = Date.parse(lease.expiresAt);
    if (nextExpiry < currentExpiry) {
      throw new RunExecutionLeaseValidationError("A run execution lease cannot be shortened");
    }
    this.leases.set(runId, lease);
    return true;
  }

  async release(runId: string, input: RunExecutionLease): Promise<boolean> {
    const lease = normalizeRunExecutionLease(runId, input, {
      now: validNow(this.now),
      requireFuture: false,
    });
    const current = this.leases.get(runId);
    if (!current || current.owner !== lease.owner || current.token !== lease.token) return false;
    this.leases.delete(runId);
    return true;
  }

  async get(runId: string): Promise<RunExecutionLease | null> {
    assertLeaseRunId(runId);
    const lease = this.leases.get(runId);
    return lease ? { ...lease } : null;
  }
}

function assertBoundedString(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new RunDeliveryValidationError(`${field} must be between 1 and ${max} characters`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RunDeliveryValidationError(`${field} must be a positive integer`);
  }
}

function validNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RunExecutionLeaseValidationError("Run execution lease clock returned an invalid date");
  }
  return value;
}

function assertLeaseRunId(runId: unknown): asserts runId is string {
  try {
    assertBoundedString(runId, "runId", MAX_RUN_ID_LENGTH);
  } catch (error) {
    throw new RunExecutionLeaseValidationError((error as Error).message);
  }
}

export interface NormalizeRunExecutionLeaseOptions {
  now?: Date;
  requireFuture?: boolean;
}

export function normalizeRunExecutionLease(
  runId: string,
  input: RunExecutionLease,
  options: NormalizeRunExecutionLeaseOptions = {},
): RunExecutionLease {
  assertLeaseRunId(runId);
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RunExecutionLeaseValidationError("Run execution lease clock returned an invalid date");
  }
  const requireFuture = options.requireFuture ?? true;
  if (!isPlainRecord(input)) {
    throw new RunExecutionLeaseValidationError("Run execution lease must be an object");
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "owner" && key !== "token" && key !== "expiresAt")) {
    throw new RunExecutionLeaseValidationError("Run execution lease contains unknown fields");
  }
  try {
    assertBoundedString(input.owner, "lease.owner", 500);
    assertBoundedString(input.token, "lease.token", 500);
  } catch (error) {
    throw new RunExecutionLeaseValidationError((error as Error).message);
  }
  if (typeof input.expiresAt !== "string" || input.expiresAt.length === 0) {
    throw new RunExecutionLeaseValidationError("lease.expiresAt must be a valid timestamp");
  }
  const expiresAt = new Date(input.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new RunExecutionLeaseValidationError("lease.expiresAt must be a valid timestamp");
  }
  if (requireFuture && expiresAt.getTime() <= now.getTime()) {
    throw new RunExecutionLeaseValidationError("lease.expiresAt must be in the future");
  }
  return {
    owner: input.owner,
    token: input.token,
    expiresAt: expiresAt.toISOString(),
  };
}

function sameLease(left: RunExecutionLease, right: RunExecutionLease): boolean {
  return left.owner === right.owner
    && left.token === right.token
    && left.expiresAt === right.expiresAt;
}

export interface NormalizeRunStreamEventOptions {
  now?: () => Date;
}

export function normalizeRunStreamEventInput(
  runId: string,
  input: AppendRunStreamEvent,
  options: NormalizeRunStreamEventOptions = {},
): NormalizedRunStreamEventInput {
  validateRunDeliveryRunId(runId);
  if (!isPlainRecord(input)) {
    throw new RunDeliveryValidationError("Run event must be an object");
  }
  assertBoundedString(input.type, "event.type", MAX_RUN_EVENT_TYPE_LENGTH);
  if (!isPlainRecord(input.data)) {
    throw new RunDeliveryValidationError("Run event data must be a JSON object");
  }
  if (input.id !== undefined) {
    assertBoundedString(input.id, "event.id", MAX_RUN_EVENT_ID_LENGTH);
  }
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    type: input.type,
    data: cloneJsonRecord(input.data, "event.data"),
    createdAt: normalizeTimestamp(input.createdAt, options.now ?? (() => new Date())),
    createdAtExplicit: input.createdAt !== undefined,
  };
}

export interface MaterializeRunStreamEventOptions {
  maxEventBytes?: number;
}

export function materializeRunStreamEvent(
  runId: string,
  sequence: number,
  input: NormalizedRunStreamEventInput,
  options: MaterializeRunStreamEventOptions = {},
): RunStreamEvent {
  validateRunDeliveryRunId(runId);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RunDeliveryValidationError("Run event sequence must be a positive safe integer");
  }
  const maxEventBytes = options.maxEventBytes ?? MAX_RUN_EVENT_BYTES;
  assertPositiveInteger(maxEventBytes, "maxEventBytes");
  const event: RunStreamEvent = {
    id: input.id ?? formatRunEventCursor(sequence),
    runId,
    sequence,
    schemaVersion: RUN_STREAM_EVENT_SCHEMA_VERSION,
    type: input.type,
    data: cloneJsonRecord(input.data, "event.data"),
    createdAt: input.createdAt,
  };
  const byteLength = new TextEncoder().encode(JSON.stringify(event)).byteLength;
  if (byteLength > maxEventBytes) {
    throw new RunDeliveryValidationError(
      `Run event exceeds maximum size of ${maxEventBytes} bytes`,
    );
  }
  return event;
}

export function runStreamEventMatchesInput(
  event: RunStreamEvent,
  input: NormalizedRunStreamEventInput,
): boolean {
  return canonicalJson({
    type: event.type,
    data: event.data,
    createdAt: event.createdAt,
  }) === canonicalJson({
    type: input.type,
    data: input.data,
    createdAt: input.createdAtExplicit ? input.createdAt : event.createdAt,
  });
}

function normalizeTimestamp(value: string | undefined, now: () => Date): string {
  const candidate = value ?? now().toISOString();
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new RunDeliveryValidationError("event.createdAt must be a valid timestamp");
  }
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RunDeliveryValidationError("event.createdAt must be a valid timestamp");
  }
  return parsed.toISOString();
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonRecord(
  value: Record<string, unknown>,
  path: string,
): Record<string, RunEventJsonValue> {
  return cloneJsonValue(value, path, new WeakSet()) as Record<string, RunEventJsonValue>;
}

function cloneJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): RunEventJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RunDeliveryValidationError(`${path} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new RunDeliveryValidationError(`${path} must be JSON-serializable`);
  }
  if (ancestors.has(value)) {
    throw new RunDeliveryValidationError(`${path} contains a circular reference`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        if (!(index in value)) {
          throw new RunDeliveryValidationError(`${path} contains a sparse array`);
        }
        return cloneJsonValue(item, `${path}[${index}]`, ancestors);
      });
    }
    if (!isPlainRecord(value)) {
      throw new RunDeliveryValidationError(`${path} contains a non-JSON object`);
    }
    const clone: Record<string, RunEventJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      clone[key] = cloneJsonValue(item, `${path}.${key}`, ancestors);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function cloneRunEvent(event: RunStreamEvent): RunStreamEvent {
  return {
    ...event,
    data: cloneJsonRecord(event.data, "event.data"),
  };
}
