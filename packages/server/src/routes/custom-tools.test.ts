import { describe, expect, it } from "vitest";

import type { FileSystem, FileStat } from "@polpo-ai/core/filesystem";
import { createCustomToolsStore } from "@polpo-ai/tools";
import { customToolRoutes } from "./custom-tools.js";

class MemoryFs implements FileSystem {
  files = new Map<string, string>();
  dirs = new Set<string>();
  async readFile(path: string) { return this.files.get(path)!; }
  async writeFile(path: string, content: string) { this.files.set(path, content); }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async readdir(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }
  async mkdir(path: string) { this.dirs.add(path); }
  async remove(path: string) { this.files.delete(path); }
  async stat(path: string): Promise<FileStat> {
    return { size: this.files.get(path)?.length ?? 0, isDirectory: this.dirs.has(path), isFile: this.files.has(path) };
  }
  async rename(oldPath: string, newPath: string) { this.files.set(newPath, this.files.get(oldPath)!); this.files.delete(oldPath); }
}

describe("customToolRoutes", () => {
  it("supports deploy, list, detail, run and delete through injected adapters", async () => {
    const store = createCustomToolsStore(new MemoryFs(), "/tools");
    const app = customToolRoutes(() => ({
      store,
      deployer: {
        async deploy(name, _source, onProgress) {
          onProgress?.({ step: "bundle", detail: "Bundling" });
          return {
            errors: [],
            bundle: "bundle",
            deps: [],
            meta: { name, description: "Echo input", parameters: { type: "object" }, label: name, clientSide: false },
          };
        },
      },
      runner: { async run(name, args) { return { name, args }; } },
    }));

    const deploy = await app.request("/echo/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "export default defineTool({ name: 'echo' })" }),
    });
    expect(deploy.status).toBe(200);
    expect(await deploy.text()).toContain("event: done");

    const list = await app.request("/");
    expect(await list.json()).toMatchObject({ data: [{ name: "echo", description: "Echo input" }] });

    const detail = await app.request("/echo");
    expect(await detail.json()).toMatchObject({ data: { name: "echo", meta: { description: "Echo input" } } });

    const run = await app.request("/echo/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: { value: "hello" } }),
    });
    expect(await run.json()).toMatchObject({ data: { name: "echo", args: { value: "hello" } } });

    expect((await app.request("/echo", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/echo")).status).toBe(404);
  });

  it("restores the previous tool when an update fails validation", async () => {
    const store = createCustomToolsStore(new MemoryFs(), "/tools");
    await store.putSource("echo", "old source");
    const app = customToolRoutes(() => ({
      store,
      deployer: { async deploy() { return { errors: ["invalid source"] }; } },
    }));

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "echo", source: "broken source" }),
    });
    expect(response.status).toBe(400);
    expect(await store.getSource("echo")).toBe("old source");
  });
});
