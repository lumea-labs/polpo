import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mocks must be hoisted above the SUT import.
const execMock = vi.fn();
const execSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    // util.promisify detects the (err, result) callback signature.
    try {
      const result = execMock(cmd, opts);
      cb(null, result ?? { stdout: "", stderr: "" });
    } catch (err) {
      cb(err as Error, { stdout: "", stderr: "" });
    }
  },
  execSync: (cmd: string, opts: unknown) => execSyncMock(cmd, opts),
}));

import {
  detectPackageManager,
  isPolpoOnPath,
  installPolpoGlobally,
  globalInstallHint,
  CLI_PACKAGE,
} from "../src/util/install-cli.js";

const ORIGINAL_UA = process.env.npm_config_user_agent;
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  execMock.mockReset();
  execSyncMock.mockReset();
  delete process.env.npm_config_user_agent;
});

afterEach(() => {
  if (ORIGINAL_UA !== undefined) process.env.npm_config_user_agent = ORIGINAL_UA;
  if (ORIGINAL_PLATFORM) {
    Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  }
});

describe("CLI_PACKAGE constant", () => {
  it("is @polpo-ai/cli", () => {
    expect(CLI_PACKAGE).toBe("@polpo-ai/cli");
  });
});

describe("detectPackageManager", () => {
  it("returns 'npm' when no user agent is set", () => {
    delete process.env.npm_config_user_agent;
    expect(detectPackageManager()).toBe("npm");
  });

  it("returns 'pnpm' when user agent mentions pnpm", () => {
    process.env.npm_config_user_agent = "pnpm/9.0.0 npm/? node/v20.0.0";
    expect(detectPackageManager()).toBe("pnpm");
  });

  it("returns 'yarn' when user agent mentions yarn", () => {
    process.env.npm_config_user_agent = "yarn/1.22.19 npm/? node/v20.0.0";
    expect(detectPackageManager()).toBe("yarn");
  });

  it("returns 'bun' when user agent mentions bun", () => {
    process.env.npm_config_user_agent = "bun/1.1.0";
    expect(detectPackageManager()).toBe("bun");
  });

  it("falls back to 'npm' for unknown agent", () => {
    process.env.npm_config_user_agent = "ni/0.21.0 npm/? node/v20.0.0";
    expect(detectPackageManager()).toBe("npm");
  });

  it("recognises pnpm even if bun also appears (pnpm checked first)", () => {
    process.env.npm_config_user_agent = "pnpm/9.0.0 bun/1.1.0";
    expect(detectPackageManager()).toBe("pnpm");
  });
});

describe("globalInstallHint", () => {
  it("returns npm install -g when no PM detected", () => {
    delete process.env.npm_config_user_agent;
    expect(globalInstallHint()).toBe("npm install -g @polpo-ai/cli");
  });

  it("returns pnpm add -g for pnpm", () => {
    process.env.npm_config_user_agent = "pnpm/9.0.0";
    expect(globalInstallHint()).toBe("pnpm add -g @polpo-ai/cli");
  });

  it("returns yarn global add for yarn", () => {
    process.env.npm_config_user_agent = "yarn/1.22.19";
    expect(globalInstallHint()).toBe("yarn global add @polpo-ai/cli");
  });

  it("returns bun add -g for bun", () => {
    process.env.npm_config_user_agent = "bun/1.1.0";
    expect(globalInstallHint()).toBe("bun add -g @polpo-ai/cli");
  });
});

describe("isPolpoOnPath", () => {
  it("returns true when `which polpo` succeeds on unix", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    execSyncMock.mockReturnValue(Buffer.from("/usr/local/bin/polpo\n"));
    expect(isPolpoOnPath()).toBe(true);
    expect(execSyncMock).toHaveBeenCalledWith("which polpo", expect.objectContaining({ stdio: "ignore" }));
  });

  it("returns false when `which polpo` throws", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    execSyncMock.mockImplementation(() => {
      throw new Error("command not found");
    });
    expect(isPolpoOnPath()).toBe(false);
  });

  it("uses `where polpo` on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execSyncMock.mockReturnValue(Buffer.from("C:\\...\\polpo.exe\n"));
    expect(isPolpoOnPath()).toBe(true);
    expect(execSyncMock).toHaveBeenCalledWith("where polpo", expect.any(Object));
  });
});

describe("installPolpoGlobally", () => {
  it("returns ok=true on success", async () => {
    execMock.mockReturnValue({ stdout: "installed", stderr: "" });
    const result = await installPolpoGlobally();
    expect(result.ok).toBe(true);
    expect(result.command).toContain("@polpo-ai/cli");
  });

  it("returns ok=false on failure (does NOT throw)", async () => {
    execMock.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const result = await installPolpoGlobally();
    expect(result.ok).toBe(false);
    expect(result.command).toContain("@polpo-ai/cli");
  });

  it("uses the detected package manager in the shell command", async () => {
    process.env.npm_config_user_agent = "pnpm/9.0.0";
    execMock.mockReturnValue({ stdout: "", stderr: "" });
    const result = await installPolpoGlobally();
    expect(result.pm).toBe("pnpm");
    expect(execMock).toHaveBeenCalledWith(
      "pnpm add -g @polpo-ai/cli",
      expect.any(Object),
    );
  });

  it("passes a timeout to exec", async () => {
    execMock.mockReturnValue({ stdout: "", stderr: "" });
    await installPolpoGlobally();
    const opts = execMock.mock.calls[0]?.[1] as { timeout?: number };
    expect(opts.timeout).toBeGreaterThan(0);
  });
});
