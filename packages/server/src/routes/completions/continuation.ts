import { createHash } from "node:crypto";

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function continuationFingerprint(input: {
  sessionId: string;
  agent: string;
  loop: string;
  user?: string;
  toolCallId: string;
  expectedSessionVersion: number;
  result: unknown;
}): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}
