import { isAlias, isMap, isNode, parseDocument, visit } from "yaml";

export const AGENT_SKILL_NAME_MAX = 64;
export const AGENT_SKILL_DESCRIPTION_MAX = 1_024;
export const AGENT_SKILL_COMPATIBILITY_MAX = 500;
const AGENT_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

export interface SkillDiagnostic {
  code: string;
  message: string;
  severity: "warning";
}

export interface ParsedSkillManifest {
  manifest: SkillManifest;
  body: string;
  diagnostics: SkillDiagnostic[];
}

export interface ParseSkillManifestOptions {
  mode?: "strict" | "compatibility";
  directoryName?: string;
}

export class SkillManifestValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillManifestValidationError";
  }
}

export function validateAgentSkillName(name: string): string | null {
  if (name.length === 0 || name.length > AGENT_SKILL_NAME_MAX) {
    return `Skill name must contain at most ${AGENT_SKILL_NAME_MAX} characters`;
  }
  if (/--/.test(name)) return "Skill name must not contain consecutive hyphens";
  if (!AGENT_SKILL_NAME.test(name)) {
    return "Skill name must use lowercase letters, digits, and single hyphens";
  }
  return null;
}

export function parseSkillManifest(
  content: string,
  options: ParseSkillManifestOptions = {},
): ParsedSkillManifest {
  const mode = options.mode ?? "compatibility";
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new SkillManifestValidationError("missing_frontmatter", "SKILL.md must start with YAML frontmatter");

  const diagnostics: SkillDiagnostic[] = [];
  const document = parseDocument(match[1], {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
  });
  let raw: Record<string, unknown>;
  if (document.errors.length > 0) {
    const recovered = mode === "compatibility" ? parseLegacyFlatFrontmatter(match[1]) : null;
    if (!recovered) {
      throw new SkillManifestValidationError("invalid_yaml", `Invalid SKILL.md frontmatter: ${document.errors[0].message}`);
    }
    raw = recovered.raw;
    diagnostics.push({
      code: "legacy_invalid_yaml_recovered",
      message: "Recovered invalid legacy flat frontmatter; replace or save the skill to normalize it",
      severity: "warning",
    }, ...recovered.diagnostics);
  } else {
    let unsafeYaml = false;
    visit(document, (_key, node) => {
      if (isAlias(node) || (isNode(node) && (node.anchor || node.tag))) unsafeYaml = true;
    });
    if (unsafeYaml) {
      throw new SkillManifestValidationError("unsafe_yaml", "SKILL.md frontmatter must not use aliases, anchors, or custom tags");
    }
    if (!isMap(document.contents)) {
      throw new SkillManifestValidationError("invalid_frontmatter", "SKILL.md frontmatter must be a mapping");
    }

    const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
    if (!isPlainRecord(parsed)) {
      throw new SkillManifestValidationError("invalid_frontmatter", "SKILL.md frontmatter must be a plain mapping");
    }
    raw = parsed;
  }

  const unknown = Object.keys(raw).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length > 0) {
    if (mode === "strict") {
      throw new SkillManifestValidationError("unknown_field", `Unknown SKILL.md frontmatter field: ${unknown[0]}`);
    }
    diagnostics.push({
      code: "unknown_frontmatter_fields",
      message: `Ignored legacy frontmatter fields: ${unknown.sort().join(", ")}`,
      severity: "warning",
    });
  }

  const name = requiredString(raw.name, "name", "invalid_name");
  const nameError = validateAgentSkillName(name);
  if (nameError) throw new SkillManifestValidationError("invalid_name", nameError);
  if (options.directoryName !== undefined && name !== options.directoryName) {
    throw new SkillManifestValidationError(
      "name_mismatch",
      `SKILL.md name "${name}" must match directory name "${options.directoryName}"`,
    );
  }

  const description = requiredString(raw.description, "description", "invalid_description");
  if (description.length > AGENT_SKILL_DESCRIPTION_MAX) {
    throw new SkillManifestValidationError(
      "invalid_description",
      `Skill description must contain at most ${AGENT_SKILL_DESCRIPTION_MAX} characters`,
    );
  }

  const license = optionalString(raw.license, "license");
  const compatibility = optionalString(raw.compatibility, "compatibility");
  if (compatibility && compatibility.length > AGENT_SKILL_COMPATIBILITY_MAX) {
    throw new SkillManifestValidationError(
      "invalid_compatibility",
      `Skill compatibility must contain at most ${AGENT_SKILL_COMPATIBILITY_MAX} characters`,
    );
  }
  const metadata = parseMetadata(raw.metadata);
  const allowedTools = parseAllowedTools(raw["allowed-tools"], diagnostics);
  const body = content.slice(match[0].length).trim();

  return {
    manifest: {
      name,
      description,
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
      ...(metadata ? { metadata } : {}),
      ...(allowedTools ? { allowedTools } : {}),
    },
    body,
    diagnostics,
  };
}

interface RecoveredLegacyFrontmatter {
  raw: Record<string, unknown>;
  diagnostics: SkillDiagnostic[];
}

/**
 * Recovers only the flat `key: value` format written by early Polpo versions.
 * It is intentionally not a second YAML parser: nested values and YAML
 * collection/tag syntax remain invalid, and strict imports never use it.
 */
function parseLegacyFlatFrontmatter(source: string): RecoveredLegacyFrontmatter | null {
  const raw: Record<string, unknown> = {};
  const diagnostics: SkillDiagnostic[] = [];
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/u.test(line)) return null;
    const field = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/u);
    if (!field || Object.hasOwn(raw, field[1])) return null;

    let value = field[2].trim();
    if (!value || /^[\[\]{}&*!|>]/u.test(value)) return null;
    const startsWithQuote = value.startsWith('"');
    const endsWithQuote = value.endsWith('"');
    if (startsWithQuote !== endsWithQuote) {
      value = startsWithQuote ? value.slice(1) : value.slice(0, -1);
      diagnostics.push({
        code: "legacy_unbalanced_quote_recovered",
        message: `Recovered an unmatched quote in legacy frontmatter field: ${field[1]}`,
        severity: "warning",
      });
    }
    if (!value) return null;
    raw[field[1]] = value;
  }
  return Object.keys(raw).length > 0 ? { raw, diagnostics } : null;
}

function requiredString(value: unknown, field: string, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SkillManifestValidationError(code, `Skill ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SkillManifestValidationError(`invalid_${field}`, `Skill ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new SkillManifestValidationError("invalid_metadata", "Skill metadata must be a string-to-string mapping");
  }
  const entries = Object.entries(value);
  if (entries.length > 64) {
    throw new SkillManifestValidationError("invalid_metadata", "Skill metadata must contain at most 64 entries");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || typeof item !== "string" || item.length > 1_024) {
      throw new SkillManifestValidationError("invalid_metadata", "Skill metadata keys and values must be bounded strings");
    }
    result[key] = item;
  }
  return result;
}

function parseAllowedTools(value: unknown, diagnostics: SkillDiagnostic[]): string[] | undefined {
  if (value === undefined) return undefined;
  let tools: string[];
  if (typeof value === "string") {
    tools = value.trim().split(/\s+/u).filter(Boolean);
  } else if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) {
    tools = value.map((item) => item.trim());
    diagnostics.push({
      code: "legacy_allowed_tools_array",
      message: "Legacy allowed-tools array accepted; export normalizes it to the Agent Skills string form",
      severity: "warning",
    });
  } else {
    throw new SkillManifestValidationError("invalid_allowed_tools", "allowed-tools must be a space-delimited string");
  }
  if (tools.length === 0 || tools.length > 64 || tools.some((tool) => tool.length > 128)) {
    throw new SkillManifestValidationError("invalid_allowed_tools", "allowed-tools must contain 1 to 64 bounded tool names");
  }
  return [...new Set(tools)];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
