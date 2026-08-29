import {
  MEMORY_KINDS,
  type MemoryKind,
} from "./types.js";

export const MEMORY_TOOL_WRITE_SCOPES = [
  "invocation-user",
  "agent",
] as const;

export type MemoryToolWriteScope =
  (typeof MEMORY_TOOL_WRITE_SCOPES)[number];

export interface AgentMemoryToolSettings {
  readonly search?: boolean;
  readonly remember?: boolean;
  readonly update?: boolean;
  readonly forget?: boolean;
  readonly writeScope?: MemoryToolWriteScope;
  readonly writableKinds?: readonly MemoryKind[];
}

export interface AgentMemorySettings {
  readonly tools?: AgentMemoryToolSettings;
}

export interface NormalizedAgentMemoryToolSettings {
  readonly search: boolean;
  readonly remember: boolean;
  readonly update: boolean;
  readonly forget: boolean;
  readonly writeScope: MemoryToolWriteScope;
  readonly writableKinds: readonly MemoryKind[];
}

export interface NormalizedAgentMemorySettings {
  readonly tools: NormalizedAgentMemoryToolSettings;
}

const memoryKinds = new Set<string>(MEMORY_KINDS);
const writeScopes = new Set<string>(MEMORY_TOOL_WRITE_SCOPES);

function objectValue(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`${path}.${unknown} is not supported`);
}

function optionalBoolean(value: unknown, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

export function normalizeAgentMemorySettings(
  value: unknown,
): NormalizedAgentMemorySettings {
  if (value === undefined) {
    return Object.freeze({
      tools: Object.freeze({
        search: false,
        remember: false,
        update: false,
        forget: false,
        writeScope: "invocation-user",
        writableKinds: Object.freeze([]),
      }),
    });
  }

  const memory = objectValue(value, "memory");
  rejectUnknownFields(memory, ["tools"], "memory");
  const rawTools = memory.tools === undefined
    ? {}
    : objectValue(memory.tools, "memory.tools");
  rejectUnknownFields(rawTools, [
    "search",
    "remember",
    "update",
    "forget",
    "writeScope",
    "writableKinds",
  ], "memory.tools");

  const search = optionalBoolean(rawTools.search, "memory.tools.search");
  const remember = optionalBoolean(rawTools.remember, "memory.tools.remember");
  const update = optionalBoolean(rawTools.update, "memory.tools.update");
  const forget = optionalBoolean(rawTools.forget, "memory.tools.forget");
  const writeScope = rawTools.writeScope ?? "invocation-user";
  if (typeof writeScope !== "string" || !writeScopes.has(writeScope)) {
    throw new TypeError("memory.tools.writeScope is invalid");
  }

  if (rawTools.writableKinds !== undefined && !Array.isArray(rawTools.writableKinds)) {
    throw new TypeError("memory.tools.writableKinds must be an array");
  }
  const writableKinds: MemoryKind[] = [];
  for (const [index, kind] of (rawTools.writableKinds ?? []).entries()) {
    if (typeof kind !== "string" || !memoryKinds.has(kind)) {
      throw new TypeError(`memory.tools.writableKinds[${index}] is invalid`);
    }
    if (!writableKinds.includes(kind as MemoryKind)) {
      writableKinds.push(kind as MemoryKind);
    }
  }
  if ((remember || update || forget) && writableKinds.length === 0) {
    throw new TypeError(
      "memory.tools.writableKinds must contain at least one kind when writes are enabled",
    );
  }

  return Object.freeze({
    tools: Object.freeze({
      search,
      remember,
      update,
      forget,
      writeScope: writeScope as MemoryToolWriteScope,
      writableKinds: Object.freeze(writableKinds),
    }),
  });
}
