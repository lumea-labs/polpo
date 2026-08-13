import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import { init, parse } from "es-module-lexer";
import {
  parseCustomToolSourceArtifact,
  type CustomToolSourceArtifact,
} from "@polpo-ai/tools";

const CUSTOM_TOOL_NAME_LITERAL_RE = /name\s*:\s*["'`]([a-z][a-z0-9_]*)["'`]/;

export function extractCustomToolName(source: string): string | undefined {
  return source.match(CUSTOM_TOOL_NAME_LITERAL_RE)?.[1];
}

export async function collectCustomToolSourceArtifact(
  entryFile: string,
  sourceRoot: string,
): Promise<CustomToolSourceArtifact> {
  const root = await realpath(resolve(sourceRoot));
  const entry = resolve(entryFile);
  assertWithinRoot(root, entry);
  await assertRegularNonSymlink(entry);

  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await build({
      absWorkingDir: root,
      bundle: true,
      entryPoints: [entry],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      packages: "external",
      platform: "node",
      preserveSymlinks: true,
      write: false,
    });
  } catch (error) {
    throw new Error(`Cannot resolve custom tool dependency graph: ${errorMessage(error)}`);
  }

  const files: Record<string, string> = {};
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    const absolutePath = isAbsolute(input) ? input : resolve(root, input);
    const artifactPath = assertWithinRoot(root, absolutePath);
    await assertRegularNonSymlink(absolutePath);
    files[artifactPath] = await readFile(absolutePath, "utf8");
  }

  await rejectComputedDynamicImports(files);
  return parseCustomToolSourceArtifact({
    version: 1,
    entry: assertWithinRoot(root, entry),
    files,
  });
}

async function rejectComputedDynamicImports(
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await init;
  for (const [path, source] of Object.entries(files)) {
    if (path.endsWith(".json")) continue;
    const [imports] = parse(source);
    const computed = imports.find((entry) => entry.d >= 0 && entry.n === undefined);
    if (computed) {
      throw new Error(
        `Computed dynamic import in ${path} cannot be packaged; use a literal dynamic import`,
      );
    }
  }
}

function assertWithinRoot(root: string, candidate: string): string {
  const path = relative(root, candidate);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    if (path === "") return path;
    throw new Error(`Custom tool dependency is outside the selected root: ${candidate}`);
  }
  return path.split(sep).join("/");
}

async function assertRegularNonSymlink(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || await realpath(path) !== path) {
    throw new Error(`Custom tool sources cannot use a symbolic link: ${path}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
