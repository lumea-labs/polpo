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

export const MEMORY_LEARNING_MODES = [
  "off",
  "suggest",
  "automatic",
] as const;

export type MemoryLearningMode =
  (typeof MEMORY_LEARNING_MODES)[number];

export const MEMORY_LEARNING_SURFACES = [
  "chat",
  "channel",
] as const;

export type MemoryLearningSurface =
  (typeof MEMORY_LEARNING_SURFACES)[number];

export const DEFAULT_MEMORY_LEARNING_KINDS = [
  "fact",
  "preference",
  "open_thread",
  "style",
] as const satisfies readonly MemoryKind[];

export interface AgentMemoryLearningSettings {
  readonly mode?: MemoryLearningMode;
  readonly surfaces?: readonly MemoryLearningSurface[];
  readonly kinds?: readonly MemoryKind[];
}

export interface AgentMemorySettings {
  readonly tools?: AgentMemoryToolSettings;
  readonly learning?: AgentMemoryLearningSettings;
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
  readonly learning: {
    readonly mode: MemoryLearningMode;
    readonly surfaces: readonly MemoryLearningSurface[];
    readonly kinds: readonly MemoryKind[];
  };
}

const memoryKinds = new Set<string>(MEMORY_KINDS);
const writeScopes = new Set<string>(MEMORY_TOOL_WRITE_SCOPES);
const learningModes = new Set<string>(MEMORY_LEARNING_MODES);
const learningSurfaces = new Set<string>(MEMORY_LEARNING_SURFACES);

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
      learning: Object.freeze({
        mode: "off",
        surfaces: Object.freeze([...MEMORY_LEARNING_SURFACES]),
        kinds: Object.freeze([...DEFAULT_MEMORY_LEARNING_KINDS]),
      }),
    });
  }

  const memory = objectValue(value, "memory");
  rejectUnknownFields(memory, ["tools", "learning"], "memory");
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

  const rawLearning = memory.learning === undefined
    ? {}
    : objectValue(memory.learning, "memory.learning");
  rejectUnknownFields(
    rawLearning,
    ["mode", "surfaces", "kinds"],
    "memory.learning",
  );
  const mode = rawLearning.mode ?? "off";
  if (typeof mode !== "string" || !learningModes.has(mode)) {
    throw new TypeError("memory.learning.mode is invalid");
  }
  const surfaces = normalizedSelection(
    rawLearning.surfaces,
    MEMORY_LEARNING_SURFACES,
    learningSurfaces,
    "memory.learning.surfaces",
  ) as MemoryLearningSurface[];
  const learningKinds = normalizedSelection(
    rawLearning.kinds,
    DEFAULT_MEMORY_LEARNING_KINDS,
    memoryKinds,
    "memory.learning.kinds",
  ) as MemoryKind[];

  return Object.freeze({
    tools: Object.freeze({
      search,
      remember,
      update,
      forget,
      writeScope: writeScope as MemoryToolWriteScope,
      writableKinds: Object.freeze(writableKinds),
    }),
    learning: Object.freeze({
      mode: mode as MemoryLearningMode,
      surfaces: Object.freeze(surfaces),
      kinds: Object.freeze(learningKinds),
    }),
  });
}

function normalizedSelection(
  value: unknown,
  defaults: readonly string[],
  allowed: ReadonlySet<string>,
  path: string,
): string[] {
  if (value === undefined) return [...defaults];
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty array`);
  }
  const selected = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      throw new TypeError(`${path}[${index}] is invalid`);
    }
    selected.add(entry);
  }
  return defaults.filter((entry) => selected.has(entry));
}
