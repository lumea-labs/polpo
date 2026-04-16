/**
 * Tests for `promptForUpdateIfAvailable` — the interactive upgrade prompt
 * that fires at the start of `install` and `create`.
 *
 * The function short-circuits early on non-TTY / CI / opt-out, so we cover
 * those paths without needing to mock clack. For the branches that DO
 * enter the prompt, we stub the clack + self-update modules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const clackConfirmMock = vi.fn();
const runSelfUpdateMock = vi.fn();
const homeHolder = { path: "" };

vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => clackConfirmMock(...args),
  isCancel: (v: unknown) => typeof v === "symbol" && v.toString().includes("cancel"),
  spinner: () => ({
    start: () => {},
    stop: () => {},
  }),
  log: {
    info: () => {},
    warn: () => {},
  },
  outro: () => {},
}));

vi.mock("../src/util/self-update.js", () => ({
  runSelfUpdate: (...args: unknown[]) => runSelfUpdateMock(...args),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => homeHolder.path,
  };
});

type UpdateCheckModule = typeof import("../src/update-check.js");
let mod: UpdateCheckModule;

beforeEach(async () => {
  homeHolder.path = fs.mkdtempSync(path.join(os.tmpdir(), "polpo-upd-"));
  fs.mkdirSync(path.join(homeHolder.path, ".polpo"), { recursive: true });
  clackConfirmMock.mockReset();
  runSelfUpdateMock.mockReset();
  vi.resetModules();
  mod = await import("../src/update-check.js");
});

afterEach(() => {
  fs.rmSync(homeHolder.path, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function writeCachedState(latestVersion: string): void {
  const state = { lastCheck: Date.now(), latestVersion };
  fs.writeFileSync(
    path.join(homeHolder.path, ".polpo", ".update-check"),
    JSON.stringify(state),
  );
}

describe("promptForUpdateIfAvailable — short-circuit cases", () => {
  it("returns { updated: false } when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    writeCachedState("9.9.9");
    const r = await mod.promptForUpdateIfAvailable("0.6.3");
    expect(r).toEqual({ updated: false });
    expect(clackConfirmMock).not.toHaveBeenCalled();
  });

  it("returns { updated: false } when POLPO_NO_UPDATE_CHECK=1", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.stubEnv("POLPO_NO_UPDATE_CHECK", "1");
    writeCachedState("9.9.9");
    const r = await mod.promptForUpdateIfAvailable("0.6.3");
    expect(r).toEqual({ updated: false });
    expect(clackConfirmMock).not.toHaveBeenCalled();
  });

  it("returns { updated: false } when CI=true", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.stubEnv("CI", "true");
    writeCachedState("9.9.9");
    const r = await mod.promptForUpdateIfAvailable("0.6.3");
    expect(r).toEqual({ updated: false });
    expect(clackConfirmMock).not.toHaveBeenCalled();
  });

  it("no-op when no cached latestVersion", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.stubEnv("POLPO_NO_UPDATE_CHECK", "");
    vi.stubEnv("CI", "");
    // No cached state file at all.
    const r = await mod.promptForUpdateIfAvailable("0.6.3");
    expect(r).toEqual({ updated: false });
    expect(clackConfirmMock).not.toHaveBeenCalled();
  });

  it("no-op when cached version is NOT newer", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.stubEnv("POLPO_NO_UPDATE_CHECK", "");
    vi.stubEnv("CI", "");
    writeCachedState("0.6.0");
    const r = await mod.promptForUpdateIfAvailable("0.6.3");
    expect(r).toEqual({ updated: false });
    expect(clackConfirmMock).not.toHaveBeenCalled();
  });
});

describe("promptForUpdateIfAvailable — prompt path", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.stubEnv("POLPO_NO_UPDATE_CHECK", "");
    vi.stubEnv("CI", "");
  });

  it("declined → returns { updated: false } and skips self-update", async () => {
    writeCachedState("0.7.0");
    clackConfirmMock.mockResolvedValue(false);
    const r = await mod.promptForUpdateIfAvailable("0.6.3");
    expect(r).toEqual({ updated: false });
    expect(runSelfUpdateMock).not.toHaveBeenCalled();
  });

  it("accepted + self-update succeeds → returns { updated: true }", async () => {
    writeCachedState("0.7.0");
    clackConfirmMock.mockResolvedValue(true);
    runSelfUpdateMock.mockReturnValue({ success: true, cmd: "npm install -g polpo-ai@0.7.0" });
    const r = await mod.promptForUpdateIfAvailable("0.6.3");
    expect(r).toEqual({ updated: true });
    expect(runSelfUpdateMock).toHaveBeenCalledWith("0.7.0");
  });

  it("accepted + self-update fails → returns { updated: false } (caller continues)", async () => {
    writeCachedState("0.7.0");
    clackConfirmMock.mockResolvedValue(true);
    runSelfUpdateMock.mockReturnValue({
      success: false,
      cmd: "npm install -g polpo-ai@0.7.0",
      error: "EACCES permission denied",
    });
    const r = await mod.promptForUpdateIfAvailable("0.6.3");
    expect(r).toEqual({ updated: false });
    expect(runSelfUpdateMock).toHaveBeenCalledWith("0.7.0");
  });

  it("prompts with smart default = true (press Enter to update)", async () => {
    writeCachedState("0.7.0");
    clackConfirmMock.mockResolvedValue(true);
    runSelfUpdateMock.mockReturnValue({ success: true, cmd: "" });
    await mod.promptForUpdateIfAvailable("0.6.3");
    const call = clackConfirmMock.mock.calls[0][0] as { initialValue?: boolean };
    expect(call.initialValue).toBe(true);
  });
});
