import { readFile } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  RuntimeHookEngine,
  RuntimeHookValidationError,
  validateRuntimeHookPack,
  type RuntimeHookDefinition,
  type RuntimeHookHandlerResult,
  type RuntimeHookHost,
  type RuntimeHookPack,
  type RuntimeHookEnvelope,
} from "@polpo-ai/core/runtime-hooks";
import type { Shell } from "@polpo-ai/core/shell";

export interface NodeRuntimeHookHostOptions {
  shell: Shell;
  cwd: string;
  fetch?: typeof globalThis.fetch;
  lookup?: typeof dnsLookup;
  resolveHttpHeaders?: (connection: string, signal: AbortSignal) => Promise<Record<string, string>>;
  invokeTool?: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<RuntimeHookHandlerResult | void>;
  invokeMcpTool?: (connection: string, name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<RuntimeHookHandlerResult | void>;
  runPrompt?: (input: { prompt: string; envelope: RuntimeHookEnvelope; model?: string; maxOutputTokens?: number }, signal: AbortSignal) => Promise<RuntimeHookHandlerResult | void>;
  runAgent?: (input: { agent: string; prompt: string; envelope: RuntimeHookEnvelope; allowedTools?: string[]; maxTurns?: number }, signal: AbortSignal) => Promise<RuntimeHookHandlerResult | void>;
  trace?: RuntimeHookHost["trace"];
  maxOutputBytes?: number;
}

export async function loadRuntimeHookPacks(
  polpoDir: string,
  names: readonly string[],
): Promise<RuntimeHookPack[]> {
  const packs: RuntimeHookPack[] = [];
  for (const rawName of names) {
    const name = normalizePackName(rawName);
    let raw: string;
    try {
      raw = await readFile(join(polpoDir, "hooks", `${name}.json`), "utf8");
    } catch (error) {
      throw new RuntimeHookValidationError(`Runtime hook pack "${name}" could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RuntimeHookValidationError(`Runtime hook pack "${name}" is not valid JSON`);
    }
    const pack = validateRuntimeHookPack(parsed);
    if (pack.name !== name) {
      throw new RuntimeHookValidationError(`Runtime hook pack file "${name}" declares name "${pack.name}"`);
    }
    packs.push(pack);
  }
  return packs;
}

export async function createProjectRuntimeHookEngine(options: {
  polpoDir: string;
  names: readonly string[];
  host: RuntimeHookHost;
}): Promise<RuntimeHookEngine | undefined> {
  if (options.names.length === 0) return undefined;
  const packs = await loadRuntimeHookPacks(options.polpoDir, options.names);
  const definitions: RuntimeHookDefinition[] = [];
  const ids = new Set<string>();
  for (const pack of packs) {
    for (const hook of pack.hooks) {
      const scopedId = `${pack.name}/${hook.id}`;
      if (ids.has(scopedId)) throw new RuntimeHookValidationError(`Duplicate runtime hook id "${scopedId}"`);
      ids.add(scopedId);
      definitions.push({ ...hook, id: scopedId });
    }
  }
  return new RuntimeHookEngine({ definitions, host: options.host });
}

export function createNodeRuntimeHookHost(options: NodeRuntimeHookHostOptions): RuntimeHookHost {
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  return {
    trace: options.trace,
    execute: async ({ hook, envelope, idempotencyKey, signal }) => {
      const handler = hook.handler;
      if (handler.type === "command") {
        const command = [handler.command, ...(handler.args ?? []).map(shellQuote)].join(" ");
        const result = await options.shell.execute(command, {
          cwd: handler.cwd ?? options.cwd,
          env: {
            ...(handler.env ?? {}),
            POLPO_HOOK_EVENT: envelope.event,
            POLPO_HOOK_EVENT_ID: envelope.eventId,
            POLPO_HOOK_IDEMPOTENCY_KEY: idempotencyKey,
          },
          timeout: handler.timeoutMs,
        });
        if (result.exitCode !== 0) throw new Error(result.stderr || `Hook command exited ${result.exitCode}`);
        assertBounded(result.stdout, maxOutputBytes);
        return parseHandlerResult(result.stdout);
      }
      if (handler.type === "http") {
        const url = safeHookUrl(handler.url);
        await assertPublicDns(url.hostname, options.lookup ?? dnsLookup);
        const connectionHeaders = handler.connection
          ? await options.resolveHttpHeaders?.(handler.connection, signal)
          : undefined;
        if (handler.connection && !connectionHeaders) {
          throw new Error(`Runtime hook HTTP connection "${handler.connection}" could not be resolved`);
        }
        const response = await (options.fetch ?? globalThis.fetch)(url, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "x-polpo-hook-event": envelope.event,
            "x-polpo-hook-idempotency-key": idempotencyKey,
            ...(connectionHeaders ?? {}),
            ...(handler.headers ?? {}),
          },
          body: JSON.stringify(envelope),
          signal,
        });
        const text = await response.text();
        assertBounded(text, maxOutputBytes);
        if (!response.ok) throw new Error(`Hook HTTP endpoint returned ${response.status}`);
        return parseHandlerResult(text);
      }
      if (handler.type === "tool") {
        if (!options.invokeTool) throw new Error("Runtime hook tool adapter is not configured");
        return await options.invokeTool(handler.tool, mergeInput(handler.input, envelope), signal);
      }
      if (handler.type === "mcp_tool") {
        if (!options.invokeMcpTool) throw new Error("Runtime hook MCP adapter is not configured");
        return await options.invokeMcpTool(handler.connection, handler.tool, mergeInput(handler.input, envelope), signal);
      }
      if (handler.type === "prompt") {
        if (!options.runPrompt) throw new Error("Runtime hook prompt adapter is not configured");
        return await options.runPrompt({ prompt: handler.prompt, envelope, model: handler.model, maxOutputTokens: handler.maxOutputTokens }, signal);
      }
      if (!options.runAgent) throw new Error("Runtime hook agent adapter is not configured");
      return await options.runAgent({ agent: handler.agent, prompt: handler.prompt, envelope, allowedTools: handler.allowedTools, maxTurns: handler.maxTurns }, signal);
    },
  };
}

function normalizePackName(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) {
    throw new RuntimeHookValidationError(`Invalid runtime hook pack name ${JSON.stringify(value)}`);
  }
  return value;
}

function safeHookUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Hook HTTP URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Hook HTTP URL must use HTTPS without embedded credentials");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isIP(hostname) !== 0) {
    throw new Error("Hook HTTP URL must use a public hostname");
  }
  return url;
}

async function assertPublicDns(
  hostname: string,
  lookup: typeof dnsLookup,
): Promise<void> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Hook HTTP hostname could not be resolved");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Hook HTTP URL must resolve only to public addresses");
  }
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return !(
      a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b! >= 64 && b! <= 127)
      || a! >= 224
    );
  }
  if (family === 6) {
    return !(
      normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || normalized.startsWith("::ffff:10.")
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:169.254.")
      || normalized.startsWith("::ffff:172.")
      || normalized.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

function mergeInput(configured: Record<string, unknown> | undefined, envelope: unknown): Record<string, unknown> {
  return { ...(configured ?? {}), hook: envelope };
}

function parseHandlerResult(raw: string): RuntimeHookHandlerResult | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { output: parsed };
    return parsed as RuntimeHookHandlerResult;
  } catch {
    return { output: value };
  }
}

function assertBounded(value: string, maxBytes: number): void {
  if (new TextEncoder().encode(value).byteLength > maxBytes) throw new Error(`Runtime hook output exceeds ${maxBytes} bytes`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
