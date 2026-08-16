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
  readonly surface: ToolInvocationSurface;
}

export interface ToolInvocationContextInput {
  requestId: string;
  runId: string;
  sessionId?: string;
  user?: string;
  metadata?: Record<string, ToolInvocationJsonValue>;
  surface: ToolInvocationSurface;
}

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
  return Object.freeze({
    requestId: requiredInvocationId("requestId", input.requestId),
    runId: requiredInvocationId("runId", input.runId),
    ...(input.sessionId
      ? { sessionId: requiredInvocationId("sessionId", input.sessionId) }
      : {}),
    ...(input.user ? { user: requiredInvocationId("user", input.user) } : {}),
    metadata,
    surface: input.surface,
  });
}
