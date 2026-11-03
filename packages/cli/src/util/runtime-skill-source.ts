import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unpackSkillArchive } from "@polpo-ai/core/skill-archive";
import { replaceLocalSkillBundle } from "./runtime-skill-bundle.js";

export interface RuntimeSkillSourceCheckout {
  root: string;
  source: string;
  revision?: string;
  remote: boolean;
  archive?: boolean;
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
    const stat = fs.statSync(local);
    if (stat.isDirectory()) return action({ root: local, source: local, remote: false });
    if (!stat.isFile() || !/\.(?:skill|zip)$/iu.test(local)) {
      throw new Error(`Skill source must be a directory, .skill archive, .zip archive, owner/repository, or Git URL: ${local}`);
    }
    const temporary = fs.mkdtempSync(path.join(dependencies.temporaryRoot ?? os.tmpdir(), "polpo-skills-"));
    try {
      const unpacked = await unpackSkillArchive(new Uint8Array(fs.readFileSync(local)));
      const root = path.join(temporary, "source", unpacked.bundle.name);
      replaceLocalSkillBundle(root, unpacked.bundle);
      return await action({ root, source: local, revision: unpacked.digest, remote: false, archive: true });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
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
