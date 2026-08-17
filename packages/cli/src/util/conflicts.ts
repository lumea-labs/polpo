/**
 * Conflict resolution for pull/deploy sync operations.
 *
 * Compares local and remote content, prompts the user when they differ
 * (interactive mode), or auto-overrides (force mode). Smart default: YES
 * — the user explicitly ran pull or deploy, so they expect changes.
 *
 * Three variants:
 *   - resolveFileConflict:  new string  vs existing local file
 *   - resolveJsonConflict:  new object  vs existing local JSON file
 *   - resolveDataConflict:  local data  vs remote data (in-memory, no filesystem)
 */
import * as fs from "node:fs";
import * as clack from "@clack/prompts";

export interface ConflictOptions {
  /** --force: always override without asking. */
  force: boolean;
  /** TTY present: can prompt the user. */
  interactive: boolean;
  /**
   * Called just before a user prompt fires. Lets the caller stop any active
   * spinner so the prompt isn't drawn on top of "Deploying X…" (clack draws
   * both on the same row otherwise → flicker, prompt invisible).
   * Called only when the conflict actually triggers a prompt.
   */
  beforePrompt?: () => void;
  /** Called after the user has answered, so the caller can restart its spinner. */
  afterPrompt?: () => void;
}

export type ConflictAction = "write" | "skip";

// ── Pull direction: new content → local file ─────────────────

/**
 * Compare new content against an existing file.
 *
 * - File doesn't exist → "write"
 * - Content identical → "skip"
 * - Content differs + force → "write"
 * - Content differs + interactive → prompt (default YES)
 * - Content differs + non-interactive → "skip"
 */
export async function resolveFileConflict(
  filePath: string,
  newContent: string,
  label: string,
  opts: ConflictOptions,
): Promise<ConflictAction> {
  if (!fs.existsSync(filePath)) return "write";

  const existing = fs.readFileSync(filePath, "utf-8");
  if (existing === newContent) return "skip";

  return resolveConflictPrompt(`${label} differs from local version. Override local?`, opts);
}

/**
 * Same as resolveFileConflict but normalizes JSON formatting before
 * comparing to avoid false conflicts from whitespace differences.
 */
export async function resolveJsonConflict(
  filePath: string,
  newData: unknown,
  label: string,
  opts: ConflictOptions,
): Promise<ConflictAction> {
  if (!fs.existsSync(filePath)) return "write";

  try {
    const existingRaw = fs.readFileSync(filePath, "utf-8");
    const existingData = JSON.parse(existingRaw);
    if (JSON.stringify(existingData) === JSON.stringify(newData)) return "skip";
  } catch {
    // Can't parse existing file — treat as conflict
  }

  return resolveConflictPrompt(`${label} differs from local version. Override local?`, opts);
}

/** Compare an incoming cloud value with local in-memory data during pull. */
export async function resolveDataConflict(
  incomingData: unknown,
  localData: unknown | null | undefined,
  label: string,
  opts: ConflictOptions,
): Promise<ConflictAction> {
  if (localData == null) return "write";
  if (stableStringify(strip(normalize(incomingData))) === stableStringify(strip(normalize(localData)))) {
    return "skip";
  }
  return resolveConflictPrompt(`${label} differs from local version. Override local?`, opts);
}

// ── Deploy direction: local data → remote data ───────────────

/**
 * Compare local data against remote data (both in-memory). Used by deploy
 * to detect when a cloud resource differs from the local version.
 *
 * - Remote is null/undefined → "write" (doesn't exist yet, create)
 * - Data identical → "skip" (no change needed)
 * - Data differs → same force/interactive/skip logic
 *
 * The optional `compareKeys` argument lets the caller specify exactly which
 * fields to diff. Without it, a denylist of server-managed fields (id,
 * timestamps, etc.) is stripped from both sides so a remote that carries
 * extra metadata doesn't trigger false-positive "differs" prompts. Without
 * this guard every existing resource looks "different" and the user gets
 * spammed with prompts (or, worse, in non-TTY non-force mode every existing
 * resource is silently skipped).
 */
export async function resolveDeployConflict(
  localData: unknown,
  remoteData: unknown | null | undefined,
  label: string,
  opts: ConflictOptions,
  compareKeys?: string[],
): Promise<ConflictAction> {
  if (remoteData == null) return "write";

  const a = compareKeys ? project(localData, compareKeys) : strip(normalize(localData));
  const b = compareKeys ? project(remoteData, compareKeys) : strip(normalize(remoteData));
  if (stableStringify(a) === stableStringify(b)) return "skip";

  return resolveConflictPrompt(`${label} differs from cloud version. Push local?`, opts);
}

// ── Shared prompt logic ──────────────────────────────────────

async function resolveConflictPrompt(
  message: string,
  opts: ConflictOptions,
): Promise<ConflictAction> {
  if (opts.force) return "write";

  if (opts.interactive) {
    opts.beforePrompt?.();
    try {
      const answer = await clack.confirm({
        message,
        initialValue: true,
      });
      if (clack.isCancel(answer) || !answer) return "skip";
      return "write";
    } finally {
      opts.afterPrompt?.();
    }
  }

  // Non-interactive, non-force: default to WRITE so CI/scripted deploys
  // don't silently no-op on every existing resource. Old behavior was
  // "skip" — looked safer but in practice meant "deploy did nothing"
  // with no log line for the user to notice.
  return "write";
}

/**
 * Server-managed fields that local JSON never contains. Stripped before
 * the local-vs-remote diff so a remote response carrying these doesn't
 * make every existing resource look "different".
 */
const SERVER_ONLY_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "created_at",
  "updated_at",
  "projectId",
  "orgId",
  "owner",
  "team",        // attached server-side when an agent is returned
  "agents",      // teams come back with their member list
  "lastUsedAt",
  "keyPrefix",
]);

function normalize(data: unknown): unknown {
  return data == null ? data : JSON.parse(JSON.stringify(data));
}

function strip(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(strip);
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (SERVER_ONLY_FIELDS.has(k)) continue;
      if (v === undefined) continue;
      out[k] = strip(v);
    }
    return out;
  }
  return data;
}

function project(data: unknown, keys: string[]): unknown {
  if (data == null || typeof data !== "object") return data;
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in src && src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

/**
 * JSON.stringify with deterministic key ordering, so two objects whose keys
 * arrived in different orders still produce identical strings. Plain
 * JSON.stringify is order-preserving but that order depends on the insertion
 * order at each layer — which can drift between client + server.
 */
function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}
