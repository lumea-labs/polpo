/** Deterministic, provider-neutral tool capability policy resolution. */

export const ALLOWED_TOOL_POLICY_LAYERS = [
  "global",
  "mode",
  "route",
  "request",
  "execution",
  "loop",
  "step",
  "grant",
] as const;

export type AllowedToolPolicyLayerName = typeof ALLOWED_TOOL_POLICY_LAYERS[number];

export type AllowedToolPolicyInput = Partial<
  Record<AllowedToolPolicyLayerName, readonly string[]>
>;

/** Reusable authored capability restriction for one execution mode. */
export interface AllowedToolsSettings {
  allowedTools?: readonly string[];
}

export type AllowedToolPolicyLayer = Readonly<{
  name: AllowedToolPolicyLayerName;
  allowedTools: readonly string[];
}>;

export type ResolvedAllowedToolPolicy = Readonly<{
  layers: readonly AllowedToolPolicyLayer[];
  restricted: boolean;
}>;

export class ToolPolicyDeniedError extends Error {
  readonly code = "tool_policy_denied";

  constructor(
    readonly toolName: string,
    readonly layers: readonly AllowedToolPolicyLayerName[],
  ) {
    super(`Tool "${toolName}" is not allowed by the effective execution policy`);
    this.name = "ToolPolicyDeniedError";
  }
}

function normalizeAllowedTools(
  value: readonly string[],
  layer: AllowedToolPolicyLayerName,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${layer}.allowedTools must be an array`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new TypeError(`${layer}.allowedTools[${index}] must be a non-empty string`);
    }
    const tool = entry.trim();
    const key = tool.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      throw new TypeError(`${layer}.allowedTools contains duplicate tool pattern "${tool}"`);
    }
    seen.add(key);
    normalized.push(tool);
  }
  return Object.freeze(normalized);
}

export function resolveAllowedToolPolicy(
  input: AllowedToolPolicyInput,
): ResolvedAllowedToolPolicy {
  const layers: AllowedToolPolicyLayer[] = [];
  for (const name of ALLOWED_TOOL_POLICY_LAYERS) {
    const allowedTools = input[name];
    if (allowedTools === undefined) continue;
    layers.push(Object.freeze({
      name,
      allowedTools: normalizeAllowedTools(allowedTools, name),
    }));
  }
  return Object.freeze({
    layers: Object.freeze(layers),
    restricted: layers.length > 0,
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function toolNameMatchesAllowedPattern(
  toolName: string,
  pattern: string,
): boolean {
  const source = escapeRegex(pattern.trim())
    .replace(/\*/g, ".*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${source}$`, "iu").test(toolName.trim());
}

export function toolNameAllowedByPolicy(
  toolName: string,
  policy: ResolvedAllowedToolPolicy,
): boolean {
  if (!toolName.trim()) return false;
  return policy.layers.every((layer) =>
    layer.allowedTools.some((pattern) =>
      toolNameMatchesAllowedPattern(toolName, pattern)));
}

export function assertToolNameAllowedByPolicy(
  toolName: string,
  policy: ResolvedAllowedToolPolicy,
): void {
  if (toolNameAllowedByPolicy(toolName, policy)) return;
  throw new ToolPolicyDeniedError(
    toolName,
    policy.layers.map((layer) => layer.name),
  );
}

export function filterToolNamesByPolicy(
  toolNames: readonly string[],
  policy: ResolvedAllowedToolPolicy,
): string[] {
  return toolNames.filter((name) => toolNameAllowedByPolicy(name, policy));
}
