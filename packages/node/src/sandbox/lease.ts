/**
 * SandboxLease — a per-run lease over a {@link SandboxProvider} that adds the
 * three things the proxy execution model needs on top of a raw session:
 *
 *  - LAZY ACQUIRE: the session opens on the first fs/shell operation, so a run
 *    whose loop only reasons/talks never opens one (nothing to bill).
 *  - INTRA-RUN SUSPEND: a refcount tracks in-flight fs/shell ops; when it hits
 *    zero the compute is suspended after `idleSuspendMs` (the model is
 *    thinking), and resumed on the next op. Parallel ops share one sandbox and
 *    one resume, and it is never suspended mid-operation. No-op when the
 *    session has no {@link SandboxLifecycle} (e.g. the local machine).
 *  - METERING: the acquire→release window minus suspended gaps is the run's
 *    real sandbox-milliseconds, emitted once via `onUsage` on dispose.
 *
 * This generalises the cloud's Sandbox-object lease to the {@link FileSystem}
 * and {@link Shell} ports, so any backend (local, docker, daytona, remote)
 * gets the same behaviour behind one port.
 */
import type {
  FileSystem,
  Shell,
  FileEntry,
  SandboxProvider,
  SandboxSession,
  SandboxLifecycle,
  SandboxUsage,
} from "@polpo-ai/core";

/** Default idle window before an unused sandbox's compute is suspended. */
export const DEFAULT_IDLE_SUSPEND_MS = 1500;

export interface SandboxLeaseOptions {
  /** Clock injection for testing. */
  now?: () => number;
  /** Called once on dispose with the run's sandbox usage. */
  onUsage?: (usage: SandboxUsage) => void;
  /** Idle window (ms) before suspending compute. Default 1500. */
  idleSuspendMs?: number;
  /** Project id propagated into the emitted usage. */
  projectId?: string;
}

export class SandboxLease {
  private sessionPromise: Promise<SandboxSession> | null = null;
  private session: SandboxSession | null = null;
  private lifecycle?: SandboxLifecycle;
  private acquired = false;

  private inFlight = 0;
  private running = false;
  private runningSince = 0;
  private runningMs = 0;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeLock: Promise<void> | null = null;
  private released = false;

  private readonly now: () => number;
  private readonly onUsage?: (usage: SandboxUsage) => void;
  private readonly idleSuspendMs: number;
  private readonly projectId?: string;

  /** Activity-wrapped filesystem — hand this to the in-process tool ports. */
  readonly fs: FileSystem;
  /** Activity-wrapped shell — hand this to the in-process tool ports. */
  readonly shell: Shell;

  constructor(
    private readonly provider: SandboxProvider,
    private readonly runId: string,
    opts: SandboxLeaseOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.onUsage = opts.onUsage;
    this.idleSuspendMs = opts.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS;
    this.projectId = opts.projectId;
    this.fs = this.makeFs();
    this.shell = this.makeShell();
  }

  /** Whether the run ever opened a session. */
  get wasAcquired(): boolean {
    return this.acquired;
  }

  // ── session lifecycle ──────────────────────────────────────────────────

  private ensureSession(): Promise<SandboxSession> {
    if (!this.sessionPromise) {
      this.sessionPromise = Promise.resolve(this.provider.open(this.runId)).then((s) => {
        this.session = s;
        this.lifecycle = s.lifecycle;
        this.acquired = true;
        this.running = true;
        this.runningSince = this.now();
        return s;
      });
    }
    return this.sessionPromise;
  }

  /** Release the sandbox and emit usage. Idempotent. */
  async dispose(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.clearIdle();
    if (this.running) {
      this.runningMs += this.now() - this.runningSince;
      this.running = false;
    }
    let sandboxId: string | undefined;
    if (this.session) {
      try { sandboxId = this.session.usage?.().sandboxId; } catch { /* ignore */ }
      try { await this.session.dispose(); } catch { /* best-effort */ }
    }
    this.onUsage?.({
      runId: this.runId,
      projectId: this.projectId,
      acquired: this.acquired,
      sandboxMs: this.acquired ? Math.max(0, this.runningMs) : 0,
      sandboxId,
    });
  }

  // ── activity tracking ──────────────────────────────────────────────────

  private async activityStart(): Promise<void> {
    this.clearIdle();
    this.inFlight++;
    if (!this.running) await this.ensureRunning();
  }

  private activityEnd(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0) this.armIdle();
  }

  /** Resume the compute on demand; a single resume is shared by parallel ops. */
  private async ensureRunning(): Promise<void> {
    if (this.running || !this.lifecycle) return;
    if (!this.resumeLock) {
      const lc = this.lifecycle;
      this.resumeLock = lc.resume().then(() => {
        this.running = true;
        this.runningSince = this.now();
        this.resumeLock = null;
      });
    }
    await this.resumeLock;
  }

  private armIdle(): void {
    if (!this.lifecycle || this.released) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => { void this.suspend(); }, this.idleSuspendMs);
    // Never keep the process alive just to suspend an idle sandbox.
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async suspend(): Promise<void> {
    if (this.inFlight > 0 || !this.running || !this.lifecycle || this.released) return;
    this.running = false;
    this.runningMs += this.now() - this.runningSince;
    try {
      await this.lifecycle.suspend();
    } catch {
      // Suspend failed — treat as still running so metering stays honest and
      // the next op doesn't try to resume an already-running sandbox.
      this.running = true;
      this.runningSince = this.now();
    }
  }

  /** Open (lazily), bracket a fs/shell op with the refcount, and run it. */
  private async bracket<T>(op: (s: SandboxSession) => Promise<T>): Promise<T> {
    const session = await this.ensureSession();
    await this.activityStart();
    try {
      return await op(session);
    } finally {
      this.activityEnd();
    }
  }

  // ── activity-wrapped ports ──────────────────────────────────────────────
  // The optional FileSystem methods are always present on the lease (callers
  // may feature-detect them) and fall back to the required methods when the
  // backend doesn't implement them — same fallbacks the file routes use.

  private makeFs(): FileSystem {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    return {
      readFile: (p) => this.bracket((s) => s.fs.readFile(p)),
      writeFile: (p, c) => this.bracket((s) => s.fs.writeFile(p, c)),
      exists: (p) => this.bracket((s) => s.fs.exists(p)),
      readdir: (p) => this.bracket((s) => s.fs.readdir(p)),
      mkdir: (p) => this.bracket((s) => s.fs.mkdir(p)),
      remove: (p) => this.bracket((s) => s.fs.remove(p)),
      stat: (p) => this.bracket((s) => s.fs.stat(p)),
      rename: (o, n) => this.bracket((s) => s.fs.rename(o, n)),
      readdirWithTypes: (p) => this.bracket((s) =>
        s.fs.readdirWithTypes
          ? s.fs.readdirWithTypes(p)
          : s.fs.readdir(p).then((names: string[]): FileEntry[] =>
              names.map((name: string) => ({ name, isDirectory: false, isFile: true }))),
      ),
      readFileBuffer: (p) => this.bracket((s) =>
        s.fs.readFileBuffer ? s.fs.readFileBuffer(p) : s.fs.readFile(p).then((t: string) => enc.encode(t)),
      ),
      writeFileBuffer: (p, d) => this.bracket((s) =>
        s.fs.writeFileBuffer ? s.fs.writeFileBuffer(p, d) : s.fs.writeFile(p, dec.decode(d)),
      ),
    };
  }

  private makeShell(): Shell {
    return {
      execute: (cmd, opts) => this.bracket((s) => s.shell.execute(cmd, opts)),
    };
  }
}
