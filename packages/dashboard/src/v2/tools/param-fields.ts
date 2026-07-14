/**
 * Turn a tool's TypeBox/JSON-Schema `parameters` into a guided "Try it" form,
 * and assemble a typed args object back from the form values. Ported from the
 * v1 tools view so the run form works without needing the AI example endpoint.
 */

export type ParamField = {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "enum" | "json";
  required: boolean;
  description?: string;
  enumValues?: (string | number)[];
  raw?: Record<string, unknown>;
};

/* eslint-disable @typescript-eslint/no-explicit-any */

export function schemaToFields(schema: unknown): ParamField[] | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, any>;
  const props = s.properties;
  if (!props || typeof props !== "object") return null;
  const required: string[] = Array.isArray(s.required) ? s.required : [];
  const names = Object.keys(props);
  if (names.length === 0) return null;

  return names.map((name): ParamField => {
    const p = (props[name] ?? {}) as Record<string, any>;
    const description =
      typeof p.description === "string" ? p.description : undefined;
    const req = required.includes(name);

    const enumFromKeyword = Array.isArray(p.enum) ? p.enum : null;
    const enumFromAnyOf =
      Array.isArray(p.anyOf) && p.anyOf.every((m: any) => m && "const" in m)
        ? p.anyOf.map((m: any) => m.const)
        : null;
    const enumValues = (enumFromKeyword ?? enumFromAnyOf) as
      | (string | number)[]
      | null;
    if (enumValues && enumValues.length > 0) {
      return { name, type: "enum", required: req, description, enumValues };
    }

    switch (p.type) {
      case "string":
        return { name, type: "string", required: req, description };
      case "number":
        return { name, type: "number", required: req, description };
      case "integer":
        return { name, type: "integer", required: req, description };
      case "boolean":
        return { name, type: "boolean", required: req, description };
      default:
        return { name, type: "json", required: req, description, raw: p };
    }
  });
}

function exampleString(name: string): string {
  const n = name.toLowerCase();
  if (/email/.test(n)) return "user@example.com";
  if (/url|link|website|endpoint/.test(n)) return "https://example.com";
  if (/phone|tel/.test(n)) return "+15550100";
  if (/datetime|timestamp/.test(n)) return "2024-01-15T09:30:00Z";
  if (/date|day/.test(n)) return "2024-01-15";
  if (/time/.test(n)) return "09:30";
  if (/uuid|(^|_)id$/.test(n)) return "abc123";
  if (/city/.test(n)) return "San Francisco";
  if (/country/.test(n)) return "US";
  if (/currency/.test(n)) return "USD";
  if (/(^|_)name$|title|company/.test(n)) return "Acme Inc";
  if (/query|search|(^|_)q$/.test(n)) return "quarterly report";
  if (/message|text|body|content|prompt/.test(n)) return "Hello world";
  if (/slug/.test(n)) return "my-tool";
  if (/path|file/.test(n)) return "/tmp/out.txt";
  if (/lang|locale/.test(n)) return "en";
  return "text";
}

function exampleNumber(name: string): number {
  const n = name.toLowerCase();
  if (/amount|price|cost|total|fee|balance/.test(n)) return 99.99;
  if (/count|qty|quantity|limit|page|size|max|min/.test(n)) return 10;
  if (/age/.test(n)) return 30;
  if (/year/.test(n)) return 2024;
  return 42;
}

function exampleFromSchema(node: any, name = ""): unknown {
  if (!node || typeof node !== "object") return "value";
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
  if (Array.isArray(node.anyOf) && node.anyOf[0] && "const" in node.anyOf[0])
    return node.anyOf[0].const;
  switch (node.type) {
    case "string":
      return exampleString(name);
    case "number":
    case "integer":
      return exampleNumber(name);
    case "boolean":
      return true;
    case "array":
      return [exampleFromSchema(node.items, name)];
    case "object": {
      const props = (node.properties ?? {}) as Record<string, any>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(props).slice(0, 4))
        out[k] = exampleFromSchema(props[k], k);
      return Object.keys(out).length ? out : { key: "value" };
    }
    default:
      return "value";
  }
}

export function placeholderFor(f: ParamField): string {
  if (f.type === "boolean" || f.type === "enum") return "";
  if (f.type === "json") return `e.g. ${JSON.stringify(exampleFromSchema(f.raw, f.name))}`;
  if (f.type === "number" || f.type === "integer") return `e.g. ${exampleNumber(f.name)}`;
  return `e.g. ${exampleString(f.name)}`;
}

export function argsToFormValues(
  fields: ParamField[],
  args: Record<string, unknown>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const f of fields) {
    const v = args?.[f.name];
    if (v === undefined || v === null) {
      values[f.name] = f.type === "boolean" ? "false" : "";
      continue;
    }
    values[f.name] =
      typeof v === "boolean"
        ? v
          ? "true"
          : "false"
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
  }
  return values;
}

export function emptyFormValues(fields: ParamField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.name] = f.type === "boolean" ? "false" : "";
  return out;
}

export function buildArgsFromForm(
  fields: ParamField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.name];
    if (f.type === "boolean") {
      if (raw === "true") args[f.name] = true;
      else if (raw === "false" && f.required) args[f.name] = false;
      continue;
    }
    if (raw === undefined || raw === "") continue;
    if (f.type === "number" || f.type === "integer") {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`"${f.name}" must be a number.`);
      args[f.name] = f.type === "integer" ? Math.trunc(n) : n;
      continue;
    }
    if (f.type === "enum") {
      args[f.name] = raw;
      continue;
    }
    if (f.type === "json") {
      try {
        args[f.name] = JSON.parse(raw);
      } catch {
        throw new Error(`"${f.name}" must be valid JSON.`);
      }
      continue;
    }
    args[f.name] = raw;
  }
  return args;
}
