/**
 * Behavioral tests for resolveDeployConflict.
 *
 * The two regressions we lock in here:
 *   1) Server-managed fields (id, createdAt, …) used to make every existing
 *      resource look "different" → either spammed conflict prompts in TTY
 *      mode or silently skipped every existing resource in CI. strip()
 *      now filters those before diffing.
 *   2) Non-interactive non-force used to default to "skip" → CI deploys
 *      silently no-op'd. Now defaults to "write" so scripted deploys
 *      actually push.
 *
 * Interactive prompt branches are exercised by stubbing @clack/prompts
 * confirm + isCancel via vi.mock so the test runs in headless CI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const confirmMock = vi.fn();
vi.mock("@clack/prompts", () => ({
  confirm: (args: unknown) => confirmMock(args),
  isCancel: (v: unknown) => v === Symbol.for("clack.cancel"),
}));

// Import AFTER vi.mock so the module picks up the stub.
const { resolveDeployConflict } = await import("../src/util/conflicts.js");

beforeEach(() => confirmMock.mockReset());

describe("resolveDeployConflict — null/undefined remote", () => {
  it("returns 'write' when remote is null (resource doesn't exist yet)", async () => {
    const action = await resolveDeployConflict({ name: "a" }, null, "agent a", {
      force: false, interactive: false,
    });
    expect(action).toBe("write");
  });

  it("returns 'write' when remote is undefined", async () => {
    const action = await resolveDeployConflict({ name: "a" }, undefined, "agent a", {
      force: false, interactive: false,
    });
    expect(action).toBe("write");
  });
});

describe("resolveDeployConflict — diff via strip()", () => {
  it("returns 'skip' when local and remote are identical (no prompt)", async () => {
    const local = { name: "agt", role: "r", model: "m" };
    const remote = { name: "agt", role: "r", model: "m" };
    const action = await resolveDeployConflict(local, remote, "agent agt", {
      force: false, interactive: true,
    });
    expect(action).toBe("skip");
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("strips server-managed fields before comparing — same fields ≠ differ", async () => {
    const local = { name: "agt", role: "r", model: "m" };
    const remote = {
      id: "agt_xyz",
      name: "agt",
      role: "r",
      model: "m",
      team: "default",
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-17T00:00:00Z",
      projectId: "prj_abc",
    };
    const action = await resolveDeployConflict(local, remote, "agent agt", {
      force: false, interactive: true,
    });
    expect(action).toBe("skip");
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("returns 'write' when force=true even without prompt", async () => {
    const local = { name: "agt", role: "r2" };
    const remote = { name: "agt", role: "r1" };
    const action = await resolveDeployConflict(local, remote, "agent agt", {
      force: true, interactive: false,
    });
    expect(action).toBe("write");
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("defaults to 'write' when non-interactive AND non-force (CI safety)", async () => {
    const local = { name: "agt", role: "r2" };
    const remote = { name: "agt", role: "r1" };
    const action = await resolveDeployConflict(local, remote, "agent agt", {
      force: false, interactive: false,
    });
    expect(action).toBe("write");
  });

  it("opens a prompt when interactive AND non-force AND fields actually differ", async () => {
    confirmMock.mockResolvedValueOnce(true);
    const local = { name: "agt", role: "new" };
    const remote = { id: "x", name: "agt", role: "old", createdAt: "x" };
    const action = await resolveDeployConflict(local, remote, "agent agt", {
      force: false, interactive: true,
    });
    expect(action).toBe("write");
    expect(confirmMock).toHaveBeenCalledOnce();
    const args = confirmMock.mock.calls[0][0] as { message: string };
    expect(args.message).toContain("agent agt");
  });

  it("returns 'skip' when interactive prompt is answered no", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const local = { name: "agt", role: "new" };
    const remote = { name: "agt", role: "old" };
    const action = await resolveDeployConflict(local, remote, "agent agt", {
      force: false, interactive: true,
    });
    expect(action).toBe("skip");
  });

  it("returns 'skip' when interactive prompt is cancelled", async () => {
    confirmMock.mockResolvedValueOnce(Symbol.for("clack.cancel"));
    const local = { role: "new" };
    const remote = { role: "old" };
    const action = await resolveDeployConflict(local, remote, "agent agt", {
      force: false, interactive: true,
    });
    expect(action).toBe("skip");
  });
});

describe("resolveDeployConflict — beforePrompt / afterPrompt hooks", () => {
  it("fires beforePrompt then afterPrompt around the prompt (spinner handoff)", async () => {
    confirmMock.mockResolvedValueOnce(true);
    const events: string[] = [];
    const local = { role: "new" };
    const remote = { role: "old" };

    await resolveDeployConflict(local, remote, "agent agt", {
      force: false,
      interactive: true,
      beforePrompt: () => events.push("before"),
      afterPrompt: () => events.push("after"),
    });

    expect(events).toEqual(["before", "after"]);
  });

  it("still calls afterPrompt when the prompt is cancelled (so spinner restarts)", async () => {
    confirmMock.mockResolvedValueOnce(Symbol.for("clack.cancel"));
    const events: string[] = [];

    await resolveDeployConflict({ a: 1 }, { a: 2 }, "x", {
      force: false,
      interactive: true,
      beforePrompt: () => events.push("before"),
      afterPrompt: () => events.push("after"),
    });

    expect(events).toEqual(["before", "after"]);
  });

  it("does NOT fire the hooks when no prompt is needed (identical, force, or non-interactive)", async () => {
    const events: string[] = [];

    await resolveDeployConflict({ a: 1 }, { a: 1 }, "x", {
      force: false, interactive: true,
      beforePrompt: () => events.push("before"),
      afterPrompt: () => events.push("after"),
    });
    expect(events).toEqual([]);

    await resolveDeployConflict({ a: 1 }, { a: 2 }, "x", {
      force: true, interactive: false,
      beforePrompt: () => events.push("before"),
      afterPrompt: () => events.push("after"),
    });
    expect(events).toEqual([]);
  });
});

describe("resolveDeployConflict — explicit compareKeys", () => {
  it("only diffs the listed fields, ignoring everything else", async () => {
    const local = { name: "a", description: "same", extra: "local-only" };
    const remote = { name: "a", description: "same", extra: "remote-only", id: "x" };
    const action = await resolveDeployConflict(local, remote, "team a", {
      force: false, interactive: true,
    }, ["name", "description"]);
    expect(action).toBe("skip");
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("detects a diff on a listed field", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const local = { name: "a", description: "new" };
    const remote = { name: "a", description: "old" };
    const action = await resolveDeployConflict(local, remote, "team a", {
      force: false, interactive: true,
    }, ["description"]);
    expect(action).toBe("skip"); // user answered no
    expect(confirmMock).toHaveBeenCalledOnce();
  });
});

describe("resolveDeployConflict — key-order independence", () => {
  it("matches identical objects whose JSON keys are in different insertion order", async () => {
    const local = { b: 2, a: 1, c: { y: 2, x: 1 } };
    const remote = { c: { x: 1, y: 2 }, a: 1, b: 2 };
    const action = await resolveDeployConflict(local, remote, "x", {
      force: false, interactive: true,
    });
    expect(action).toBe("skip");
  });
});
