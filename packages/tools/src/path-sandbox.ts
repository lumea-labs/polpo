/**
 * Path sandboxing for agent filesystem access.
 *
 * When an agent has `allowedPaths` configured, all file tool operations
 * (read/write/edit/glob/grep/ls) validate that resolved paths fall within
 * the allowed directories. This prevents agents from escaping their workspace
 * via absolute paths or `../` traversal.
 *
 * The bash tool cannot be fully sandboxed at this level (arbitrary shell commands),
 * but its cwd is set to the agent's primary allowed path.
 */

import { basename, dirname, join, resolve, sep } from "node:path";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";

/** Upper bound on symlink hops while canonicalizing a not-yet-existing path. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Canonicalize a path that may not exist yet.
 *
 * `realpathSync` only works for existing paths, so a new file under a
 * symlinked directory (`sandbox/link -> /etc`, writing `sandbox/link/x`) used
 * to fall back to the logical path and pass the prefix check. Instead, resolve
 * the deepest existing ancestor, then re-append the missing segments. Dangling
 * symlinks are followed to their target so a write cannot create a file
 * outside the sandbox through them. Returns undefined when the path cannot be
 * canonicalized safely (symlink loops / too many hops) — callers must deny.
 */
function canonicalizePath(filePath: string, hops = { count: 0 }): string | undefined {
  const absolute = resolve(filePath);
  try {
    return realpathSync(absolute);
  } catch { /* missing path, dangling symlink, or loop — walk up */ }

  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  const canonicalParent = canonicalizePath(parent, hops);
  if (canonicalParent === undefined) return undefined;
  const candidate = join(canonicalParent, basename(absolute));

  let isSymlink = false;
  try { isSymlink = lstatSync(candidate).isSymbolicLink(); } catch { /* does not exist */ }
  if (!isSymlink) return candidate;

  hops.count += 1;
  if (hops.count > MAX_SYMLINK_HOPS) return undefined;
  let target: string;
  try { target = readlinkSync(candidate); } catch { return undefined; }
  return canonicalizePath(resolve(canonicalParent, target), hops);
}

/**
 * Resolve allowedPaths to absolute paths, normalizing relative paths against cwd.
 * If no allowedPaths are configured, defaults to [cwd] (the project workDir).
 */
export function resolveAllowedPaths(cwd: string, allowedPaths?: string[]): string[] {
  if (!allowedPaths || allowedPaths.length === 0) {
    return [resolve(cwd)];
  }
  return allowedPaths.map((p) => resolve(cwd, p));
}

/**
 * Check whether a resolved absolute path falls within any of the allowed directories.
 * Uses path prefix matching with separator awareness to prevent partial matches
 * (e.g. `/home/user/project-evil` should NOT match `/home/user/project`).
 */
export function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  // Resolve symlinks (including those on the ancestors of paths that do not
  // exist yet) to prevent symlink-based sandbox escape.
  const resolved = canonicalizePath(filePath);
  if (resolved === undefined) return false;
  for (const allowed of allowedPaths) {
    // Compare canonical with canonical: an allowed root reached through a
    // symlink (e.g. macOS /tmp -> /private/tmp) must still match.
    const normalizedAllowed = canonicalizePath(allowed);
    if (normalizedAllowed === undefined) continue;
    // Exact match
    if (resolved === normalizedAllowed) return true;
    // Prefix match with separator (e.g. /foo/bar/ is prefix of /foo/bar/baz)
    const prefix = normalizedAllowed.endsWith(sep) ? normalizedAllowed : normalizedAllowed + sep;
    if (resolved.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Validate a path and throw a descriptive error if it's outside the sandbox.
 * Call this in every file tool's execute() before performing the operation.
 */
export function assertPathAllowed(filePath: string, allowedPaths: string[], toolName: string): void {
  if (!isPathAllowed(filePath, allowedPaths)) {
    const dirs = allowedPaths.join(", ");
    throw new Error(
      `[sandbox] ${toolName}: access denied — "${filePath}" is outside allowed directories [${dirs}]`,
    );
  }
}
