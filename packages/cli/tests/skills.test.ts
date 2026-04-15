import { describe, it, expect, beforeEach, vi } from "vitest";

const execMock = vi.fn();

vi.mock("node:child_process", () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    try {
      const result = execMock(cmd, opts);
      cb(null, result ?? { stdout: "", stderr: "" });
    } catch (err) {
      cb(err as Error, { stdout: "", stderr: "" });
    }
  },
}));

import {
  installCodingAgentSkills,
  skillsInstallHint,
  POLPO_SKILLS_REPO,
} from "../src/util/skills.js";

beforeEach(() => {
  execMock.mockReset();
});

describe("POLPO_SKILLS_REPO constant", () => {
  it("points at lumea-labs/polpo-skills", () => {
    expect(POLPO_SKILLS_REPO).toBe("lumea-labs/polpo-skills");
  });
});

describe("skillsInstallHint", () => {
  it("returns the canonical global install command", () => {
    expect(skillsInstallHint()).toBe(
      "npx skills@latest add lumea-labs/polpo-skills --global",
    );
  });
});

describe("installCodingAgentSkills", () => {
  describe("happy paths", () => {
    it("scope='global' passes --global flag + --yes", async () => {
      execMock.mockReturnValue({ stdout: "", stderr: "" });
      const ok = await installCodingAgentSkills({ scope: "global" });
      expect(ok).toBe(true);
      const cmd = execMock.mock.calls[0][0] as string;
      expect(cmd).toContain("npx");
      expect(cmd).toContain("skills@latest");
      expect(cmd).toContain("add lumea-labs/polpo-skills");
      expect(cmd).toContain("--yes");
      expect(cmd).toContain("--global");
    });

    it("scope='project' passes --yes but NOT --global", async () => {
      execMock.mockReturnValue({ stdout: "", stderr: "" });
      const ok = await installCodingAgentSkills({ scope: "project" });
      expect(ok).toBe(true);
      const cmd = execMock.mock.calls[0][0] as string;
      expect(cmd).toContain("--yes");
      expect(cmd).not.toContain("--global");
    });

    it("uses the provided cwd", async () => {
      execMock.mockReturnValue({ stdout: "", stderr: "" });
      await installCodingAgentSkills({ scope: "project", cwd: "/tmp/myrepo" });
      const opts = execMock.mock.calls[0][1] as { cwd?: string };
      expect(opts.cwd).toBe("/tmp/myrepo");
    });

    it("falls back to process.cwd() when cwd omitted", async () => {
      execMock.mockReturnValue({ stdout: "", stderr: "" });
      await installCodingAgentSkills({ scope: "global" });
      const opts = execMock.mock.calls[0][1] as { cwd?: string };
      expect(opts.cwd).toBe(process.cwd());
    });

    it("passes a default timeout of 90 seconds", async () => {
      execMock.mockReturnValue({ stdout: "", stderr: "" });
      await installCodingAgentSkills({ scope: "global" });
      const opts = execMock.mock.calls[0][1] as { timeout?: number };
      expect(opts.timeout).toBe(90_000);
    });

    it("honors a custom timeoutMs", async () => {
      execMock.mockReturnValue({ stdout: "", stderr: "" });
      await installCodingAgentSkills({ scope: "global", timeoutMs: 5_000 });
      const opts = execMock.mock.calls[0][1] as { timeout?: number };
      expect(opts.timeout).toBe(5_000);
    });
  });

  describe("skip scope", () => {
    it("scope='skip' short-circuits (returns false, no exec)", async () => {
      const ok = await installCodingAgentSkills({ scope: "skip" });
      expect(ok).toBe(false);
      expect(execMock).not.toHaveBeenCalled();
    });
  });

  describe("failure paths", () => {
    it("returns false when the subprocess throws (does NOT propagate)", async () => {
      execMock.mockImplementation(() => {
        throw new Error("npx not found");
      });
      const ok = await installCodingAgentSkills({ scope: "global" });
      expect(ok).toBe(false);
    });

    it("returns false on non-zero exit (simulated via exception)", async () => {
      execMock.mockImplementation(() => {
        const e = new Error("Command failed: npx skills@latest add");
        (e as Error & { code?: number }).code = 1;
        throw e;
      });
      const ok = await installCodingAgentSkills({ scope: "project" });
      expect(ok).toBe(false);
    });
  });
});
