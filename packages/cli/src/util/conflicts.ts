/**
 * Conflict resolution for pull/deploy sync operations.
 *
 * Compares local and remote content, prompts the user when they differ
 * (interactive mode), or auto-overrides (force mode). Smart default: YES
 * — the user explicitly ran pull or deploy, so they expect changes.
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

/**
 * Compare new content against an existing file. Returns "write" if the
 * file should be written, "skip" if the user declined.
 *
 * - File doesn't exist → always "write" (no conflict)
 * - Content identical → always "skip" (nothing to do)
 * - Content differs + force → "write"
 * - Content differs + interactive → prompt with smart default YES
 * - Content differs + non-interactive + !force → "skip" (safe default)
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

  // Content differs — conflict
  if (opts.force) return "write";

  if (opts.interactive) {
    const answer = await clack.confirm({
      message: `${label} differs from local version. Override local?`,
      initialValue: true,
    });
    if (clack.isCancel(answer) || !answer) return "skip";
    return "write";
  }

  // Non-interactive, no force → safe skip
  return "skip";
}

/**
 * Same as resolveFileConflict but for JSON content — normalizes
 * formatting before comparing so insignificant whitespace differences
 * don't trigger false conflicts.
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
    // Compare normalized JSON to ignore formatting differences
    if (JSON.stringify(existingData) === JSON.stringify(newData)) return "skip";
  } catch {
    // Can't parse existing file — treat as conflict
  }

  if (opts.force) return "write";

  if (opts.interactive) {
    const answer = await clack.confirm({
      message: `${label} differs from local version. Override local?`,
      initialValue: true,
    });
    if (clack.isCancel(answer) || !answer) return "skip";
    return "write";
  }

  return "skip";
}
