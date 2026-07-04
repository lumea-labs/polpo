/**
 * Playbook pure logic — parameter validation, instantiation, and
 * definition validation. No filesystem access: discovery/persistence
 * live in @polpo-ai/file-stores (playbook-files).
 */

import type { PlaybookParameter, PlaybookDefinition } from "./playbook-store.js";

// ── Parameter Validation ───────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Non-blocking issues (e.g. unknown parameters). */
  warnings: string[];
  /** Resolved params with defaults applied. */
  resolved: Record<string, string | number | boolean>;
}

/**
 * Validate user-provided parameters against the playbook definition.
 * Applies defaults, checks required fields, types, and enum constraints.
 */
export function validateParams(
  playbook: PlaybookDefinition,
  params: Record<string, string | number | boolean>,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: Record<string, string | number | boolean> = {};
  const defs = playbook.parameters ?? [];

  for (const def of defs) {
    const value = params[def.name];

    if (value === undefined || value === "") {
      if (def.default !== undefined) {
        resolved[def.name] = def.default;
      } else if (def.required) {
        errors.push(`Missing required parameter: ${def.name}`);
      }
      continue;
    }

    // Type coercion & validation
    const expectedType = def.type ?? "string";

    if (expectedType === "number") {
      const num = Number(value);
      if (isNaN(num)) {
        errors.push(`Parameter "${def.name}" must be a number, got: ${value}`);
        continue;
      }
      resolved[def.name] = num;
    } else if (expectedType === "boolean") {
      if (typeof value === "boolean") {
        resolved[def.name] = value;
      } else {
        const str = String(value).toLowerCase();
        if (str === "true" || str === "1" || str === "yes") {
          resolved[def.name] = true;
        } else if (str === "false" || str === "0" || str === "no") {
          resolved[def.name] = false;
        } else {
          errors.push(`Parameter "${def.name}" must be a boolean, got: ${value}`);
          continue;
        }
      }
    } else {
      resolved[def.name] = String(value);
    }

    // Enum check
    if (def.enum && def.enum.length > 0) {
      if (!def.enum.includes(resolved[def.name] as string | number)) {
        errors.push(`Parameter "${def.name}" must be one of: ${def.enum.join(", ")}. Got: ${resolved[def.name]}`);
      }
    }
  }

  // Warn about unknown parameters (non-blocking)
  for (const key of Object.keys(params)) {
    if (!defs.some(d => d.name === key)) {
      warnings.push(`Unknown parameter: ${key}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings, resolved };
}

// ── Instantiation ──────────────────────────────────────────────────────

/**
 * Instantiate a playbook with resolved parameters.
 *
 * 1. Serializes the mission to JSON string
 * 2. Replaces all {{placeholder}} with parameter values
 * 3. Re-parses the JSON to validate structural integrity
 * 4. Returns the mission data string ready for missionExecutor.createMission()
 */
export function instantiatePlaybook(
  playbook: PlaybookDefinition,
  resolved: Record<string, string | number | boolean>,
): { name: string; data: string; prompt: string } {
  let json = JSON.stringify(playbook.mission);

  // Replace all {{param}} placeholders
  for (const [key, value] of Object.entries(resolved)) {
    const placeholder = `{{${key}}}`;
    // Use split+join for global replace (avoids regex special chars)
    json = json.split(placeholder).join(String(value));
  }

  // Check for unreplaced placeholders
  const unreplaced = json.match(/\{\{([^}]+)\}\}/g);
  if (unreplaced) {
    const names = [...new Set(unreplaced.map(m => m.slice(2, -2)))];
    throw new Error(`Unreplaced placeholders in playbook "${playbook.name}": ${names.join(", ")}`);
  }

  // Validate the resulting JSON is still valid
  try {
    JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Playbook "${playbook.name}" produced invalid JSON after parameter substitution: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Build a human-readable prompt describing what was executed
  const paramDesc = Object.entries(resolved)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const prompt = `playbook:${playbook.name}${paramDesc ? ` (${paramDesc})` : ""}`;

  return { name: playbook.name, data: json, prompt };
}


/**
 * Validate a playbook definition object structurally.
 * Returns an array of error strings (empty = valid).
 */
export function validatePlaybookDefinition(def: Partial<PlaybookDefinition>): string[] {
  const errors: string[] = [];

  if (!def.name || typeof def.name !== "string") {
    errors.push("Missing or invalid 'name' (must be a non-empty string).");
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(def.name)) {
    errors.push(`Invalid name "${def.name}" — must be kebab-case (e.g. "bug-fix", "code-review").`);
  }

  if (!def.description || typeof def.description !== "string") {
    errors.push("Missing or invalid 'description' (must be a non-empty string).");
  }

  if (!def.mission || typeof def.mission !== "object") {
    errors.push("Missing or invalid 'mission' (must be an object).");
  }

  if (def.parameters !== undefined) {
    if (!Array.isArray(def.parameters)) {
      errors.push("'parameters' must be an array if provided.");
    } else {
      for (const [i, p] of def.parameters.entries()) {
        if (!p.name || typeof p.name !== "string") {
          errors.push(`Parameter [${i}]: missing or invalid 'name'.`);
        }
        if (!p.description || typeof p.description !== "string") {
          errors.push(`Parameter [${i}]: missing or invalid 'description'.`);
        }
        if (p.type && !["string", "number", "boolean"].includes(p.type)) {
          errors.push(`Parameter [${i}]: invalid type "${p.type}" (must be string|number|boolean).`);
        }
      }
    }
  }

  // Check that all placeholders in the mission have matching parameter declarations
  if (def.mission && typeof def.mission === "object" && def.parameters) {
    const json = JSON.stringify(def.mission);
    const placeholders = json.match(/\{\{([^}]+)\}\}/g);
    if (placeholders) {
      const usedNames = new Set(placeholders.map(m => m.slice(2, -2)));
      const declaredNames = new Set(def.parameters.map(p => p.name));
      for (const name of usedNames) {
        if (!declaredNames.has(name)) {
          errors.push(`Placeholder "{{${name}}}" in mission has no matching parameter declaration.`);
        }
      }

      // Check that optional params without defaults don't have placeholders in the mission.
      // If they do, omitting the param at runtime would leave the placeholder unreplaced and crash.
      for (const p of def.parameters) {
        if (!p.required && p.default === undefined && usedNames.has(p.name)) {
          errors.push(
            `Parameter "${p.name}" is optional with no default but is used as "{{${p.name}}}" in the mission. ` +
            `Either mark it as required, provide a default value, or remove the placeholder.`,
          );
        }
      }
    }
  }

  return errors;
}

