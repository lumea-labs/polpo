/** Authenticated caller context shared by synchronous and queued invocations.
 * This is not model-authored task data and never supplies agent/run identity. */
export function normalizeRuntimeMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Runtime metadata must be a string map");
  }
  const entries = Object.entries(value);
  if (entries.length > 16 || entries.some(([key, item]) => key.length > 64 || typeof item !== "string" || item.length > 512)) {
    throw new TypeError("Runtime metadata allows 16 keys, keys up to 64 characters and string values up to 512 characters");
  }
  // fromEntries treats __proto__ as data; sorted keys also give admission a
  // stable comparison across JSON files, SQLite text and PostgreSQL JSONB.
  return Object.freeze(Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

export function sameRuntimeMetadata(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeRuntimeMetadata(left)) === JSON.stringify(normalizeRuntimeMetadata(right));
}
