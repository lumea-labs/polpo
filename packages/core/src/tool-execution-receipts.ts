export type ToolExecutionReceiptState =
  | "proposed"
  | "validated"
  | "approved"
  | "started"
  | "completed"
  | "failed"
  | "outcome-unknown";

export interface ToolExecutionReceipt {
  readonly callId: string;
  readonly toolName: string;
  readonly contractFingerprint: string;
  readonly argumentsFingerprint: string;
  readonly state: ToolExecutionReceiptState;
  readonly result?: string;
}

export type ToolExecutionReceiptClaim =
  | { readonly action: "execute"; readonly receipt: ToolExecutionReceipt }
  | { readonly action: "replay"; readonly receipt: ToolExecutionReceipt; readonly result: string }
  | { readonly action: "reject"; readonly receipt: ToolExecutionReceipt; readonly code: "tool_outcome_unknown" | "resume_contract_mismatch"; readonly message: string };

export interface ToolExecutionReceiptStore {
  claim(input: {
    callId: string;
    toolName: string;
    contractFingerprint: string;
    argumentsFingerprint: string;
  }): Promise<ToolExecutionReceiptClaim>;
  settle(input: {
    callId: string;
    state: "completed" | "failed" | "outcome-unknown";
    result?: string;
  }): Promise<ToolExecutionReceipt>;
}

export interface SettleToolExecutionReceiptOptions {
  /** Stops any additional commit attempt after the current one settles. */
  signal?: AbortSignal;
}

const TOOL_RECEIPT_SETTLEMENT_MAX_ATTEMPTS = 3;
const TOOL_RECEIPT_SETTLEMENT_RETRY_DELAYS_MS = [50, 150] as const;
const SQLSTATE_CAUSE_CODE = /^[0-9A-Z]{5}$/;
const SAFE_TRANSPORT_CAUSE_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Safe terminal error for a tool whose result exists but whose durable receipt
 * could not be confirmed. The original database error is retained as a
 * non-enumerable cause and must never be serialized into public Run events.
 */
export class ToolReceiptSettlementError extends Error {
  override readonly name = "ToolReceiptSettlementError";
  readonly code = "tool_receipt_settlement_failed";
  readonly operation = "tool_receipt_settle";
  readonly attempts: number;
  readonly causeCode?: string;

  constructor(attempts: number, cause: unknown) {
    super("Tool receipt settlement failed", { cause });
    this.attempts = attempts;
    const causeCode = safeCauseCode(cause);
    if (causeCode) this.causeCode = causeCode;
  }
}

/**
 * Confirm the same terminal receipt with bounded retries. A retry never claims
 * or executes the tool again. Atomic stores can therefore recover both a
 * failure before commit and a lost acknowledgement after commit.
 */
export async function settleToolExecutionReceiptWithRetry(
  store: ToolExecutionReceiptStore,
  input: Parameters<ToolExecutionReceiptStore["settle"]>[0],
  options: SettleToolExecutionReceiptOptions = {},
): Promise<ToolExecutionReceipt> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TOOL_RECEIPT_SETTLEMENT_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1 && options.signal?.aborted) {
      throw new ToolReceiptSettlementError(attempt - 1, lastError);
    }
    try {
      return await store.settle(input);
    } catch (error) {
      lastError = error;
      if (attempt === TOOL_RECEIPT_SETTLEMENT_MAX_ATTEMPTS || options.signal?.aborted) {
        throw new ToolReceiptSettlementError(attempt, error);
      }
      const shouldRetry = await waitForSettlementRetry(
        TOOL_RECEIPT_SETTLEMENT_RETRY_DELAYS_MS[attempt - 1]!,
        options.signal,
      );
      if (!shouldRetry) throw new ToolReceiptSettlementError(attempt, error);
    }
  }
  throw new ToolReceiptSettlementError(TOOL_RECEIPT_SETTLEMENT_MAX_ATTEMPTS, lastError);
}

function waitForSettlementRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (shouldRetry: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(shouldRetry);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(true), delayMs);
  });
}

function safeCauseCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    let code: unknown;
    try {
      code = candidate.code;
    } catch {
      // Diagnostic extraction must never replace the settlement failure.
    }
    if (
      typeof code === "string"
      && (SQLSTATE_CAUSE_CODE.test(code) || SAFE_TRANSPORT_CAUSE_CODES.has(code))
    ) {
      return code;
    }
    try {
      current = candidate.cause;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function hashText(value: string): string {
  // Deterministic 64-bit FNV-1a. The fingerprint is an opaque correlation key,
  // not a credential or authenticity primitive.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Tool arguments must contain finite numbers");
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Tool arguments must not be cyclic");
    seen.add(value);
    try {
      return `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(`Tool arguments contain unsupported ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError("Tool arguments must not be cyclic");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Tool arguments must contain only plain objects");
  }
  seen.add(value);
  try {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"));
    return `{${entries.map(([key, nested]) =>
      `${JSON.stringify(key)}:${canonicalJson(nested, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function toolArgumentsFingerprint(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): string {
  return hashText(`${toolName}:${canonicalJson(args)}`);
}

/** Request-local default. Hosts can supply a durable atomic store for resume. */
export class InMemoryToolExecutionReceiptStore implements ToolExecutionReceiptStore {
  readonly #receipts = new Map<string, ToolExecutionReceipt>();

  async claim(input: {
    callId: string;
    toolName: string;
    contractFingerprint: string;
    argumentsFingerprint: string;
  }): Promise<ToolExecutionReceiptClaim> {
    const existing = this.#receipts.get(input.callId);
    if (!existing) {
      const receipt: ToolExecutionReceipt = { ...input, state: "started" };
      this.#receipts.set(input.callId, receipt);
      return { action: "execute", receipt };
    }
    if (
      existing.toolName !== input.toolName
      || existing.contractFingerprint !== input.contractFingerprint
      || existing.argumentsFingerprint !== input.argumentsFingerprint
    ) {
      return {
        action: "reject",
        receipt: existing,
        code: "resume_contract_mismatch",
        message: `Tool call ${JSON.stringify(input.callId)} was reused with a different execution contract`,
      };
    }
    if ((existing.state === "completed" || existing.state === "failed") && existing.result !== undefined) {
      return { action: "replay", receipt: existing, result: existing.result };
    }
    return {
      action: "reject",
      receipt: existing,
      code: "tool_outcome_unknown",
      message: `Tool call ${JSON.stringify(input.callId)} already has state ${JSON.stringify(existing.state)} and cannot be replayed automatically`,
    };
  }

  async settle(input: {
    callId: string;
    state: "completed" | "failed" | "outcome-unknown";
    result?: string;
  }): Promise<ToolExecutionReceipt> {
    const existing = this.#receipts.get(input.callId);
    if (!existing) throw new Error(`Tool receipt ${JSON.stringify(input.callId)} does not exist`);
    const receipt: ToolExecutionReceipt = { ...existing, ...input };
    this.#receipts.set(input.callId, receipt);
    return receipt;
  }
}
