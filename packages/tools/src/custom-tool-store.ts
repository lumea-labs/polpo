import type { FileSystem } from "@polpo-ai/core/filesystem";
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
}

export interface CustomToolsStore {
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
    await Promise.all([
      fs.writeFile(pathFor(name, "ts"), customToolArtifactEntrySource(parsed)),
      fs.writeFile(pathFor(name, "source.json"), JSON.stringify(parsed)),
    ]);
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
      await Promise.all(
        ["ts", "source.json", "json", "mjs"].map((extension) =>
          fs.remove(pathFor(name, extension)).catch(() => undefined),
        ),
      );
      return existed;
    },
  };
}
