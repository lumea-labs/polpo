/**
 * defineTool — native custom tools (Phase 1: authoring + validation + binding).
 *
 * Devs author a tool with capability-injected `ctx` (no ambient globals):
 *
 *   export default defineTool({
 *     name: "create_invoice",
 *     description: "Create an invoice for a customer",
 *     parameters: Type.Object({ customerId: Type.String(), amount: Type.Number() }),
 *     async execute(ctx, params) {
 *       const res = await ctx.polpo.invoices.create(params);
 *       return `Created invoice ${res.id}`;
 *     },
 *   });
 *
 * At runtime the cloud bundles + executes this inside the per-project sandbox
 * (Phases 2–3); for OSS self-host it runs in-process via {@link loadCustomToolBundle}.
 * Both paths converge on {@link bindCustomTool}, which adapts the ctx-based
 * `execute(ctx, params)` to the standard {@link PolpoTool} signature.
 */
import type { TSchema, Static } from "@sinclair/typebox";
import { pathToFileURL } from "node:url";

import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import type { PolpoTool, ToolResult, ToolUpdateCallback } from "@polpo-ai/core";

export interface CustomToolConnection {
  id: string;
  providerId: string;
  name?: string;
  authType?: string;
  kind?: string;
  scopes?: string[];
  grantedScopes?: string[];
  tokenType?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CustomToolConnections {
  /** Non-secret metadata for a configured connection. */
  get(ref: string): CustomToolConnection | undefined;
  /** Secret access token or API key for a configured connection. */
  getToken(ref: string): string | undefined;
  /** Alias for API-key integrations. */
  getKey(ref: string): string | undefined;
  /** Ready-to-use auth headers for HTTP calls, when the credential supports them. */
  getHeaders(ref: string): Record<string, string> | undefined;
  has(ref: string): boolean;
  list(): CustomToolConnection[];
}

export function emptyCustomToolConnections(): CustomToolConnections {
  return {
    get: () => undefined,
    getToken: () => undefined,
    getKey: () => undefined,
    getHeaders: () => undefined,
    has: () => false,
    list: () => [],
  };
}

/**
 * Capabilities injected into a custom tool's `execute`. Everything a tool can
 * touch arrives here — there are no ambient globals or platform env access.
 */
export interface CustomToolContext {
  /** Sandboxed filesystem rooted at the project workspace. */
  fs: FileSystem;
  /** Shell for running commands in the workspace. */
  shell: Shell;
  /** Project Connections granted to this tool. */
  connections: CustomToolConnections;
  /** Safe environment variables (platform secrets stripped). */
  env: Record<string, string | undefined>;
  /** Absolute working directory inside the workspace. */
  workDir: string;
  /** Preconfigured Polpo SDK client, scoped to the project. Typed loosely in v1. */
  polpo?: unknown;
  /** Abort signal for this tool call. */
  signal?: AbortSignal;
  /** Stream partial results back to the runtime. */
  onUpdate?: ToolUpdateCallback;
}

/** A custom tool's return value — a plain string (wrapped as text) or a full ToolResult. */
export type CustomToolExecuteResult = string | ToolResult;

/** The object passed to {@link defineTool}. */
export interface CustomToolSpec<T extends TSchema = TSchema> {
  /** Unique, snake_case identifier exposed to the model. */
  name: string;
  /** What the tool does — shown to the model. */
  description: string;
  /** TypeBox schema for the tool arguments. */
  parameters: T;
  /** Human-friendly label for UIs. Defaults to `name`. */
  label?: string;
  /** Run on the client instead of the sandbox (plumbed in a later phase). */
  clientSide?: boolean;
  /** Tool body. Receives injected capabilities + validated params. */
  execute: (
    ctx: CustomToolContext,
    params: Static<T>,
  ) => CustomToolExecuteResult | Promise<CustomToolExecuteResult>;
}

/** A defined custom tool — a {@link CustomToolSpec} tagged with the `__custom` marker. */
export interface CustomTool<T extends TSchema = TSchema> extends CustomToolSpec<T> {
  readonly __custom: true;
}

/** snake_case: lowercase letter start, then lowercase / digits / underscores. */
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Authoring helper. Returns the spec tagged with `__custom: true` so the loader
 * and the cloud registry can recognize it. Pure — no side effects.
 */
export function defineTool<T extends TSchema>(spec: CustomToolSpec<T>): CustomTool<T> {
  return { ...spec, __custom: true };
}

/**
 * Validate a candidate tool's shape. Returns human-readable error strings
 * (empty array = valid). Reused by the loader and the cloud `POST /v1/tools`
 * endpoint so authors get identical feedback in the CLI, dashboard and at load.
 */
export function getCustomToolErrors(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return ["Tool must be an object (did you `export default defineTool({...})`?)"];
  }
  const t = value as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof t.name !== "string" || t.name.length === 0) {
    errors.push("`name` is required and must be a non-empty string");
  } else if (!NAME_RE.test(t.name)) {
    errors.push(
      `\`name\` must be snake_case (lowercase letters, digits, underscores; starting with a letter): got "${t.name}"`,
    );
  }
  if (typeof t.description !== "string" || t.description.trim().length === 0) {
    errors.push("`description` is required and must be a non-empty string");
  }
  if (typeof t.parameters !== "object" || t.parameters === null) {
    errors.push("`parameters` is required and must be a TypeBox schema object");
  }
  if (typeof t.execute !== "function") {
    errors.push("`execute` is required and must be a function `(ctx, params) => result`");
  }
  if (t.label !== undefined && typeof t.label !== "string") {
    errors.push("`label` must be a string when provided");
  }
  if (t.clientSide !== undefined && typeof t.clientSide !== "boolean") {
    errors.push("`clientSide` must be a boolean when provided");
  }
  return errors;
}

/** Type guard: a valid custom tool carrying the `__custom` marker. */
export function isCustomTool(value: unknown): value is CustomTool {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__custom === true &&
    getCustomToolErrors(value).length === 0
  );
}

/** Coerce a custom tool's return value into a {@link ToolResult}. */
export function normalizeToolResult(result: CustomToolExecuteResult): ToolResult {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }], details: null };
  }
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as ToolResult).content)
  ) {
    return result as ToolResult;
  }
  // Lenient fallback: a tool returned something unexpected — surface it as text
  // rather than crashing the run.
  return { content: [{ type: "text", text: JSON.stringify(result) }], details: result ?? null };
}

function exampleString(name: string, format?: string): string {
  const key = `${name} ${format ?? ""}`.toLowerCase();
  if (/email/.test(key)) return "user@example.com";
  if (/uri|url|link|website|endpoint/.test(key)) return "https://example.com";
  if (/date-time|datetime|timestamp/.test(key)) return "2026-01-15T09:30:00Z";
  if (/date|day/.test(key)) return "2026-01-15";
  if (/time/.test(key)) return "09:30:00";
  if (/uuid/.test(key)) return "550e8400-e29b-41d4-a716-446655440000";
  if (/path|file/.test(key)) return "output/result.txt";
  if (/query|search|prompt/.test(key)) return "quarterly report";
  if (/message|text|body|content/.test(key)) return "Hello world";
  if (/name|title|company/.test(key)) return "Acme Inc";
  if (/(^|\s)id($|\s)/.test(key)) return "item_123";
  return "text";
}

function exampleNumber(name: string): number {
  const key = name.toLowerCase();
  if (/amount|price|cost|total|fee|balance/.test(key)) return 99.99;
  if (/count|qty|quantity|limit|page|size|max|min/.test(key)) return 10;
  return 42;
}

/** Build deterministic example arguments from a TypeBox/JSON Schema. */
export function createJsonSchemaExample(schema: unknown, name = ""): unknown {
  if (!schema || typeof schema !== "object") return "value";
  const node = schema as Record<string, unknown>;

  if (node.default !== undefined) return node.default;
  if (Array.isArray(node.examples) && node.examples.length > 0) return node.examples[0];
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];

  const alternatives = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : null;
  if (alternatives?.length) return createJsonSchemaExample(alternatives[0], name);

  const type = Array.isArray(node.type)
    ? node.type.find((candidate) => candidate !== "null")
    : node.type;
  if (type === "object" || (type === undefined && node.properties)) {
    const properties = node.properties && typeof node.properties === "object"
      ? node.properties as Record<string, unknown>
      : {};
    return Object.fromEntries(
      Object.entries(properties)
        .slice(0, 20)
        .map(([key, value]) => [key, createJsonSchemaExample(value, key)]),
    );
  }
  if (type === "array") return [createJsonSchemaExample(node.items, name)];
  if (type === "boolean") return true;
  if (type === "integer") return Math.trunc(exampleNumber(name));
  if (type === "number") return exampleNumber(name);
  if (type === "null") return null;
  return exampleString(name, typeof node.format === "string" ? node.format : undefined);
}

/** ctx without the per-call fields, which {@link bindCustomTool} supplies itself. */
export type CustomToolBindContext = Omit<CustomToolContext, "signal" | "onUpdate">;

/**
 * Adapt a {@link CustomTool} (ctx-based `execute`) into a runtime {@link PolpoTool}
 * (`execute(toolCallId, params, signal?, onUpdate?)`), binding the injected ctx.
 * This is the "wrap at registration" step that lets custom and built-in tools
 * coexist without touching the built-ins.
 */
export function bindCustomTool<T extends TSchema>(
  tool: CustomTool<T>,
  ctx: CustomToolBindContext,
): PolpoTool<T> {
  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_toolCallId, params, signal, onUpdate) {
      const result = await tool.execute(
        { ...ctx, signal, onUpdate },
        params as Static<T>,
      );
      return normalizeToolResult(result);
    },
  };
}

/**
 * Find the custom tool inside a (possibly bundled) module's exports. Accepts a
 * tool passed directly, a default export, a nested default (esbuild interop),
 * or the first matching named export. Throws a helpful error otherwise.
 */
export function extractCustomTool(moduleOrTool: unknown): CustomTool {
  if (isCustomTool(moduleOrTool)) return moduleOrTool;

  if (typeof moduleOrTool === "object" && moduleOrTool !== null) {
    const mod = moduleOrTool as Record<string, unknown>;
    const nestedDefault = (mod.default as Record<string, unknown> | undefined)?.default;
    const candidates: unknown[] = [mod.default, nestedDefault, ...Object.values(mod)];
    for (const c of candidates) {
      if (isCustomTool(c)) return c;
    }
    // Near-miss: a __custom-tagged export that failed validation → surface why.
    const near = candidates.find(
      (c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).__custom === true,
    );
    if (near) {
      const errs = getCustomToolErrors(near);
      throw new Error(`Invalid custom tool:\n- ${errs.join("\n- ")}`);
    }
  }

  throw new Error(
    "No custom tool found in module. Expected `export default defineTool({...})`.",
  );
}

/**
 * Load a custom tool bundle and bind it to a runtime ctx → {@link PolpoTool}.
 * Accepts either a filesystem path to a bundled module (dynamic import — the
 * OSS self-host path) or an already-imported module/tool object.
 */
export async function loadCustomToolBundle(
  pathOrModule: string | object,
  ctx: CustomToolBindContext,
): Promise<PolpoTool> {
  const mod =
    typeof pathOrModule === "string"
      ? await import(pathToFileURL(pathOrModule).href)
      : pathOrModule;
  const tool = extractCustomTool(mod);
  return bindCustomTool(tool, ctx);
}
