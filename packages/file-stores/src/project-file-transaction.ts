import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";

const runtime = ".runtime/agent-store";
const pending = `${runtime}/pending.json`;
const active = new Map<string, ProjectFileTransaction>();
const require = createRequire(import.meta.url);
type FileChange = { path: string; before: string | null; after: string | null };

export class ProjectFileTransactionError extends Error {
  constructor(readonly code: "file_coordinator_unavailable" | "file_transaction_conflict" | "invalid_file_transaction", message: string) {
    super(message);
    this.name = "ProjectFileTransactionError";
  }
}

function invalid(message: string): never {
  throw new ProjectFileTransactionError("invalid_file_transaction", message);
}
function conflict(): never {
  throw new ProjectFileTransactionError("file_transaction_conflict",
    "Project files changed outside the project transaction; stop writers and reconcile the files before retrying");
}
function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableDirectory(path: string): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) invalid("Invalid project directory path");
    return;
  }
  durableDirectory(dirname(path));
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  fsyncDirectory(dirname(path));
}
function safePath(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) invalid("Invalid project file path");
  let component = root;
  for (const part of rel.split(sep)) {
    component = join(component, part);
    try {
      if (lstatSync(component).isSymbolicLink()) invalid("Symbolic links are not supported for project transaction paths");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}
function read(root: string, path: string): string | null {
  try { return readFileSync(safePath(root, path), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function durableWrite(root: string, path: string, contents: string | null): void {
  const target = safePath(root, path);
  if (contents === null) {
    if (existsSync(target)) { rmSync(target); fsyncDirectory(dirname(target)); }
    return;
  }
  durableDirectory(dirname(target));
  const temporary = join(dirname(target), `.polpo-write-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(temporary, target); fsyncDirectory(dirname(target)); }
  finally { rmSync(temporary, { force: true }); }
}
function removeAbandonedWrites(root: string, directories: Set<string>): void {
  for (const directory of directories) {
    const path = directory === "." ? root : safePath(root, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (/^\.polpo-write-[a-f0-9-]{36}\.tmp$/.test(name)) durableWrite(root, join(directory, name), null);
    }
  }
}
function validateChanges(root: string, changes: FileChange[], recovering: boolean): void {
  for (const change of changes) {
    const current = read(root, change.path);
    if (current !== change.before && (!recovering || current !== change.after)) conflict();
  }
}
function apply(root: string, changes: FileChange[]): void {
  // Validate the entire journal before touching any destination. A manual edit
  // during recovery must never be overwritten because another file matched.
  validateChanges(root, changes, true);
  for (const change of changes) {
    if (read(root, change.path) !== change.after) durableWrite(root, change.path, change.after);
  }
  removeAbandonedWrites(root, new Set(changes.map(change => dirname(change.path))));
  durableWrite(root, pending, null);
}
function recover(root: string): void {
  const contents = read(root, pending);
  if (contents === null) { removeAbandonedWrites(root, new Set([runtime])); return; }
  let journal: { version: number; changes: FileChange[] };
  try { journal = JSON.parse(contents); } catch { return invalid("Invalid project recovery journal"); }
  if (!journal || journal.version !== 1 || !Array.isArray(journal.changes)) invalid("Invalid project recovery journal");
  const paths = new Set<string>();
  for (const change of journal.changes) {
    if (!change || typeof change.path !== "string"
      || (typeof change.before !== "string" && change.before !== null)
      || (typeof change.after !== "string" && change.after !== null)) invalid("Invalid project recovery journal");
    const path = writablePath(root, change.path);
    if (paths.has(path)) invalid("Duplicate path in project recovery journal");
    paths.add(path);
  }
  apply(root, journal.changes);
}
function writablePath(root: string, path: string): string {
  const rel = relative(root, safePath(root, path)).split(sep).join("/");
  if (rel.startsWith(`${runtime}/`) && rel !== `${runtime}/state.json`) invalid("Reserved project transaction path");
  return rel;
}

/** Synchronous staged view. Never retain it across an await or after callback
 * return. All readers and writers of agent/team files share this coordinator. */
export class ProjectFileTransaction {
  private readonly changes = new Map<string, FileChange>();
  private readonly observed = new Map<string, string | null>();
  private closed = false;
  private failed = false;
  constructor(readonly root: string) {}
  private check(): void { if (this.closed) invalid("Project transaction is closed"); }
  read(path: string): string | null {
    this.check();
    const key = relative(this.root, safePath(this.root, path)).split(sep).join("/");
    const staged = this.changes.get(key);
    if (staged) return staged.after;
    if (!this.observed.has(key)) this.observed.set(key, read(this.root, key));
    return this.observed.get(key)!;
  }
  exists(path: string): boolean {
    this.check();
    const key = relative(this.root, safePath(this.root, path)).split(sep).join("/");
    if (this.changes.has(key)) return this.changes.get(key)!.after !== null;
    if ([...this.changes.values()].some(c => c.path.startsWith(`${key}/`) && c.after !== null)) return true;
    return existsSync(safePath(this.root, path));
  }
  isDirectory(path: string): boolean {
    this.check();
    const target = safePath(this.root, path);
    if (existsSync(target)) return lstatSync(target).isDirectory();
    const prefix = relative(this.root, target).split(sep).join("/") + "/";
    return [...this.changes.values()].some(c => c.path.startsWith(prefix) && c.after !== null);
  }
  list(path: string): string[] {
    this.check();
    const target = safePath(this.root, path);
    const prefix = relative(this.root, target).split(sep).join("/") + "/";
    const names = new Set(existsSync(target) ? readdirSync(target) : []);
    for (const c of this.changes.values()) {
      if (!c.path.startsWith(prefix)) continue;
      const child = c.path.slice(prefix.length);
      if (c.after !== null) names.add(child.split("/")[0]);
      else if (!child.includes("/")) names.delete(child);
    }
    return [...names].sort((a, b) => a.localeCompare(b, "en"));
  }
  write(path: string, after: string | null): void {
    this.check();
    const key = writablePath(this.root, path);
    const existing = this.changes.get(key);
    const before = existing ? existing.before : this.read(key);
    this.changes.set(key, { path: key, before, after });
  }
  run<T>(fn: (transaction: ProjectFileTransaction) => T): T {
    try {
      if (fn.constructor.name === "AsyncFunction") invalid("Project transaction callbacks must be synchronous");
      const result = fn(this);
      if (result && typeof (result as { then?: unknown }).then === "function") invalid("Project transaction callbacks must be synchronous");
      return result;
    } catch (error) { this.failed = true; throw error; }
  }
  finish(): void {
    this.check();
    if (this.failed) invalid("Project transaction was aborted");
    const changes = [...this.changes.values()].filter(c => c.before !== c.after);
    if (!changes.length) return;
    // Check reads too: derivations must still use the configuration observed.
    validateChanges(this.root, [...this.observed].map(([path, before]) => ({ path, before, after: before })), false);
    durableWrite(this.root, pending, JSON.stringify({ version: 1, changes }));
    // From this durable point the transaction is committed. An interrupted
    // caller may not have its acknowledgement; the next participant recovers.
    apply(this.root, changes);
  }
  close(): void { this.closed = true; }
}

/** SQLite supplies only the cross-process OS lock. Authored files remain the
 * source configuration; the forward journal is durable before files change.
 * BEGIN IMMEDIATE stays held through recovery, reads, validation and fsyncs.
 * A killed process releases it without timestamps, PID stealing or stale TTLs. */
export function withProjectFileTransaction<T>(polpoDir: string, fn: (transaction: ProjectFileTransaction) => T): T {
  mkdirSync(polpoDir, { recursive: true });
  const root = realpathSync(polpoDir);
  const nested = active.get(root);
  if (nested) return nested.run(fn);
  let SQLite: typeof Database;
  try { SQLite = require("better-sqlite3") as typeof Database; }
  catch {
    throw new ProjectFileTransactionError("file_coordinator_unavailable",
      "Agent and team file persistence requires better-sqlite3 for cross-process locking; install optional dependencies");
  }
  durableDirectory(safePath(root, runtime));
  const databasePath = safePath(root, `${runtime}/coordinator.sqlite`);
  let db: Database.Database;
  try { db = new SQLite(databasePath, { timeout: 5000 }); }
  catch (error) {
    throw new ProjectFileTransactionError("file_coordinator_unavailable",
      `Could not open the project file coordinator: ${(error as Error).message}`);
  }
  const transaction = new ProjectFileTransaction(root);
  try {
    db.exec("BEGIN IMMEDIATE");
    recover(root);
    active.set(root, transaction);
    const result = transaction.run(fn);
    transaction.finish();
    return result;
  } finally {
    transaction.close();
    active.delete(root);
    try { if (db.inTransaction) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}
