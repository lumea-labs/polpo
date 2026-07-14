import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, type Plugin } from "esbuild";
import {
  bindCustomTool,
  createJsonSchemaExample,
  createCustomToolsStore,
  extractCustomTool,
  safeEnv,
  TOOL_CATALOG,
  type CustomToolMeta,
  type CustomToolsStore,
  type ResolvedVault,
} from "@polpo-ai/tools";
import type { PolpoTool } from "@polpo-ai/core";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import type {
  CustomToolDeployer,
  CustomToolDeployProgress,
  CustomToolRunner,
} from "@polpo-ai/server";

const SOURCE_HASH_PREFIX = "// polpo-source-sha256:";
const RUNTIME_RESOLVE_DIR = dirname(fileURLToPath(import.meta.url));
const TOOLS_AUTHORING_ENTRY = join(RUNTIME_RESOLVE_DIR, "../../../tools/dist/custom-tools.js");

type RuntimeOptions = {
  polpoDir: string;
  workDir: string;
  fs: FileSystem;
  shell: Shell;
};

function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function importedPackages(source: string): string[] {
  const packages = new Set<string>();
  const pattern = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
    packages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
  }
  return [...packages].sort();
}

function authoringImportPlugin(): Plugin {
  return {
    name: "polpo-custom-tool-authoring-entry",
    setup(builder) {
      // Import only the defineTool authoring primitive. Bundling the package
      // root would pull unrelated runtime tools and their asset URLs into each
      // custom-tool bundle.
      builder.onResolve({ filter: /^@polpo-ai\/tools$/ }, () => ({
        path: TOOLS_AUTHORING_ENTRY,
      }));
    },
  };
}

export class LocalCustomToolRuntime implements CustomToolDeployer, CustomToolRunner {
  readonly store: CustomToolsStore;
  private readonly toolsDir: string;

  constructor(private readonly options: RuntimeOptions) {
    this.toolsDir = join(options.polpoDir, "tools");
    this.store = createCustomToolsStore(options.fs, this.toolsDir);
  }

  private async importBundle(name: string, bundle: string, temporary: boolean): Promise<unknown> {
    await mkdir(this.toolsDir, { recursive: true });
    const hash = sourceHash(bundle);
    const path = temporary
      ? join(this.toolsDir, `.${name}.validate-${hash}.mjs`)
      : join(this.toolsDir, `${name}.mjs`);
    if (temporary) await writeFile(path, bundle, "utf8");
    try {
      return await import(`${pathToFileURL(path).href}?v=${hash}`);
    } finally {
      if (temporary) await rm(path, { force: true });
    }
  }

  async deploy(
    name: string,
    source: string,
    onProgress?: (progress: CustomToolDeployProgress) => void,
  ) {
    const emit = (step: CustomToolDeployProgress["step"], detail?: string) => onProgress?.({ step, detail });
    emit("detect", "Inspecting imports and tool definition");
    if (TOOL_CATALOG.includes(name)) {
      return { errors: [`Custom tool name "${name}" conflicts with a built-in tool`], deps: [] };
    }
    const deps = importedPackages(source);
    emit("install", deps.length ? `Resolving ${deps.join(", ")}` : "No package dependencies");
    emit("bundle", "Compiling TypeScript for the local runtime");

    try {
      const result = await build({
        stdin: {
          contents: source,
          loader: "ts",
          // Tool imports resolve against the runtime's own dependency graph.
          // Relative project imports are intentionally unsupported in v1.
          resolveDir: RUNTIME_RESOLVE_DIR,
          sourcefile: `${name}.ts`,
        },
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        write: false,
        sourcemap: false,
        treeShaking: true,
        plugins: [authoringImportPlugin()],
        logLevel: "silent",
      });
      const output = result.outputFiles?.[0]?.text;
      if (!output) return { errors: ["The tool compiler produced no output"], deps };
      const bundle = `${SOURCE_HASH_PREFIX}${sourceHash(source)}\n${output}`;

      emit("validate", "Loading the compiled tool and validating its contract");
      const tool = extractCustomTool(await this.importBundle(name, bundle, true));
      if (tool.name !== name) {
        return { errors: [`Source exports tool name "${tool.name}", expected "${name}"`], deps };
      }
      const meta: CustomToolMeta = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        label: tool.label ?? tool.name,
        clientSide: tool.clientSide ?? false,
      };
      emit("deployed", "Tool is ready");
      return { errors: [], meta, bundle, deps };
    } catch (error) {
      emit("error", (error as Error).message);
      return { errors: [(error as Error).message], deps };
    }
  }

  async ensureDeployed(name: string): Promise<string> {
    const source = await this.store.getSource(name);
    if (source === null) throw new Error(`Custom tool "${name}" was not found`);
    const expectedHeader = `${SOURCE_HASH_PREFIX}${sourceHash(source)}`;
    const existing = await this.store.getBundle(name);
    if (existing?.startsWith(expectedHeader)) return existing;

    const deployed = await this.deploy(name, source);
    if (deployed.errors.length > 0 || !deployed.bundle || !deployed.meta) {
      throw new Error(deployed.errors.join("\n") || `Custom tool "${name}" failed to deploy`);
    }
    await this.store.putBundle(name, deployed.bundle);
    await this.store.putMeta(name, deployed.meta);
    return deployed.bundle;
  }

  async load(name: string, vault: ResolvedVault): Promise<PolpoTool> {
    const bundle = await this.ensureDeployed(name);
    const tool = extractCustomTool(await this.importBundle(name, bundle, false));
    return bindCustomTool(tool, {
      fs: this.options.fs,
      shell: this.options.shell,
      vault,
      env: safeEnv(),
      workDir: this.options.workDir,
    });
  }

  async loadAssigned(allowedTools: string[] | undefined, vault: ResolvedVault): Promise<PolpoTool[]> {
    if (!allowedTools?.length) return [];
    const available = await this.store.list();
    const selected = allowedTools.includes("*")
      ? available
      : available.filter((name) => allowedTools.includes(name));
    return Promise.all(selected.map((name) => this.load(name, vault)));
  }

  async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { resolveAgentVault } = await import("../vault/index.js");
    const tool = await this.load(name, resolveAgentVault());
    return tool.execute(`tool-test-${Date.now()}`, args);
  }

  async generateExample(name: string): Promise<Record<string, unknown>> {
    let meta = await this.store.getMeta(name);
    if (!meta) {
      await this.ensureDeployed(name);
      meta = await this.store.getMeta(name);
    }
    if (!meta) throw new Error(`Custom tool "${name}" has no parameter schema`);
    const example = createJsonSchemaExample(meta.parameters);
    if (!example || typeof example !== "object" || Array.isArray(example)) {
      throw new Error(`Custom tool "${name}" parameters must be an object schema`);
    }
    return example as Record<string, unknown>;
  }
}

export function createLocalCustomToolRuntime(options: RuntimeOptions) {
  return new LocalCustomToolRuntime(options);
}
