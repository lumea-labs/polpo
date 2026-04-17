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
  /** --force / --yes: always override without asking. */
  force: boolean;
  /** TTY present: can prompt the user. */
  interactive: boolean;
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

// ── Deploy direction: local data → remote data ───────────────

/**
 * Compare local data against remote data (both in-memory). Used by deploy
 * to detect when a cloud resource differs from the local version.
 *
 * - Remote is null/undefined → "write" (doesn't exist yet, create)
 * - Data identical → "skip" (no change needed)
 * - Data differs → same force/interactive/skip logic
 */
export async function resolveDeployConflict(
  localData: unknown,
  remoteData: unknown | null | undefined,
  label: string,
  opts: ConflictOptions,
): Promise<ConflictAction> {
  if (remoteData == null) return "write";

  if (JSON.stringify(normalize(localData)) === JSON.stringify(normalize(remoteData))) {
    return "skip";
  }

  return resolveConflictPrompt(`${label} differs from cloud version. Push local?`, opts);
}

// ── Shared prompt logic ──────────────────────────────────────

async function resolveConflictPrompt(
  message: string,
  opts: ConflictOptions,
): Promise<ConflictAction> {
  if (opts.force) return "write";

  if (opts.interactive) {
    const answer = await clack.confirm({
      message,
      initialValue: true,
    });
    if (clack.isCancel(answer) || !answer) return "skip";
    return "write";
  }

  return "skip";
}

/**
 * Normalize an object for comparison — strip undefined values and
 * sort keys so field ordering doesn't cause false conflicts.
 */
function normalize(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data));
}
