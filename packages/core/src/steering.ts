export const STEERING_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_STEERING_MAX_CONTENT_BYTES = 64 * 1024;
export const DEFAULT_STEERING_MAX_PENDING = 100;
export const DEFAULT_STEERING_MAX_SEEN_IDS = 2_048;
export const DEFAULT_STEERING_MAX_ATTACHMENTS = 16;

export type SteeringMode = "steer" | "follow_up";
export type SteeringDeliveryPolicy = "all" | "one-at-a-time";
export type SteeringAttachmentType = "image" | "audio" | "file";
export type SteeringAcceptance = "accept" | "reject" | "best_effort";
export type SteeringAdmission = "accepted" | "duplicate" | "rejected" | "too_late";
export type SteeringDelivery = "pending" | "delivered" | "too_late" | "cancelled" | "failed";
export type SteeringPolicySource = "node" | "loop" | "agent" | "project" | "platform";

export interface SteeringOutcomeBehavior {
  action: "reply" | "return";
  messages: Record<string, string>;
}

export interface SteeringPolicy {
  acceptance?: SteeringAcceptance;
  outcomes?: Partial<Record<"rejected" | "too_late", SteeringOutcomeBehavior>>;
}

export interface ResolvedSteeringPolicy {
  acceptance: SteeringAcceptance;
  source: SteeringPolicySource;
  outcomes?: SteeringPolicy["outcomes"];
}

export interface SteeringLocalizedResponse {
  action: "reply" | "return";
  text: string;
  locale: string;
}

export interface SteeringReceipt {
  version: 1;
  runId: string;
  messageId: string;
  mode: SteeringMode;
  acceptance: SteeringAcceptance;
  policySource: SteeringPolicySource;
  admission: SteeringAdmission;
  delivery: SteeringDelivery;
  locale?: string;
  selectedLocale?: string;
  response?: SteeringLocalizedResponse;
  admittedAt: string;
  deliveredAt?: string;
  settledAt?: string;
  reasonCode?: string;
}

export type SteeringJsonValue =
  | string
  | number
  | boolean
  | null
  | SteeringJsonValue[]
  | { [key: string]: SteeringJsonValue };

export interface SteeringAttachment {
  type: SteeringAttachmentType;
  url: string;
  mediaType?: string;
  name?: string;
}

export interface SteeringContent {
  text?: string;
  attachments?: SteeringAttachment[];
}

export interface SteeringMessageInput {
  id: string;
  mode: SteeringMode;
  locale?: string;
  content: SteeringContent;
  metadata?: Record<string, SteeringJsonValue>;
}

export interface SteeringMessage extends SteeringMessageInput {
  createdAt: string;
}

export interface SteeringQueueSnapshot {
  version: typeof STEERING_SNAPSHOT_VERSION;
  delivery: SteeringDeliveryPolicy;
  pending: SteeringMessage[];
  /** Recently accepted ids, including delivered messages, for retry idempotency. */
  seenIds: string[];
  /** Additive v1 receipt state. Older snapshots legitimately omit it. */
  receipts?: SteeringReceipt[];
  fingerprints?: Record<string, string>;
  policy?: ResolvedSteeringPolicy;
  aborted?: boolean;
  abortReason?: SteeringJsonValue;
}

export interface SteeringDrainOptions {
  /** Follow-ups become eligible only when the run would otherwise stop. */
  includeFollowUps: boolean;
}

export interface SteeringEnqueueResult {
  accepted: boolean;
  duplicate: boolean;
  message?: SteeringMessage;
  receipt: SteeringReceipt;
}

export interface SteeringController {
  readonly signal: AbortSignal;
  enqueue(input: SteeringMessageInput): SteeringEnqueueResult | Promise<SteeringEnqueueResult>;
  drain(options: SteeringDrainOptions): SteeringMessage[] | Promise<SteeringMessage[]>;
  hasPending(mode?: SteeringMode): boolean | Promise<boolean>;
  /**
   * Atomically close ingress when no message is pending. Returns false when
   * the caller must drain pending work before attempting to finish the run.
   */
  sealIfIdle(): boolean | Promise<boolean>;
  snapshot(): SteeringQueueSnapshot | Promise<SteeringQueueSnapshot>;
  /** Cooperative initial restore; callers retain ownership until it settles. */
  restore(snapshot: SteeringQueueSnapshot, context?: { signal: AbortSignal }): void | Promise<void>;
  bindRun(runId: string): void | Promise<void>;
  configure(policy: ResolvedSteeringPolicy): void | Promise<void>;
  setBoundary(input: { open: boolean; reservable: boolean }): void | Promise<void>;
  settle(messageIds: readonly string[], delivery: Exclude<SteeringDelivery, "pending">, reasonCode?: string): void | Promise<void>;
  settlePending(delivery: Exclude<SteeringDelivery, "pending">, reasonCode?: string): void | Promise<void>;
  getReceipt(messageId: string): SteeringReceipt | undefined | Promise<SteeringReceipt | undefined>;
  listReceipts(): SteeringReceipt[] | Promise<SteeringReceipt[]>;
  abort(reason?: SteeringJsonValue): void | Promise<void>;
  close(delivery?: Exclude<SteeringDelivery, "pending">, reasonCode?: string): void | Promise<void>;
}

export interface InMemorySteeringControllerOptions {
  delivery?: SteeringDeliveryPolicy;
  maxContentBytes?: number;
  maxPending?: number;
  maxSeenIds?: number;
  maxAttachments?: number;
  policy?: ResolvedSteeringPolicy;
  runId?: string;
  onReceipt?: (receipt: SteeringReceipt) => void;
  now?: () => Date;
}

export class SteeringValidationError extends Error {
  override readonly name = "SteeringValidationError";
}

export class SteeringClosedError extends Error {
  override readonly name = "SteeringClosedError";
}

export class SteeringQueueFullError extends Error {
  override readonly name = "SteeringQueueFullError";
}

export class SteeringRunNotFoundError extends Error {
  override readonly name = "SteeringRunNotFoundError";
}

export class SteeringRunConflictError extends Error {
  override readonly name = "SteeringRunConflictError";
}

export class SteeringAbortError extends Error {
  override readonly name = "SteeringAbortError";

  constructor(public readonly reason?: unknown) {
    super(typeof reason === "string" ? reason : "Run aborted through steering");
  }
}

function jsonClone<T>(value: T, field = "value"): T {
  const ancestors = new WeakSet<object>();
  const visit = (candidate: unknown, path: string): void => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new SteeringValidationError(`${path} must contain only finite numbers`);
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw new SteeringValidationError(`${path} must be JSON-serializable`);
    }
    if (ancestors.has(candidate)) {
      throw new SteeringValidationError(`${path} must not contain circular references`);
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
      throw new SteeringValidationError(`${path} must contain only JSON objects and arrays`);
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else {
      for (const [key, item] of Object.entries(candidate)) {
        visit(item, `${path}.${key}`);
      }
    }
    ancestors.delete(candidate);
  };

  visit(value, field);
  return JSON.parse(JSON.stringify(value)) as T;
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new SteeringValidationError("Steering content must be JSON-serializable");
  }
}

function validAttachmentUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "data:")
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function assertFinitePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new SteeringValidationError(`${field} must be a positive integer`);
  }
}

const DEFAULT_STEERING_OUTCOME_MESSAGES = {
  rejected: "This step cannot accept new instructions.",
  too_late: "The step had already finished.",
} as const;

export function normalizeSteeringLocale(locale: string): string {
  if (typeof locale !== "string") throw new SteeringValidationError("Steering locale must be a string");
  const candidate = locale.trim();
  if (!candidate || candidate.length > 35 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw new SteeringValidationError("Steering locale must be a valid BCP 47 language tag");
  }
  try {
    const [normalized] = Intl.getCanonicalLocales(candidate);
    if (!normalized) throw new Error("missing locale");
    return normalized;
  } catch {
    throw new SteeringValidationError("Steering locale must be a valid BCP 47 language tag");
  }
}

export function resolveSteeringOutcomeMessage(
  messages: Record<string, string>,
  requestedLocale: string | undefined,
  outcome: "rejected" | "too_late",
): { locale: string; text: string } {
  const entries = Object.entries(messages ?? {});
  if (entries.length > 32) throw new SteeringValidationError("Steering outcome messages support at most 32 locales");
  const normalized = new Map<string, string>();
  for (const [locale, text] of entries) {
    const key = normalizeSteeringLocale(locale);
    if (typeof text !== "string" || !text.trim() || text.length > 2_000) {
      throw new SteeringValidationError("Steering outcome messages must contain 1-2000 characters");
    }
    normalized.set(key, text);
  }
  const requested = requestedLocale ? normalizeSteeringLocale(requestedLocale) : "en";
  const primary = requested.split("-")[0]!;
  for (const candidate of [requested, primary, "en"]) {
    const text = normalized.get(candidate);
    if (text !== undefined) return { locale: candidate, text };
  }
  const first = normalized.entries().next().value as [string, string] | undefined;
  if (first) return { locale: first[0], text: first[1] };
  return { locale: "en", text: DEFAULT_STEERING_OUTCOME_MESSAGES[outcome] };
}

export function resolveSteeringPolicy(
  candidates: readonly { policy?: SteeringPolicy; source: SteeringPolicySource }[],
): ResolvedSteeringPolicy {
  const selected = candidates.find((candidate) => candidate.policy !== undefined);
  return normalizeResolvedSteeringPolicy(selected
    ? {
        acceptance: selected.policy?.acceptance ?? "best_effort",
        source: selected.source,
        ...(selected.policy?.outcomes ? { outcomes: selected.policy.outcomes } : {}),
      }
    : { acceptance: "best_effort", source: "platform" });
}

function normalizeResolvedSteeringPolicy(policy: ResolvedSteeringPolicy): ResolvedSteeringPolicy {
  if (!["accept", "reject", "best_effort"].includes(policy.acceptance)) {
    throw new SteeringValidationError("Steering acceptance must be accept, reject, or best_effort");
  }
  if (!["node", "loop", "agent", "project", "platform"].includes(policy.source)) {
    throw new SteeringValidationError("Steering policy source is invalid");
  }
  const outcomes: SteeringPolicy["outcomes"] = {};
  for (const outcome of ["rejected", "too_late"] as const) {
    const behavior = policy.outcomes?.[outcome];
    if (!behavior) continue;
    if (behavior.action !== "reply" && behavior.action !== "return") {
      throw new SteeringValidationError("Steering outcome action must be reply or return");
    }
    // Validate and canonicalize keys while retaining every configured message.
    const messages: Record<string, string> = {};
    for (const [locale, text] of Object.entries(behavior.messages ?? {})) {
      const normalizedLocale = normalizeSteeringLocale(locale);
      if (typeof text !== "string" || !text.trim() || text.length > 2_000) {
        throw new SteeringValidationError("Steering outcome messages must contain 1-2000 characters");
      }
      messages[normalizedLocale] = text;
    }
    if (Object.keys(messages).length > 32) {
      throw new SteeringValidationError("Steering outcome messages support at most 32 locales");
    }
    outcomes[outcome] = { action: behavior.action, messages };
  }
  return jsonClone({
    acceptance: policy.acceptance,
    source: policy.source,
    ...(Object.keys(outcomes).length > 0 ? { outcomes } : {}),
  });
}

function steeringMessageFingerprint(message: SteeringMessage): string {
  return JSON.stringify({
    id: message.id,
    mode: message.mode,
    locale: message.locale,
    content: message.content,
    metadata: message.metadata,
  });
}

function normalizeSteeringReceipts(receipts: SteeringReceipt[], runId: string): SteeringReceipt[] {
  if (!Array.isArray(receipts)) throw new SteeringValidationError("Malformed steering snapshot receipts");
  return receipts.map((receipt) => {
    if (!receipt || receipt.version !== 1 || typeof receipt.messageId !== "string") {
      throw new SteeringValidationError("Malformed steering receipt");
    }
    if (!["accepted", "duplicate", "rejected", "too_late"].includes(receipt.admission)
      || !["pending", "delivered", "too_late", "cancelled", "failed"].includes(receipt.delivery)) {
      throw new SteeringValidationError("Malformed steering receipt state");
    }
    return jsonClone({ ...receipt, runId: receipt.runId === "unbound" ? runId : normalizeRunId(receipt.runId) });
  });
}

function normalizeSteeringFingerprints(input: Record<string, string>): Map<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SteeringValidationError("Malformed steering snapshot fingerprints");
  }
  const result = new Map<string, string>();
  for (const [id, fingerprint] of Object.entries(input)) {
    if (!id || typeof fingerprint !== "string") throw new SteeringValidationError("Malformed steering fingerprint");
    result.set(id, fingerprint);
  }
  return result;
}

export class InMemorySteeringController implements SteeringController {
  private readonly abortController = new AbortController();
  private readonly pending: SteeringMessage[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly receipts = new Map<string, SteeringReceipt>();
  private readonly fingerprints = new Map<string, string>();
  private readonly delivery: SteeringDeliveryPolicy;
  private readonly maxContentBytes: number;
  private readonly maxPending: number;
  private readonly maxSeenIds: number;
  private readonly maxAttachments: number;
  private readonly now: () => Date;
  private readonly onReceipt?: (receipt: SteeringReceipt) => void;
  private abortReason: SteeringJsonValue | undefined;
  private runId: string;
  private policy: ResolvedSteeringPolicy;
  private boundaryOpen = false;
  private boundaryReservable = false;
  private closed = false;

  constructor(options: InMemorySteeringControllerOptions = {}) {
    this.delivery = options.delivery ?? "all";
    this.maxContentBytes = options.maxContentBytes ?? DEFAULT_STEERING_MAX_CONTENT_BYTES;
    this.maxPending = options.maxPending ?? DEFAULT_STEERING_MAX_PENDING;
    this.maxSeenIds = options.maxSeenIds ?? DEFAULT_STEERING_MAX_SEEN_IDS;
    this.maxAttachments = options.maxAttachments ?? DEFAULT_STEERING_MAX_ATTACHMENTS;
    this.now = options.now ?? (() => new Date());
    this.runId = options.runId === undefined ? "unbound" : normalizeRunId(options.runId);
    this.policy = normalizeResolvedSteeringPolicy(options.policy ?? {
      acceptance: "best_effort",
      source: "platform",
    });
    this.onReceipt = options.onReceipt;

    assertFinitePositiveInteger(this.maxContentBytes, "maxContentBytes");
    assertFinitePositiveInteger(this.maxPending, "maxPending");
    assertFinitePositiveInteger(this.maxSeenIds, "maxSeenIds");
    assertFinitePositiveInteger(this.maxAttachments, "maxAttachments");
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  static fromSnapshot(
    snapshot: SteeringQueueSnapshot,
    options: Omit<InMemorySteeringControllerOptions, "delivery"> = {},
  ): InMemorySteeringController {
    const controller = new InMemorySteeringController({ ...options, delivery: snapshot.delivery });
    controller.restore(snapshot);
    return controller;
  }

  enqueue(input: SteeringMessageInput): SteeringEnqueueResult {
    if (this.closed) throw new SteeringClosedError("Steering controller is closed");
    if (this.signal.aborted) throw new SteeringAbortError(this.signal.reason);
    if (!input || typeof input !== "object") {
      throw new SteeringValidationError("Steering message must be an object");
    }
    if (typeof input.id !== "string") {
      throw new SteeringValidationError("Steering message id must be a string");
    }
    const message = this.normalizeMessage(input);
    const fingerprint = steeringMessageFingerprint(message);
    if (this.seen.has(message.id)) {
      const existingFingerprint = this.fingerprints.get(message.id);
      if (existingFingerprint !== undefined && existingFingerprint !== fingerprint) {
        throw new SteeringValidationError(`Steering message id "${message.id}" was already used with different content`);
      }
      const existing = this.receipts.get(message.id);
      if (!existing) {
        throw new SteeringValidationError(`Steering message id "${message.id}" has no recoverable receipt`);
      }
      return {
        accepted: false,
        duplicate: true,
        receipt: jsonClone({ ...existing, admission: "duplicate" as const }),
      };
    }

    const immediate = this.immediateAdmission(message);
    if (immediate) {
      this.remember(message.id);
      this.fingerprints.set(message.id, fingerprint);
      this.recordReceipt(immediate);
      return {
        accepted: false,
        duplicate: false,
        message: jsonClone(message),
        receipt: jsonClone(immediate),
      };
    }
    if (this.pending.length >= this.maxPending) {
      throw new SteeringQueueFullError(`Steering queue is full (max ${this.maxPending})`);
    }

    this.pending.push(message);
    this.remember(message.id);
    this.fingerprints.set(message.id, fingerprint);
    const admittedAt = this.now().toISOString();
    const receipt: SteeringReceipt = {
      version: 1,
      runId: this.runId,
      messageId: message.id,
      mode: message.mode,
      acceptance: this.policy.acceptance,
      policySource: this.policy.source,
      admission: "accepted",
      delivery: "pending",
      ...(message.locale ? { locale: message.locale } : {}),
      admittedAt,
    };
    this.recordReceipt(receipt);
    return { accepted: true, duplicate: false, message: jsonClone(message), receipt: jsonClone(receipt) };
  }

  drain(options: SteeringDrainOptions): SteeringMessage[] {
    if (this.pending.length === 0) return [];
    const limit = this.delivery === "one-at-a-time" ? 1 : Number.POSITIVE_INFINITY;
    const delivered: SteeringMessage[] = [];
    const retained: SteeringMessage[] = [];

    for (const message of this.pending) {
      const eligible = message.mode === "steer" || options.includeFollowUps;
      if (eligible && delivered.length < limit) delivered.push(message);
      else retained.push(message);
    }

    this.pending.splice(0, this.pending.length, ...retained);
    return jsonClone(delivered);
  }

  hasPending(mode?: SteeringMode): boolean {
    return mode === undefined
      ? this.pending.length > 0
      : this.pending.some((message) => message.mode === mode);
  }

  sealIfIdle(): boolean {
    if (this.signal.aborted) throw new SteeringAbortError(this.signal.reason);
    if (this.pending.length > 0) return false;
    this.closed = true;
    this.boundaryOpen = false;
    this.boundaryReservable = false;
    return true;
  }

  snapshot(): SteeringQueueSnapshot {
    return jsonClone({
      version: STEERING_SNAPSHOT_VERSION,
      delivery: this.delivery,
      pending: this.pending,
      seenIds: this.seenOrder,
      receipts: [...this.receipts.values()],
      fingerprints: Object.fromEntries(this.fingerprints),
      policy: this.policy,
      ...(this.signal.aborted
        ? {
            aborted: true,
            ...(this.abortReason !== undefined ? { abortReason: this.abortReason } : {}),
          }
        : {}),
    });
  }

  restore(snapshot: SteeringQueueSnapshot): void {
    if (this.closed) throw new SteeringClosedError("Steering controller is closed");
    if (!snapshot || snapshot.version !== STEERING_SNAPSHOT_VERSION) {
      throw new SteeringValidationError("Unsupported steering snapshot version");
    }
    if (snapshot.delivery !== this.delivery) {
      throw new SteeringValidationError("Steering snapshot delivery policy does not match the controller");
    }
    if (!Array.isArray(snapshot.pending) || !Array.isArray(snapshot.seenIds)) {
      throw new SteeringValidationError("Malformed steering snapshot");
    }

    const seenIds: string[] = [];
    for (const id of snapshot.seenIds) {
      if (typeof id !== "string" || id.length === 0) {
        throw new SteeringValidationError("Malformed steering snapshot id");
      }
      seenIds.push(id);
    }
    if (snapshot.pending.length > this.maxPending) {
      throw new SteeringQueueFullError(`Steering snapshot exceeds max pending messages (${this.maxPending})`);
    }
    const pending: SteeringMessage[] = [];
    const pendingById = new Map<string, string>();
    for (const input of snapshot.pending) {
      const message = this.normalizeMessage(input);
      const serialized = JSON.stringify(message);
      const previous = pendingById.get(message.id);
      if (previous !== undefined && previous !== serialized) {
        throw new SteeringValidationError(`Steering snapshot contains conflicting message id "${message.id}"`);
      }
      if (previous === undefined) pending.push(message);
      pendingById.set(message.id, serialized);
    }
    const abortReason = snapshot.abortReason === undefined
      ? undefined
      : jsonClone(snapshot.abortReason, "abortReason");
    const receipts = normalizeSteeringReceipts(snapshot.receipts ?? [], this.runId);
    const fingerprints = snapshot.fingerprints === undefined
      ? new Map<string, string>()
      : normalizeSteeringFingerprints(snapshot.fingerprints);
    const policy = snapshot.policy === undefined
      ? this.policy
      : normalizeResolvedSteeringPolicy(snapshot.policy);

    const existingById = new Map(
      this.pending.map((message) => [message.id, JSON.stringify(message)]),
    );
    let additions = 0;
    for (const message of pending) {
      const existing = existingById.get(message.id);
      if (existing !== undefined && existing !== JSON.stringify(message)) {
        throw new SteeringValidationError(`Steering restore conflicts with existing message id "${message.id}"`);
      }
      if (existing === undefined) additions++;
    }
    if (this.pending.length + additions > this.maxPending) {
      throw new SteeringQueueFullError(`Steering snapshot exceeds max pending messages (${this.maxPending})`);
    }

    for (const id of seenIds) this.remember(id);
    for (const message of pending) {
      if (!existingById.has(message.id)) this.pending.push(message);
      this.remember(message.id);
    }
    for (const receipt of receipts) this.receipts.set(receipt.messageId, receipt);
    for (const [id, fingerprint] of fingerprints) this.fingerprints.set(id, fingerprint);
    for (const message of pending) {
      if (!this.fingerprints.has(message.id)) this.fingerprints.set(message.id, steeringMessageFingerprint(message));
      if (!this.receipts.has(message.id)) {
        this.receipts.set(message.id, {
          version: 1,
          runId: this.runId,
          messageId: message.id,
          mode: message.mode,
          acceptance: policy.acceptance,
          policySource: policy.source,
          admission: "accepted",
          delivery: "pending",
          ...(message.locale ? { locale: message.locale } : {}),
          admittedAt: message.createdAt,
        });
      }
    }
    this.policy = policy;
    if (snapshot.aborted) this.abort(abortReason);
  }

  bindRun(runId: string): void {
    const normalized = normalizeRunId(runId);
    if (this.runId !== "unbound" && this.runId !== normalized) {
      throw new SteeringRunConflictError(`Steering controller is already bound to run "${this.runId}"`);
    }
    this.runId = normalized;
    for (const [id, receipt] of this.receipts) {
      this.receipts.set(id, { ...receipt, runId: normalized });
    }
  }

  configure(policy: ResolvedSteeringPolicy): void {
    this.policy = normalizeResolvedSteeringPolicy(policy);
  }

  setBoundary(input: { open: boolean; reservable: boolean }): void {
    this.boundaryOpen = input.open && !this.closed && !this.signal.aborted;
    this.boundaryReservable = this.boundaryOpen && input.reservable;
  }

  settle(
    messageIds: readonly string[],
    delivery: Exclude<SteeringDelivery, "pending">,
    reasonCode?: string,
  ): void {
    const settledIds = new Set(messageIds);
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (settledIds.has(this.pending[index]!.id)) this.pending.splice(index, 1);
    }
    const now = this.now().toISOString();
    for (const messageId of messageIds) {
      const receipt = this.receipts.get(messageId);
      if (!receipt || receipt.delivery !== "pending") continue;
      const next: SteeringReceipt = {
        ...receipt,
        delivery,
        ...(delivery === "delivered" ? { deliveredAt: now } : {}),
        settledAt: now,
        ...(reasonCode ? { reasonCode } : {}),
        ...(delivery === "too_late" ? this.localizedResponse(receipt.locale, "too_late") : {}),
      };
      this.recordReceipt(next);
    }
    this.pruneSeen();
  }

  settlePending(delivery: Exclude<SteeringDelivery, "pending">, reasonCode?: string): void {
    const ids = this.pending.map((message) => message.id);
    this.pending.splice(0, this.pending.length);
    this.settle(ids, delivery, reasonCode);
  }

  getReceipt(messageId: string): SteeringReceipt | undefined {
    const receipt = this.receipts.get(messageId);
    return receipt ? jsonClone(receipt) : undefined;
  }

  listReceipts(): SteeringReceipt[] {
    return jsonClone([...this.receipts.values()]);
  }

  abort(reason?: SteeringJsonValue): void {
    if (!this.signal.aborted) {
      this.abortReason = reason === undefined
        ? "Run aborted through steering"
        : jsonClone(reason, "abortReason");
      this.abortController.abort(this.abortReason);
      this.boundaryOpen = false;
      this.boundaryReservable = false;
      this.settlePending("cancelled", "run_aborted");
    }
  }

  close(delivery: Exclude<SteeringDelivery, "pending"> = "too_late", reasonCode = "run_closed"): void {
    if (!this.closed) this.settlePending(delivery, reasonCode);
    this.closed = true;
    this.boundaryOpen = false;
    this.boundaryReservable = false;
  }

  private normalizeMessage(input: SteeringMessageInput | SteeringMessage): SteeringMessage {
    if (!input || typeof input !== "object") {
      throw new SteeringValidationError("Steering message must be an object");
    }
    if (typeof input.id !== "string") {
      throw new SteeringValidationError("Steering message id must be a string");
    }
    const id = input.id.trim();
    if (!id || id.length > 128) {
      throw new SteeringValidationError("Steering message id must contain 1-128 characters");
    }
    if (input.mode !== "steer" && input.mode !== "follow_up") {
      throw new SteeringValidationError('Steering mode must be "steer" or "follow_up"');
    }

    if (!input.content || typeof input.content !== "object" || Array.isArray(input.content)) {
      throw new SteeringValidationError("Steering content must be an object");
    }
    const text = input.content.text;
    const attachments = input.content.attachments ?? [];
    if (text !== undefined && typeof text !== "string") {
      throw new SteeringValidationError("Steering text must be a string");
    }
    if (!Array.isArray(attachments) || attachments.length > this.maxAttachments) {
      throw new SteeringValidationError(`Steering attachments must contain at most ${this.maxAttachments} items`);
    }
    if (!(text?.trim()) && attachments.length === 0) {
      throw new SteeringValidationError("Steering content must include text or an attachment");
    }

    for (const attachment of attachments) {
      if (!attachment || !["image", "audio", "file"].includes(attachment.type)) {
        throw new SteeringValidationError("Unsupported steering attachment type");
      }
      if (typeof attachment.url !== "string" || !validAttachmentUrl(attachment.url)) {
        throw new SteeringValidationError("Steering attachment URL must use https or data without credentials");
      }
      if (attachment.mediaType !== undefined && (
        typeof attachment.mediaType !== "string"
        || attachment.mediaType.length === 0
        || attachment.mediaType.length > 127
      )) {
        throw new SteeringValidationError("Steering attachment mediaType must contain 1-127 characters");
      }
      if (attachment.name !== undefined && (
        typeof attachment.name !== "string"
        || attachment.name.length === 0
        || attachment.name.length > 255
      )) {
        throw new SteeringValidationError("Steering attachment name must contain 1-255 characters");
      }
    }

    if (input.metadata !== undefined && (
      !input.metadata
      || typeof input.metadata !== "object"
      || Array.isArray(input.metadata)
    )) {
      throw new SteeringValidationError("Steering metadata must be a JSON object");
    }
    const metadata = input.metadata === undefined
      ? undefined
      : jsonClone(input.metadata, "metadata");
    const locale = input.locale === undefined ? undefined : normalizeSteeringLocale(input.locale);

    const content = jsonClone({
      ...(text !== undefined ? { text } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    if (byteLength({ content, metadata }) > this.maxContentBytes) {
      throw new SteeringValidationError(`Steering message exceeds ${this.maxContentBytes} bytes`);
    }

    const suppliedCreatedAt = "createdAt" in input ? input.createdAt : undefined;
    const createdAt = suppliedCreatedAt ?? this.now().toISOString();
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
      throw new SteeringValidationError("Steering createdAt must be an ISO timestamp");
    }

    return {
      id,
      mode: input.mode,
      ...(locale ? { locale } : {}),
      content,
      ...(metadata !== undefined ? { metadata } : {}),
      createdAt,
    };
  }

  private remember(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.seenOrder.push(id);
    this.pruneSeen(id);
  }

  private pruneSeen(protectedId?: string): void {
    while (this.seenOrder.length > this.maxSeenIds) {
      const index = this.seenOrder.findIndex((candidate) =>
        candidate !== protectedId
        && !this.pending.some((message) => message.id === candidate));
      if (index < 0) break;
      const [oldest] = this.seenOrder.splice(index, 1);
      if (oldest === undefined) break;
      this.seen.delete(oldest);
      this.fingerprints.delete(oldest);
      this.receipts.delete(oldest);
    }
  }

  private immediateAdmission(message: SteeringMessage): SteeringReceipt | undefined {
    let admission: "rejected" | "too_late" | undefined;
    let delivery: Exclude<SteeringDelivery, "pending"> | undefined;
    let reasonCode: string | undefined;
    if (this.policy.acceptance === "reject") {
      admission = "rejected";
      delivery = "cancelled";
      reasonCode = "policy_rejected";
    } else if (this.policy.acceptance === "accept" && (!this.boundaryOpen || !this.boundaryReservable)) {
      admission = "too_late";
      delivery = "too_late";
      reasonCode = "no_reservable_boundary";
    }
    if (!admission || !delivery) return undefined;
    const admittedAt = this.now().toISOString();
    return {
      version: 1,
      runId: this.runId,
      messageId: message.id,
      mode: message.mode,
      acceptance: this.policy.acceptance,
      policySource: this.policy.source,
      admission,
      delivery,
      ...(message.locale ? { locale: message.locale } : {}),
      admittedAt,
      settledAt: admittedAt,
      reasonCode,
      ...this.localizedResponse(message.locale, admission),
    };
  }

  private localizedResponse(
    locale: string | undefined,
    outcome: "rejected" | "too_late",
  ): Pick<SteeringReceipt, "selectedLocale" | "response"> {
    const behavior = this.policy.outcomes?.[outcome];
    if (!behavior) return {};
    const selected = resolveSteeringOutcomeMessage(behavior.messages, locale, outcome);
    return {
      selectedLocale: selected.locale,
      response: { action: behavior.action, text: selected.text, locale: selected.locale },
    };
  }

  private recordReceipt(receipt: SteeringReceipt): void {
    const stored = jsonClone(receipt);
    this.receipts.set(receipt.messageId, stored);
    try { this.onReceipt?.(jsonClone(stored)); } catch { /* observability cannot change steering */ }
  }
}

export function throwIfSteeringAborted(steering: Pick<SteeringController, "signal"> | undefined): void {
  if (steering?.signal.aborted) {
    throw new SteeringAbortError(steering.signal.reason);
  }
}

export interface SteeringRunRegistry {
  register(
    runId: string,
    controller: SteeringController,
  ): (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
  enqueue(runId: string, input: SteeringMessageInput): Promise<SteeringEnqueueResult>;
  getReceipt(runId: string, messageId: string): Promise<SteeringReceipt | undefined>;
  abort(runId: string, reason?: SteeringJsonValue): void | Promise<void>;
  has(runId: string): boolean | Promise<boolean>;
}

export interface InMemorySteeringRunRegistryOptions {
  maxActiveRuns?: number;
  maxArchivedReceipts?: number;
}

/**
 * Process-local active-run index for the single-process OSS host. Distributed
 * hosts can implement SteeringRunRegistry against their own durable command
 * transport without changing the route or runtime contracts.
 */
export class InMemorySteeringRunRegistry implements SteeringRunRegistry {
  private readonly controllers = new Map<string, SteeringController>();
  private readonly archivedReceipts = new Map<string, SteeringReceipt>();
  private readonly maxActiveRuns: number;
  private readonly maxArchivedReceipts: number;

  constructor(options: InMemorySteeringRunRegistryOptions = {}) {
    this.maxActiveRuns = options.maxActiveRuns ?? 10_000;
    this.maxArchivedReceipts = options.maxArchivedReceipts ?? 10_000;
    assertFinitePositiveInteger(this.maxActiveRuns, "maxActiveRuns");
    assertFinitePositiveInteger(this.maxArchivedReceipts, "maxArchivedReceipts");
  }

  async register(runId: string, controller: SteeringController): Promise<() => Promise<void>> {
    const id = normalizeRunId(runId);
    const existing = this.controllers.get(id);
    if (existing && existing !== controller) {
      throw new SteeringRunConflictError(`Steering run "${id}" is already registered`);
    }
    if (!existing && this.controllers.size >= this.maxActiveRuns) {
      throw new SteeringRunConflictError(`Steering registry is full (max ${this.maxActiveRuns})`);
    }
    await controller.bindRun(id);
    this.controllers.set(id, controller);

    return async () => {
      if (this.controllers.get(id) !== controller) return;
      const receipts = await controller.listReceipts();
      if (this.controllers.get(id) !== controller) return;
      for (const receipt of receipts) this.archive(receipt);
      this.controllers.delete(id);
    };
  }

  async enqueue(runId: string, input: SteeringMessageInput): Promise<SteeringEnqueueResult> {
    return await this.require(runId).enqueue(input);
  }

  async getReceipt(runId: string, messageId: string): Promise<SteeringReceipt | undefined> {
    const id = normalizeRunId(runId);
    if (typeof messageId !== "string" || !messageId.trim()) {
      throw new SteeringValidationError("Steering message id must contain 1-128 characters");
    }
    const controller = this.controllers.get(id);
    const active = controller ? await controller.getReceipt(messageId) : undefined;
    const receipt = active ?? this.archivedReceipts.get(`${id}\u0000${messageId}`);
    return receipt ? jsonClone(receipt) : undefined;
  }

  async abort(runId: string, reason?: SteeringJsonValue): Promise<void> {
    await this.require(runId).abort(reason);
  }

  has(runId: string): boolean {
    return this.controllers.has(normalizeRunId(runId));
  }

  private require(runId: string): SteeringController {
    const id = normalizeRunId(runId);
    const controller = this.controllers.get(id);
    if (!controller) throw new SteeringRunNotFoundError(`Active run "${id}" was not found`);
    return controller;
  }

  private archive(receipt: SteeringReceipt): void {
    const key = `${receipt.runId}\u0000${receipt.messageId}`;
    this.archivedReceipts.delete(key);
    this.archivedReceipts.set(key, jsonClone(receipt));
    while (this.archivedReceipts.size > this.maxArchivedReceipts) {
      const oldest = this.archivedReceipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.archivedReceipts.delete(oldest);
    }
  }
}

function normalizeRunId(runId: string): string {
  if (typeof runId !== "string") {
    throw new SteeringValidationError("Steering run id must be a string");
  }
  const id = runId.trim();
  if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new SteeringValidationError("Steering run id must contain 1-128 printable characters");
  }
  return id;
}
