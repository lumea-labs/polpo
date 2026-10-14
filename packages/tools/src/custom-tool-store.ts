import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { ConnectionSlotSpecs } from "@polpo-ai/core";
import type { CustomToolServerBindings } from "./custom-tools.js";
import {
  createSingleFileCustomToolArtifact,
  customToolArtifactEntrySource,
  parseCustomToolSourceArtifact,
  type CustomToolSourceArtifact,
} from "./custom-tool-source-artifact.js";

export const CUSTOM_TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface CustomToolMeta {
  name: string;
  description: string;
  parameters: unknown;
  label: string;
  clientSide: boolean;
  timeoutMs?: number;
  bindingsSchema?: unknown;
  serverBindings?: CustomToolServerBindings;
  connections?: ConnectionSlotSpecs;
}

export interface CustomToolsStore {
  /** Exclusive mutation for one tool in this runtime. A concurrent mutation
   * fails with CustomToolBusyError. Multi-process hosts must supply their own
   * coordinator or ensure the previous process has drained before replacement. */
  withMutation<T>(name: string, operation: () => Promise<T>): Promise<T>;
  putSource(name: string, source: string): Promise<void>;
  putArtifact(name: string, artifact: CustomToolSourceArtifact): Promise<void>;
  putMeta(name: string, meta: CustomToolMeta): Promise<void>;
  putBundle(name: string, code: string): Promise<void>;
  getSource(name: string): Promise<string | null>;
  getArtifact(name: string): Promise<CustomToolSourceArtifact | null>;
  getMeta(name: string): Promise<CustomToolMeta | null>;
  getBundle(name: string): Promise<string | null>;
  list(): Promise<string[]>;
  has(name: string): Promise<boolean>;
  remove(name: string): Promise<boolean>;
}

export class CustomToolBusyError extends Error {
  readonly code = "tool_busy";
  constructor(name: string) {
    super(`Tool "${name}" is being updated. Retry after the current operation finishes.`);
    this.name = "CustomToolBusyError";
  }
}

// Wrappers may be reconstructed per request. Ownership belongs to the actual
// filesystem/root, not the wrapper, and never blocks a different environment.
const mutations = new WeakMap<FileSystem, Map<string, Set<string>>>();

/**
 * FileSystem-backed custom-tool registry shared by self-hosted and managed
 * adapters. The caller owns the storage root and execution strategy.
 */
export function createCustomToolsStore(
  fs: FileSystem,
  toolsDir: string,
): CustomToolsStore {
  const root = toolsDir.replace(/\/+$/, "");
  const pathFor = (name: string, extension: string) => {
    if (!CUSTOM_TOOL_NAME_RE.test(name)) {
      throw new Error(`Invalid custom tool name: ${name}`);
    }
    return `${root}/${name}.${extension}`;
  };

  const readOptional = async (path: string): Promise<string | null> => {
    if (!(await fs.exists(path))) return null;
    return fs.readFile(path);
  };

  const putArtifact = async (
    name: string,
    artifact: CustomToolSourceArtifact,
  ): Promise<void> => {
    const parsed = parseCustomToolSourceArtifact(artifact);
    await fs.mkdir(root);
    // Settle each write before returning an error: a still-running sibling
    // write must not race a caller's compensating restore.
    await fs.writeFile(pathFor(name, "ts"), customToolArtifactEntrySource(parsed));
    await fs.writeFile(pathFor(name, "source.json"), JSON.stringify(parsed));
  };

  const getArtifact = async (
    name: string,
  ): Promise<CustomToolSourceArtifact | null> => {
    const raw = await readOptional(pathFor(name, "source.json"));
    if (raw !== null) {
      try {
        return parseCustomToolSourceArtifact(JSON.parse(raw));
      } catch {
        return null;
      }
    }
    const source = await readOptional(pathFor(name, "ts"));
    return source === null ? null : createSingleFileCustomToolArtifact(name, source);
  };

  return {
    async withMutation(name, operation) {
      pathFor(name, "ts");
      let roots = mutations.get(fs);
      if (!roots) { roots = new Map(); mutations.set(fs, roots); }
      let active = roots.get(root);
      if (!active) { active = new Set(); roots.set(root, active); }
      if (active.has(name)) throw new CustomToolBusyError(name);
      active.add(name);
      try { return await operation(); }
      finally {
        active.delete(name);
        if (active.size === 0) roots.delete(root);
        if (roots.size === 0) mutations.delete(fs);
      }
    },
    async putSource(name, source) {
      await putArtifact(name, createSingleFileCustomToolArtifact(name, source));
    },
    putArtifact,
    async putMeta(name, meta) {
      await fs.mkdir(root);
      await fs.writeFile(pathFor(name, "json"), JSON.stringify(meta, null, 2));
    },
    async putBundle(name, code) {
      await fs.mkdir(root);
      await fs.writeFile(pathFor(name, "mjs"), code);
    },
    getSource(name) {
      return getArtifact(name).then((artifact) =>
        artifact ? customToolArtifactEntrySource(artifact) : null);
    },
    getArtifact,
    async getMeta(name) {
      const raw = await readOptional(pathFor(name, "json"));
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as CustomToolMeta;
      } catch {
        return null;
      }
    },
    getBundle(name) {
      return readOptional(pathFor(name, "mjs"));
    },
    async list() {
      if (!(await fs.exists(root))) return [];
      return (await fs.readdir(root))
        .filter((entry) => entry.endsWith(".ts"))
        .map((entry) => entry.slice(0, -3))
        .filter((name) => CUSTOM_TOOL_NAME_RE.test(name))
        .sort();
    },
    has(name) {
      return fs.exists(pathFor(name, "ts"));
    },
    async remove(name) {
      const existed = await fs.exists(pathFor(name, "ts"));
      for (const extension of ["ts", "source.json", "json", "mjs"]) {
        const path = pathFor(name, extension);
        if (await fs.exists(path)) await fs.remove(path);
      }
      return existed;
    },
  };
}
