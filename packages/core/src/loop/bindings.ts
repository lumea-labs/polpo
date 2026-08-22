import type { ContextBag } from "./types.js";

export const LOOP_CONTEXT_BINDING_KEY = "$context" as const;

export type LoopContextBindingErrorCode =
  | "loop_binding_invalid"
  | "loop_binding_missing"
  | "loop_context_readonly"
  | "loop_tool_input_invalid";

export interface LoopContextBinding {
  readonly $context: string;
}

export interface LoopContextBindingResolution {
  readonly inputPath: string;
  readonly contextPath: string;
}

export class LoopContextBindingError extends Error {
  readonly code: LoopContextBindingErrorCode;
  readonly contextPath?: string;
  readonly inputPath?: string;

  constructor(options: {
    code: LoopContextBindingErrorCode;
    message: string;
    contextPath?: string;
    inputPath?: string;
  }) {
    super(options.message);
    this.name = "LoopContextBindingError";
    this.code = options.code;
    this.contextPath = options.contextPath;
    this.inputPath = options.inputPath;
  }
}

export class LoopToolInputValidationError extends LoopContextBindingError {
  readonly tool: string;

  constructor(tool: string, message: string) {
    super({
      code: "loop_tool_input_invalid",
      message: `Invalid input for loop tool "${tool}": ${message}`,
    });
    this.name = "LoopToolInputValidationError";
    this.tool = tool;
  }
}

const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_BINDING_PATH_LENGTH = 512;
const MAX_BINDING_PATH_SEGMENTS = 64;
const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function childInputPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function assertJsonContainerProperties(value: object, inputPath: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalidBinding("input contains symbol keys", inputPath);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === "length" && Array.isArray(value)) continue;
    if ("get" in descriptor || "set" in descriptor) {
      invalidBinding("input contains accessor properties", childInputPath(inputPath, key));
    }
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        invalidBinding("input contains a sparse array", childInputPath(inputPath, index));
      }
    }
  }
}

function invalidBinding(message: string, inputPath: string, contextPath?: string): never {
  throw new LoopContextBindingError({
    code: "loop_binding_invalid",
    message: `Invalid loop context binding at ${inputPath}: ${message}`,
    inputPath,
    contextPath,
  });
}

function parseContextPath(path: string, inputPath: string): string[] {
  if (path.length === 0) invalidBinding("context path must not be empty", inputPath, path);
  if (path.length > MAX_BINDING_PATH_LENGTH) {
    invalidBinding(`context path exceeds ${MAX_BINDING_PATH_LENGTH} characters`, inputPath, path);
  }
  const parts = path.split(".");
  if (parts.length > MAX_BINDING_PATH_SEGMENTS) {
    invalidBinding(`context path exceeds ${MAX_BINDING_PATH_SEGMENTS} segments`, inputPath, path);
  }
  if (parts.some((part) => part.length === 0)) {
    invalidBinding("context path contains an empty segment", inputPath, path);
  }
  const unsafe = parts.find((part) => BLOCKED_PATH_SEGMENTS.has(part));
  if (unsafe) invalidBinding(`context path contains unsafe segment "${unsafe}"`, inputPath, path);
  return parts;
}

function readContextPath(context: Readonly<ContextBag>, path: string, inputPath: string): unknown {
  const parts = parseContextPath(path, inputPath);
  let cursor: unknown = context;
  for (const part of parts) {
    if ((typeof cursor !== "object" && typeof cursor !== "function") || cursor === null) {
      throw new LoopContextBindingError({
        code: "loop_binding_missing",
        message: `Loop context binding at ${inputPath} could not resolve "${path}"`,
        contextPath: path,
        inputPath,
      });
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) {
      throw new LoopContextBindingError({
        code: "loop_binding_missing",
        message: `Loop context binding at ${inputPath} could not resolve "${path}"`,
        contextPath: path,
        inputPath,
      });
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor === undefined) {
    throw new LoopContextBindingError({
      code: "loop_binding_missing",
      message: `Loop context binding at ${inputPath} resolved "${path}" to undefined`,
      contextPath: path,
      inputPath,
    });
  }
  return cursor;
}

/** Clone a value crossing from shared loop context into mutable tool input. */
export function cloneLoopJsonValue(value: unknown, inputPath = "$"): unknown {
  const visiting = new WeakSet<object>();
  let nodes = 0;

  const clone = (current: unknown, path: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES) invalidBinding(`input exceeds ${MAX_INPUT_NODES} values`, path);
    if (depth > MAX_INPUT_DEPTH) invalidBinding(`input exceeds depth ${MAX_INPUT_DEPTH}`, path);
    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalidBinding("bound value is not valid JSON", path);
      return current;
    }
    if (typeof current !== "object") invalidBinding("bound value is not valid JSON", path);
    if (!Array.isArray(current) && !isPlainRecord(current)) {
      invalidBinding("bound value must be a JSON object, array, or primitive", path);
    }
    assertJsonContainerProperties(current, path);
    if (visiting.has(current)) invalidBinding("input contains a circular value", path);
    visiting.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((child, index) => clone(child, childInputPath(path, index), depth + 1));
      }
      return Object.fromEntries(
        Object.entries(current).map(([key, child]) => [
          key,
          clone(child, childInputPath(path, key), depth + 1),
        ]),
      );
    } finally {
      visiting.delete(current);
    }
  };

  return clone(value, inputPath, 0);
}

/** Resolve exact `{ "$context": "a.b" }` markers anywhere in JSON tool input. */
export function resolveLoopInputBindings(
  input: unknown,
  context: Readonly<ContextBag>,
  onResolve?: (binding: LoopContextBindingResolution) => void,
): unknown {
  const visiting = new WeakSet<object>();
  let nodes = 0;

  const resolve = (current: unknown, inputPath: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES) invalidBinding(`input exceeds ${MAX_INPUT_NODES} values`, inputPath);
    if (depth > MAX_INPUT_DEPTH) invalidBinding(`input exceeds depth ${MAX_INPUT_DEPTH}`, inputPath);
    if (current === null || typeof current !== "object") return current;
    if (!Array.isArray(current) && !isPlainRecord(current)) return current;
    assertJsonContainerProperties(current, inputPath);
    if (visiting.has(current)) invalidBinding("input contains a circular value", inputPath);

    if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, LOOP_CONTEXT_BINDING_KEY)) {
      const keys = Object.keys(current);
      if (keys.length !== 1) {
        invalidBinding(`binding objects must contain only "${LOOP_CONTEXT_BINDING_KEY}"`, inputPath);
      }
      const path = current[LOOP_CONTEXT_BINDING_KEY];
      if (typeof path !== "string") {
        invalidBinding(`"${LOOP_CONTEXT_BINDING_KEY}" must be a string`, inputPath);
      }
      const value = readContextPath(context, path, inputPath);
      onResolve?.({ inputPath, contextPath: path });
      return cloneLoopJsonValue(value, inputPath);
    }

    visiting.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((child, index) => resolve(
          child,
          childInputPath(inputPath, index),
          depth + 1,
        ));
      }
      return Object.fromEntries(
        Object.entries(current).map(([key, child]) => [
          key,
          resolve(child, childInputPath(inputPath, key), depth + 1),
        ]),
      );
    } finally {
      visiting.delete(current);
    }
  };

  return resolve(input, "$", 0);
}
