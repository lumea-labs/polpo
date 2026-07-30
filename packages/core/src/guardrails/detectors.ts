import { Ajv, type ValidateFunction } from "ajv";
import type {
  RuntimeGuardrailAction,
  RuntimeGuardrailPhase,
  RuntimeGuardrailRisk,
} from "../runtime-plan/types.js";
import type {
  RuntimeGuardrailPolicy,
  RuntimeGuardrailPolicyResult,
} from "./types.js";

interface DetectorOptions {
  readonly id?: string;
  readonly version?: string;
  readonly priority?: number;
  readonly action?: RuntimeGuardrailAction;
  readonly risk?: RuntimeGuardrailRisk;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g,
  /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{32,255}\b/g,
  /\bsk_[a-f0-9]{40,255}\b/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function redactString(value: string): { value: string; matches: number } {
  let redacted = value;
  let matches = 0;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      matches++;
      return "[REDACTED]";
    });
  }
  return { value: redacted, matches };
}

function mapStrings(
  value: unknown,
  mapper: (value: string) => { value: string; matches: number },
  seen = new WeakMap<object, unknown>(),
): { value: unknown; matches: number } {
  if (typeof value === "string") return mapper(value);
  if (value === null || typeof value !== "object") return { value, matches: 0 };
  const existing = seen.get(value as object);
  if (existing !== undefined) return { value: existing, matches: 0 };
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    let matches = 0;
    for (const item of value) {
      const mapped = mapStrings(item, mapper, seen);
      output.push(mapped.value);
      matches += mapped.matches;
    }
    return { value: output, matches };
  }
  const output: Record<string, unknown> = {};
  seen.set(value as object, output);
  let matches = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const mapped = mapStrings(item, mapper, seen);
    output[key] = mapped.value;
    matches += mapped.matches;
  }
  return { value: output, matches };
}

function collectStrings(
  value: unknown,
  output: string[] = [],
  seen = new WeakSet<object>(),
): string[] {
  if (typeof value === "string") output.push(value);
  else if (value && typeof value === "object" && !seen.has(value as object)) {
    seen.add(value as object);
    for (const item of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>)) {
      collectStrings(item, output, seen);
    }
  }
  return output;
}

export function createSecretPatternPolicy(options: DetectorOptions & {
  readonly phases?: readonly RuntimeGuardrailPhase[];
} = {}): RuntimeGuardrailPolicy {
  const action = options.action ?? "redact";
  return {
    id: options.id ?? "secrets.common-patterns",
    version: options.version ?? "1",
    priority: options.priority ?? 500,
    phases: options.phases ?? ["input", "context", "tool.before", "tool.after", "output"],
    evaluate(input) {
      const redacted = mapStrings(input.value, redactString);
      if (redacted.matches === 0) return null;
      return {
        action,
        risk: options.risk ?? "high",
        reason: `Detected ${redacted.matches} common secret pattern${redacted.matches === 1 ? "" : "s"}`,
        ...(action === "redact" || action === "rewrite" ? { value: redacted.value } : {}),
      } as RuntimeGuardrailPolicyResult;
    },
  };
}

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+(?:-[^\s]*[rf][^\s]*\s+){1,}(?:\/(?:\s|$)|~(?:\/|\s|$)|\$HOME(?:\/|\s|$))/i,
  /\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs)\b/i,
  /\bdd\s+if=.*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/i,
  /\bTRUNCATE\s+(?:TABLE\s+)?\S+/i,
  /\bDELETE\s+FROM\s+\S+(?![\s\S]*\bWHERE\b)/i,
  /\bUPDATE\s+\S+\s+SET\b(?![\s\S]*\bWHERE\b)/i,
];

export function createDestructiveOperationPolicy(
  options: DetectorOptions = {},
): RuntimeGuardrailPolicy {
  return {
    id: options.id ?? "tools.destructive-operation",
    version: options.version ?? "1",
    priority: options.priority ?? 200,
    phases: ["tool.before"],
    evaluate(input) {
      const toolName = input.tool?.name.toLowerCase() ?? "";
      if (!/(bash|shell|command|exec|sql|query)/.test(toolName)) return null;
      const matched = collectStrings(input.value).some((value) =>
        DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(value))
      );
      if (!matched) return null;
      return {
        action: options.action ?? "approval",
        risk: options.risk ?? "critical",
        reason: "Potentially destructive shell or SQL operation",
      };
    },
  };
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const values = parts.map(Number);
  if (values.some((value) => value > 255)) return false;
  return values[0] === 10
    || values[0] === 127
    || (values[0] === 169 && values[1] === 254)
    || (values[0] === 172 && values[1] >= 16 && values[1] <= 31)
    || (values[0] === 192 && values[1] === 168)
    || (values[0] === 100 && values[1] >= 64 && values[1] <= 127)
    || (values[0] === 198 && (values[1] === 18 || values[1] === 19))
    || values[0] >= 224
    || values[0] === 0;
}

function mappedIpv4(hostname: string): string | undefined {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (!match) return undefined;
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return [
    high >>> 8,
    high & 0xff,
    low >>> 8,
    low & 0xff,
  ].join(".");
}

function isPrivateHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const ipv4 = mappedIpv4(hostname);
  return hostname === "localhost"
    || hostname === "::"
    || hostname === "::1"
    || hostname === "0:0:0:0:0:0:0:1"
    || /^f[cd][0-9a-f]{2}(?::|$)/.test(hostname)
    || /^fe[89ab][0-9a-f](?::|$)/.test(hostname)
    || /^ff[0-9a-f]{2}(?::|$)/.test(hostname)
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
    || hostname === "metadata.google.internal"
    || (ipv4 !== undefined && isPrivateIpv4(ipv4))
    || isPrivateIpv4(hostname);
}

function findPrivateTarget(
  value: unknown,
  seen = new WeakSet<object>(),
): string | undefined {
  if (value && typeof value === "object") {
    if (seen.has(value as object)) return undefined;
    seen.add(value as object);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (
        typeof item === "string" &&
        /^(?:host|hostname|address)$/i.test(key) &&
        isPrivateHostname(item)
      ) {
        return item.toLowerCase();
      }
      const nested = findPrivateTarget(item, seen);
      if (nested) return nested;
    }
    return undefined;
  }
  if (typeof value !== "string") return undefined;

  const candidates = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  for (const candidate of candidates) {
    try {
      const hostname = new URL(candidate).hostname.replace(/^\[|\]$/g, "");
      if (isPrivateHostname(hostname)) return hostname.toLowerCase();
    } catch {
      // Malformed URLs belong to argument-schema validation, not SSRF policy.
    }
  }
  return undefined;
}

export function createPrivateNetworkPolicy(
  options: DetectorOptions = {},
): RuntimeGuardrailPolicy {
  return {
    id: options.id ?? "network.private-target",
    version: options.version ?? "1",
    priority: options.priority ?? 220,
    phases: ["tool.before"],
    evaluate(input) {
      const toolName = input.tool?.name.toLowerCase() ?? "";
      if (!/(http|fetch|request|browser|navigate|webhook|url|download|connect|network|api)/.test(toolName)) return null;
      const target = findPrivateTarget(input.value);
      if (!target) return null;
      return {
        action: options.action ?? "block",
        risk: options.risk ?? "critical",
        reason: `Outbound request targets a non-public network address: ${target}`,
      };
    },
  };
}

const toolSchemaAjv = new Ajv({
  allErrors: false,
  allowUnionTypes: true,
  strict: false,
  validateFormats: false,
});
const toolSchemaValidators = new WeakMap<object, ValidateFunction>();

async function resolveToolArgumentSchema(
  value: unknown,
  seen = new WeakSet<object>(),
): Promise<Record<string, unknown> | undefined> {
  let current = await value;
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    if (seen.has(current as object)) return undefined;
    seen.add(current as object);

    const candidate = current as Record<string, unknown>;
    if (
      candidate.type !== undefined
      || candidate.properties !== undefined
      || candidate.required !== undefined
      || candidate.$ref !== undefined
      || candidate.allOf !== undefined
      || candidate.anyOf !== undefined
      || candidate.oneOf !== undefined
    ) {
      return candidate;
    }
    if (!("jsonSchema" in candidate)) return candidate;
    current = await candidate.jsonSchema;
  }
  return undefined;
}

function validateToolArguments(
  schema: Record<string, unknown>,
  value: unknown,
): string | undefined {
  let validate = toolSchemaValidators.get(schema);
  if (!validate) {
    const compiled = toolSchemaAjv.compile(schema);
    toolSchemaValidators.set(schema, compiled);
    validate = compiled;
  }
  if (validate(value)) return undefined;
  const error = validate.errors?.[0];
  const path = error?.instancePath || "$";
  return `${path} ${error?.message ?? "does not match the tool schema"}`;
}

export function createToolArgumentsPolicy(
  options: DetectorOptions = {},
): RuntimeGuardrailPolicy {
  return {
    id: options.id ?? "tools.arguments-schema",
    version: options.version ?? "1",
    priority: options.priority ?? 100,
    phases: ["tool.before"],
    async evaluate(input) {
      if (input.tool?.schema === undefined) return null;
      let schema: Record<string, unknown> | undefined;
      try {
        schema = await resolveToolArgumentSchema(input.tool.schema);
      } catch {
        schema = undefined;
      }
      if (!schema) {
        return {
          action: options.action ?? "block",
          risk: options.risk ?? "high",
          reason: "Tool parameter schema is malformed",
        };
      }
      if (schema.type !== "object") {
        return {
          action: options.action ?? "block",
          risk: options.risk ?? "high",
          reason: "Tool parameter root must be an object schema",
        };
      }
      let error: string | undefined;
      try {
        error = validateToolArguments(schema, input.value);
      } catch {
        return {
          action: options.action ?? "block",
          risk: options.risk ?? "high",
          reason: "Tool parameter schema could not be validated",
        };
      }
      if (!error) return null;
      return {
        action: options.action ?? "block",
        risk: options.risk ?? "high",
        reason: `Invalid tool arguments: ${error}`,
      };
    },
  };
}

export function createCrossScopePolicy(
  options: DetectorOptions = {},
): RuntimeGuardrailPolicy {
  return {
    id: options.id ?? "context.cross-scope",
    version: options.version ?? "1",
    priority: options.priority ?? 50,
    phases: ["input", "context", "model.preflight", "tool.before", "tool.after", "output"],
    evaluate(input) {
      const expected = input.context.scope?.expected;
      const actual = input.context.scope?.actual;
      if (!expected || !actual) return null;
      const mismatch = Object.entries(expected).find(
        ([key, expectedValue]) =>
          expectedValue !== undefined && actual[key] !== expectedValue,
      );
      if (!mismatch) return null;
      return {
        action: options.action ?? "block",
        risk: options.risk ?? "critical",
        reason: `Runtime context scope mismatch for "${mismatch[0]}"`,
      };
    },
  };
}

function countCharacters(value: unknown, limit: number, seen = new WeakSet<object>()): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return String(value).length;
  if (typeof value !== "object") return String(value).length;
  if (seen.has(value as object)) return limit + 1;
  seen.add(value as object);
  let total = Array.isArray(value) ? 2 : 2;
  const entries = Array.isArray(value)
    ? value
    : Object.entries(value as Record<string, unknown>);
  for (const entry of entries) {
    if (Array.isArray(entry) && !Array.isArray(value)) {
      total += entry[0].length + countCharacters(entry[1], limit - total, seen);
    } else {
      total += countCharacters(entry, limit - total, seen);
    }
    if (total > limit) return total;
  }
  return total;
}

export function createBoundedValuePolicy(options: DetectorOptions & {
  readonly phases: readonly RuntimeGuardrailPhase[];
  readonly maxCharacters: number;
}): RuntimeGuardrailPolicy {
  if (!Number.isSafeInteger(options.maxCharacters) || options.maxCharacters < 1) {
    throw new TypeError("maxCharacters must be a positive safe integer");
  }
  return {
    id: options.id ?? "context.bounded-value",
    version: options.version ?? "1",
    priority: options.priority ?? 80,
    phases: options.phases,
    evaluate(input) {
      if (countCharacters(input.value, options.maxCharacters) <= options.maxCharacters) return null;
      return {
        action: options.action ?? "block",
        risk: options.risk ?? "high",
        reason: `Value exceeds the ${options.maxCharacters}-character guardrail limit`,
      };
    },
  };
}

export function createDefaultToolGuardrailPolicies(): readonly RuntimeGuardrailPolicy[] {
  return Object.freeze([
    createCrossScopePolicy(),
    createToolArgumentsPolicy(),
    createDestructiveOperationPolicy(),
    createPrivateNetworkPolicy(),
    createSecretPatternPolicy({
      id: "secrets.tool-input",
      phases: ["tool.before"],
      action: "redact",
    }),
    createSecretPatternPolicy({
      id: "secrets.tool-output",
      phases: ["tool.after"],
      action: "redact",
    }),
  ]);
}

export function createDefaultOutputGuardrailPolicies(
  maxCharacters?: number,
): readonly RuntimeGuardrailPolicy[] {
  return Object.freeze([
    createCrossScopePolicy(),
    ...(maxCharacters !== undefined
      ? [createBoundedValuePolicy({
          id: "output.bounded-value",
          phases: ["output"],
          maxCharacters,
          action: "block",
        })]
      : []),
    createSecretPatternPolicy({
      id: "secrets.output",
      phases: ["output"],
      action: "redact",
    }),
  ]);
}
