#!/usr/bin/env node
// Exercise the application install/build boundary with no registry dependency.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "polpo-bun-ci-"));
const run = (...args) => execFileSync("bun", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
});

try {
  const version = run("--version").trim();
  assert.equal(version, "1.4.2", "Runner Bun version changed without updating its contract");
  assert.equal(execFileSync("bash", ["-lc", "bun --version"], {
    cwd, encoding: "utf8", timeout: 30_000,
  }).trim(), version, "Bun must be available to non-interactive login shells");
  mkdirSync(join(cwd, "dependency"));
  writeFileSync(join(cwd, "dependency/package.json"), JSON.stringify({
    name: "polpo-smoke-dependency", version: "1.0.0", main: "index.js",
  }));
  writeFileSync(join(cwd, "dependency/index.js"), "export const value = 42;\n");
  const manifest = {
    name: "polpo-bun-ci-smoke", private: true,
    dependencies: { "polpo-smoke-dependency": "file:./dependency" },
    scripts: {
      postinstall: "node -e \"require('fs').writeFileSync('lifecycle-ran', 'unexpected')\"",
      build: "bun build ./index.ts --target browser --outdir ./dist",
    },
  };
  writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(cwd, "index.ts"), 'import { value } from "polpo-smoke-dependency"; console.log(value);\n');
  run("install", "--lockfile-only", "--ignore-scripts");
  const lock = readFileSync(join(cwd, "bun.lock"), "utf8");
  execFileSync("bash", ["-lc", "bun ci --ignore-scripts"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  assert.equal(readFileSync(join(cwd, "bun.lock"), "utf8"), lock);
  assert(!existsSync(join(cwd, "lifecycle-ran")), "Install lifecycle script must stay disabled");
  run("run", "build");
  assert(existsSync(join(cwd, "dist/index.js")), "Browser build did not produce an artifact");

  mkdirSync(join(cwd, "other-dependency"));
  writeFileSync(join(cwd, "other-dependency/package.json"), JSON.stringify({
    name: "polpo-smoke-dependency", version: "2.0.0", main: "index.js",
  }));
  writeFileSync(join(cwd, "other-dependency/index.js"), "export const value = 0;\n");
  manifest.dependencies["polpo-smoke-dependency"] = "file:./other-dependency";
  writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest));
  assert.throws(() => run("ci", "--ignore-scripts"), "A mismatched frozen lockfile must fail");
  console.log(`PASS Bun ${version}: frozen install, ignored lifecycle, browser build and lock mismatch rejection`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
