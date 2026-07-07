import { describe, it, expect, vi } from "vitest";
import type {
  SandboxProvider,
  SandboxSession,
  SandboxLifecycle,
  SandboxUsage,
} from "../sandbox-provider.js";
import type { FileSystem } from "../filesystem.js";
import type { Shell } from "../shell.js";

// Minimal stubs — the port composition is what's under test, not the full
// FileSystem/Shell surface, so those are cast from empty objects.
const fs = {} as FileSystem;
const shell = {} as Shell;

/** A fake provider that exercises every optional capability of the port. */
function fakeProvider(): { provider: SandboxProvider; disposed: () => boolean } {
  let ms = 0;
  let live = true;
  const lifecycle: SandboxLifecycle = {
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
  };
  const provider: SandboxProvider = {
    open(runId): SandboxSession {
      return {
        fs,
        shell,
        lifecycle,
        usage(): SandboxUsage {
          return { runId, projectId: "p1", acquired: 1000, sandboxMs: (ms += 5), sandboxId: "sb-1" };
        },
        async dispose() {
          live = false;
        },
      };
    },
  };
  return { provider, disposed: () => !live };
}

describe("SandboxProvider port", () => {
  it("opens a session exposing fs + shell", async () => {
    const { provider } = fakeProvider();
    const session = await provider.open("run-1");
    expect(session.fs).toBe(fs);
    expect(session.shell).toBe(shell);
  });

  it("supports the optional lifecycle (suspend/resume)", async () => {
    const { provider } = fakeProvider();
    const session = await provider.open("run-1");
    await session.lifecycle?.suspend();
    await session.lifecycle?.resume();
    expect(session.lifecycle!.suspend).toHaveBeenCalledOnce();
    expect(session.lifecycle!.resume).toHaveBeenCalledOnce();
  });

  it("reports running-time usage with the billable shape", async () => {
    const { provider } = fakeProvider();
    const session = await provider.open("run-42");
    const u = session.usage!();
    expect(u).toMatchObject({ runId: "run-42", projectId: "p1", sandboxId: "sb-1" });
    expect(typeof u.sandboxMs).toBe("number");
    expect(typeof u.acquired).toBe("number");
  });

  it("disposes the session", async () => {
    const { provider, disposed } = fakeProvider();
    const session = await provider.open("run-1");
    expect(disposed()).toBe(false);
    await session.dispose();
    expect(disposed()).toBe(true);
  });

  it("allows a minimal session without lifecycle/usage (both optional)", async () => {
    const provider: SandboxProvider = {
      open: () => ({ fs, shell, dispose: async () => {} }),
    };
    const session = await provider.open("run-1");
    expect(session.lifecycle).toBeUndefined();
    expect(session.usage).toBeUndefined();
    await session.dispose();
  });
});
