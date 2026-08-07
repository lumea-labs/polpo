import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageName = process.argv[2];
if (!packageName) {
  throw new Error("Usage: publish-package-if-missing.mjs <package-name>");
}

const root = process.cwd();
const manifests = [resolve(root, "package.json")];
const packagesDir = resolve(root, "packages");

if (existsSync(packagesDir)) {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = resolve(packagesDir, entry.name, "package.json");
    if (existsSync(manifest)) manifests.push(manifest);
  }
}

const selected = manifests
  .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) }))
  .find(({ manifest }) => manifest.name === packageName);

if (!selected) throw new Error(`Unknown workspace package: ${packageName}`);

const { version } = selected.manifest;
const packageSpec = `${packageName}@${version}`;
const lookup = spawnSync("npm", ["view", packageSpec, "version", "--json"], {
  cwd: root,
  encoding: "utf8",
});

if (lookup.status === 0) {
  console.log(`${packageSpec} already exists; skipping publish.`);
  process.exit(0);
}

const lookupError = `${lookup.stdout ?? ""}\n${lookup.stderr ?? ""}`;
if (!lookupError.includes("E404")) {
  throw new Error(`Could not verify ${packageSpec} on npm:\n${lookupError.trim()}`);
}

const packageDir = resolve(selected.path, "..");
const publish = spawnSync(
  "pnpm",
  ["publish", "--no-git-checks", "--provenance", "--access", "public"],
  { cwd: packageDir, stdio: "inherit" },
);

if (publish.status !== 0) {
  process.exit(publish.status ?? 1);
}
