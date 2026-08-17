import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RuntimeSkillSourceCheckout {
  root: string;
  source: string;
  revision?: string;
  remote: boolean;
}

export interface RuntimeSkillSourceDependencies {
  execFile?: typeof execFileSync;
  temporaryRoot?: string;
}

function gitUrl(source: string): string {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
    return `https://github.com/${source.replace(/\.git$/, "")}.git`;
  }
  if (/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(source)) return source;
  throw new Error(
    `Skill source must be a local directory, owner/repository, or Git URL: ${source}`,
  );
}

/** Resolve a local directory or shallow-clone a Git source for one operation. */
export async function withRuntimeSkillSource<T>(
  source: string,
  cwd: string,
  action: (checkout: RuntimeSkillSourceCheckout) => Promise<T>,
  dependencies: RuntimeSkillSourceDependencies = {},
): Promise<T> {
  const local = path.resolve(cwd, source);
  if (fs.existsSync(local)) {
    if (!fs.statSync(local).isDirectory()) throw new Error(`Skill source is not a directory: ${local}`);
    return action({ root: local, source: local, remote: false });
  }

  const temporary = fs.mkdtempSync(path.join(dependencies.temporaryRoot ?? os.tmpdir(), "polpo-skills-"));
  const checkout = path.join(temporary, "source");
  const run = dependencies.execFile ?? execFileSync;
  try {
    run("git", ["clone", "--depth", "1", "--quiet", gitUrl(source), checkout], {
      stdio: "pipe",
      timeout: 120_000,
    });
    const revision = String(run("git", ["-C", checkout, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })).trim();
    return await action({ root: checkout, source, revision, remote: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not fetch runtime skills from ${source}: ${detail}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
