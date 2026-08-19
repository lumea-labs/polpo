export type ToolInvocationJsonPrimitive = string | number | boolean | null;
export type ToolInvocationJsonValue =
  | ToolInvocationJsonPrimitive
  | readonly ToolInvocationJsonValue[]
  | { readonly [key: string]: ToolInvocationJsonValue };

export type ToolInvocationSurface =
  | "chat"
  | "task"
  | "loop"
  | "schedule"
  | "channel";

export interface ToolInvocationScope {
  /** Host-owned partition key, such as an application workspace id. */
  readonly key: string;
  /** Optional host-owned epoch that rotates the partition without changing its key. */
  readonly version?: string;
}

const TOOL_INVOCATION_SURFACES = new Set<ToolInvocationSurface>([
  "chat",
  "task",
  "loop",
  "schedule",
  "channel",
]);

/** Immutable, host-owned identity for one tool-bearing runtime invocation. */
export interface ToolInvocationContext {
  readonly requestId: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly user?: string;
  readonly metadata: Readonly<Record<string, ToolInvocationJsonValue>>;
  readonly scope?: ToolInvocationScope;
  readonly surface: ToolInvocationSurface;
}

export interface ToolInvocationContextInput {
  requestId: string;
  runId: string;
  sessionId?: string;
  user?: string;
  metadata?: Record<string, ToolInvocationJsonValue>;
  scope?: ToolInvocationScope;
  surface: ToolInvocationSurface;
}

const MAX_SCOPE_KEY_LENGTH = 512;
const MAX_SCOPE_VERSION_LENGTH = 128;

function cloneInvocationJson(
  value: ToolInvocationJsonValue,
  seen: WeakSet<object>,
  path: string,
): ToolInvocationJsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Tool invocation context must contain JSON values: ${path} is not finite`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Tool invocation context must contain JSON values: ${path} is unsupported`);
  }
  if (seen.has(value)) {
    throw new TypeError(`Tool invocation context must contain JSON values: cyclic value at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item, index) =>
        cloneInvocationJson(item, seen, `${path}[${index}]`)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Tool invocation context must contain plain JSON objects: ${path}`);
    }
    const copy: Record<string, ToolInvocationJsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) {
        throw new TypeError(`Tool invocation context must contain JSON values: ${path}.${key} is undefined`);
      }
      copy[key] = cloneInvocationJson(nested, seen, `${path}.${key}`);
    }
    return Object.freeze(copy);
  } finally {
    seen.delete(value);
  }
}

function requiredInvocationId(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`Tool invocation ${name} must be a non-empty string`);
  return normalized;
}

function scopedText(name: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    throw new TypeError(`Tool invocation scope ${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(
      `Tool invocation scope ${name} must contain between 1 and ${maxLength} characters`,
    );
  }
  return normalized;
}

function normalizeInvocationScope(
  value: ToolInvocationScope | undefined,
): ToolInvocationScope | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Tool invocation scope must be an object");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "key" && key !== "version")) {
    throw new TypeError("Tool invocation scope contains unsupported fields");
  }
  return Object.freeze({
    key: scopedText("key", value.key, MAX_SCOPE_KEY_LENGTH),
    ...(value.version === undefined
      ? {}
      : {
          version: scopedText(
            "version",
            value.version,
            MAX_SCOPE_VERSION_LENGTH,
          ),
        }),
  });
}

/** Copy and deeply freeze host data before it crosses into tool code. */
export function createToolInvocationContext(
  input: ToolInvocationContextInput,
): ToolInvocationContext {
  if (!TOOL_INVOCATION_SURFACES.has(input.surface)) {
    throw new TypeError(`Tool invocation surface "${String(input.surface)}" is invalid`);
  }
  const metadata = cloneInvocationJson(
    input.metadata ?? {},
    new WeakSet(),
    "invocation.metadata",
  ) as Readonly<Record<string, ToolInvocationJsonValue>>;
  const scope = normalizeInvocationScope(input.scope);
  return Object.freeze({
    requestId: requiredInvocationId("requestId", input.requestId),
    runId: requiredInvocationId("runId", input.runId),
    ...(input.sessionId
      ? { sessionId: requiredInvocationId("sessionId", input.sessionId) }
      : {}),
    ...(input.user ? { user: requiredInvocationId("user", input.user) } : {}),
    metadata,
    ...(scope ? { scope } : {}),
    surface: input.surface,
  });
}
