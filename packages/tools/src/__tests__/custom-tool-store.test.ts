import { describe, expect, it } from "vitest";

import type { FileSystem, FileStat } from "@polpo-ai/core/filesystem";
import { createCustomToolsStore } from "../custom-tool-store.js";
import { parseCustomToolSourceArtifact } from "../custom-tool-source-artifact.js";

class MemoryFs implements FileSystem {
  files = new Map<string, string>();
  dirs = new Set<string>();
  async readFile(path: string) { return this.files.get(path)!; }
  async writeFile(path: string, content: string) { this.files.set(path, content); }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async readdir(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"))
      .map((entry) => entry.slice(prefix.length));
  }
  async mkdir(path: string) { this.dirs.add(path); }
  async remove(path: string) { this.files.delete(path); }
  async stat(path: string): Promise<FileStat> {
    const content = this.files.get(path);
    return { size: content?.length ?? 0, isDirectory: this.dirs.has(path), isFile: content !== undefined };
  }
  async rename(oldPath: string, newPath: string) {
    const content = this.files.get(oldPath)!;
    this.files.delete(oldPath);
    this.files.set(newPath, content);
  }
}

describe("createCustomToolsStore", () => {
  it("persists source, metadata and bundle independently", async () => {
    const store = createCustomToolsStore(new MemoryFs(), "/project/.polpo/tools");
    await store.putSource("lookup_customer", "export default {};");
    await store.putMeta("lookup_customer", {
      name: "lookup_customer",
      description: "Find a customer",
      parameters: { type: "object" },
      label: "Lookup customer",
      clientSide: false,
    });
    await store.putBundle("lookup_customer", "export default {};");

    expect(await store.list()).toEqual(["lookup_customer"]);
    expect(await store.getMeta("lookup_customer")).toMatchObject({ description: "Find a customer" });
    expect(await store.getBundle("lookup_customer")).toContain("export default");
  });

  it("removes every artifact and rejects unsafe names", async () => {
    const store = createCustomToolsStore(new MemoryFs(), "/project/.polpo/tools");
    await store.putSource("echo", "source");
    await store.putBundle("echo", "bundle");
    expect(await store.remove("echo")).toBe(true);
    expect(await store.has("echo")).toBe(false);
    await expect(store.putSource("../escape", "source")).rejects.toThrow("Invalid custom tool name");
  });

  it("round-trips a multi-file artifact and preserves the entry source API", async () => {
    const store = createCustomToolsStore(new MemoryFs(), "/project/.polpo/tools");
    const artifact = parseCustomToolSourceArtifact({
      version: 1,
      entry: "site_context_get.ts",
      files: {
        "site_context_get.ts": `import "./_leo_platform"; export default {};`,
        "_leo_platform.ts": `export const platform = "leo";`,
      },
    });
    await store.putArtifact("site_context_get", artifact);

    expect(await store.getArtifact("site_context_get")).toEqual(artifact);
    expect(await store.getSource("site_context_get")).toContain("_leo_platform");
  });

  it("reads legacy single-file records as versioned artifacts", async () => {
    const fs = new MemoryFs();
    fs.files.set("/project/.polpo/tools/echo.ts", "export default {};");
    const store = createCustomToolsStore(fs, "/project/.polpo/tools");

    expect(await store.getArtifact("echo")).toEqual({
      version: 1,
      entry: "echo.ts",
      files: { "echo.ts": "export default {};" },
    });
  });
});
