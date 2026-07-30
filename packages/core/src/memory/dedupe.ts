import { MemoryContractError } from "./errors.js";
import { memoryScopeKey } from "./scope.js";
import { MEMORY_KINDS, type MemoryDedupeInput } from "./types.js";

const memoryKinds = new Set<string>(MEMORY_KINDS);

export function normalizeMemoryDedupeContent(content: string): string {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new MemoryContractError(
      "Memory dedupe content must be a non-empty string",
      "invalid_item",
      "content",
    );
  }
  return content.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function createMemoryDedupeIdentity(
  input: MemoryDedupeInput,
): string {
  if (!memoryKinds.has(input.kind)) {
    throw new MemoryContractError(
      `Unknown Memory kind: ${String(input.kind)}`,
      "invalid_item",
      "kind",
    );
  }
  return JSON.stringify([
    memoryScopeKey(input.scope),
    input.kind,
    normalizeMemoryDedupeContent(input.content),
  ]);
}
