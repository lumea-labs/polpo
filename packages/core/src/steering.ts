export const STEERING_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_STEERING_MAX_CONTENT_BYTES = 64 * 1024;
export const DEFAULT_STEERING_MAX_PENDING = 100;
export const DEFAULT_STEERING_MAX_SEEN_IDS = 2_048;
export const DEFAULT_STEERING_MAX_ATTACHMENTS = 16;

export type SteeringMode = "steer" | "follow_up";
export type SteeringDeliveryPolicy = "all" | "one-at-a-time";
export type SteeringAttachmentType = "image" | "audio" | "file";

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
  restore(snapshot: SteeringQueueSnapshot): void | Promise<void>;
  abort(reason?: SteeringJsonValue): void;
  close(): void;
}

export interface InMemorySteeringControllerOptions {
  delivery?: SteeringDeliveryPolicy;
  maxContentBytes?: number;
  maxPending?: number;
  maxSeenIds?: number;
  maxAttachments?: number;
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

export class InMemorySteeringController implements SteeringController {
  private readonly abortController = new AbortController();
  private readonly pending: SteeringMessage[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly delivery: SteeringDeliveryPolicy;
  private readonly maxContentBytes: number;
  private readonly maxPending: number;
  private readonly maxSeenIds: number;
  private readonly maxAttachments: number;
  private readonly now: () => Date;
  private abortReason: SteeringJsonValue | undefined;
  private closed = false;

  constructor(options: InMemorySteeringControllerOptions = {}) {
    this.delivery = options.delivery ?? "all";
    this.maxContentBytes = options.maxContentBytes ?? DEFAULT_STEERING_MAX_CONTENT_BYTES;
    this.maxPending = options.maxPending ?? DEFAULT_STEERING_MAX_PENDING;
    this.maxSeenIds = options.maxSeenIds ?? DEFAULT_STEERING_MAX_SEEN_IDS;
    this.maxAttachments = options.maxAttachments ?? DEFAULT_STEERING_MAX_ATTACHMENTS;
    this.now = options.now ?? (() => new Date());

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
    if (this.seen.has(message.id)) return { accepted: false, duplicate: true };
    if (this.pending.length >= this.maxPending) {
      throw new SteeringQueueFullError(`Steering queue is full (max ${this.maxPending})`);
    }

    this.pending.push(message);
    this.remember(message.id);
    return { accepted: true, duplicate: false, message: jsonClone(message) };
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
    return true;
  }

  snapshot(): SteeringQueueSnapshot {
    return jsonClone({
      version: STEERING_SNAPSHOT_VERSION,
      delivery: this.delivery,
      pending: this.pending,
      seenIds: this.seenOrder,
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
    if (snapshot.aborted) this.abort(abortReason);
  }

  abort(reason?: SteeringJsonValue): void {
    if (!this.signal.aborted) {
      this.abortReason = reason === undefined
        ? "Run aborted through steering"
        : jsonClone(reason, "abortReason");
      this.abortController.abort(this.abortReason);
    }
  }

  close(): void {
    this.closed = true;
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
      content,
      ...(metadata !== undefined ? { metadata } : {}),
      createdAt,
    };
  }

  private remember(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.maxSeenIds) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined && !this.pending.some((message) => message.id === oldest)) {
        this.seen.delete(oldest);
      }
    }
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
  abort(runId: string, reason?: SteeringJsonValue): void | Promise<void>;
  has(runId: string): boolean | Promise<boolean>;
}

export interface InMemorySteeringRunRegistryOptions {
  maxActiveRuns?: number;
}

/**
 * Process-local active-run index for the single-process OSS host. Distributed
 * hosts can implement SteeringRunRegistry against their own durable command
 * transport without changing the route or runtime contracts.
 */
export class InMemorySteeringRunRegistry implements SteeringRunRegistry {
  private readonly controllers = new Map<string, SteeringController>();
  private readonly maxActiveRuns: number;

  constructor(options: InMemorySteeringRunRegistryOptions = {}) {
    this.maxActiveRuns = options.maxActiveRuns ?? 10_000;
    assertFinitePositiveInteger(this.maxActiveRuns, "maxActiveRuns");
  }

  register(runId: string, controller: SteeringController): () => void {
    const id = normalizeRunId(runId);
    const existing = this.controllers.get(id);
    if (existing && existing !== controller) {
      throw new SteeringRunConflictError(`Steering run "${id}" is already registered`);
    }
    if (!existing && this.controllers.size >= this.maxActiveRuns) {
      throw new SteeringRunConflictError(`Steering registry is full (max ${this.maxActiveRuns})`);
    }
    this.controllers.set(id, controller);

    return () => {
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    };
  }

  async enqueue(runId: string, input: SteeringMessageInput): Promise<SteeringEnqueueResult> {
    return await this.require(runId).enqueue(input);
  }

  abort(runId: string, reason?: SteeringJsonValue): void {
    this.require(runId).abort(reason);
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
