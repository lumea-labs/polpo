import { describe, expect, it, vi } from "vitest";

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

  it("deploys a validated multi-file artifact and returns it from detail", async () => {
    const store = createCustomToolsStore(new MemoryFs(), "/tools");
    let receivedFiles: string[] = [];
    const app = customToolRoutes(() => ({
      store,
      deployer: {
        async deploy() {
          throw new Error("single-file deploy should not be used");
        },
        async deployArtifact(name, artifact) {
          receivedFiles = Object.keys(artifact.files);
          return {
            errors: [],
            bundle: "bundle",
            meta: {
              name,
              description: "Site context",
              parameters: { type: "object" },
              label: name,
              clientSide: false,
            },
          };
        },
      },
    }));
    const artifact = {
      version: 1,
      entry: "site_context_get.ts",
      files: {
        "site_context_get.ts": `import "./_leo_platform"; export default {};`,
        "_leo_platform.ts": `export const platform = "leo";`,
      },
    };

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "site_context_get", artifact }),
    });
    expect(response.status).toBe(201);
    expect(receivedFiles).toEqual(["_leo_platform.ts", "site_context_get.ts"]);
    expect(await (await app.request("/site_context_get")).json()).toMatchObject({
      data: { artifact: { entry: "site_context_get.ts", files: artifact.files } },
    });
  });

  it("rejects unsafe artifacts before storage or deployment", async () => {
    const store = createCustomToolsStore(new MemoryFs(), "/tools");
    let deployed = false;
    const app = customToolRoutes(() => ({
      store,
      deployer: {
        async deploy() {
          deployed = true;
          return { errors: [] };
        },
      },
    }));
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "escape",
        artifact: {
          version: 1,
          entry: "../escape.ts",
          files: { "../escape.ts": "export default {};" },
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(deployed).toBe(false);
    expect(await store.has("escape")).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const jsonRequest = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const toolMeta = (name: string, description: string) => ({ name, description, parameters: {}, label: name, clientSide: false });

describe("custom tool publication", () => {
  it.each(["json", "sse"])("keeps the published source visible during %s validation and on failure", async surface => {
    const store = createCustomToolsStore(new MemoryFs(), "/tools");
    await store.putSource("echo", "published");
    await store.putMeta("echo", toolMeta("echo", "published"));
    await store.putBundle("echo", "published bundle");
    const started = deferred<void>(), result = deferred<{ errors: string[] }>();
    const app = customToolRoutes(() => ({ store, deployer: { async deploy() { started.resolve(); return result.promise; } } }));
    const pending = Promise.resolve(app.request(surface === "json" ? "/" : "/echo/deploy", jsonRequest({ name: "echo", source: "invalid candidate" })))
      .then(async response => ({ status: response.status, text: await response.text() }));
    await started.promise;
    const observed = await (await app.request("/echo")).json();
    result.resolve({ errors: ["validation failed"] });
    const response = await pending;
    expect(observed.data.source).toBe("published");
    expect(await store.getSource("echo")).toBe("published");
    expect(await store.getBundle("echo")).toBe("published bundle");
    expect(response.text).toContain("validation failed");
  });

  it("coordinates fresh store wrappers sharing a filesystem while keeping other tools and environments independent", async () => {
    const fs = new MemoryFs(), started = deferred<void>(), release = deferred<void>();
    let builds = 0;
    const app = customToolRoutes(() => ({ store: createCustomToolsStore(fs, "/development/tools"), deployer: {
      async deploy(name) { builds++; if (name === "echo" && builds === 1) { started.resolve(); await release.promise; } return { errors: [], meta: toolMeta(name, name) }; },
    } }));
    const first = Promise.resolve(app.request("/echo/deploy", jsonRequest({ source: "first" }))).then(r => r.text());
    await started.promise;
    const update = await app.request("/", jsonRequest({ name: "echo", source: "second" }));
    const removal = await app.request("/echo", { method: "DELETE" });
    const other = await app.request("/", jsonRequest({ name: "other", source: "other" }));
    const production = customToolRoutes(() => ({ store: createCustomToolsStore(fs, "/production/tools") }));
    const independent = await production.request("/", jsonRequest({ name: "echo", source: "production" }));
    release.resolve();
    await first;
    expect(update.status).toBe(409);
    expect(await update.json()).toMatchObject({ code: "tool_busy" });
    expect(removal.status).toBe(409);
    expect(other.status).toBe(201);
    expect(independent.status).toBe(201);
    expect(builds).toBe(2);
    expect(await createCustomToolsStore(fs, "/development/tools").getSource("echo")).toBe("first");
    expect((await app.request("/echo", { method: "DELETE" })).status).toBe(200);
  });

  it("restores all prior files after a publication write fails and releases mutation ownership", async () => {
    const fs = new MemoryFs(), store = createCustomToolsStore(fs, "/tools");
    await store.putSource("echo", "old");
    await store.putMeta("echo", toolMeta("echo", "old"));
    await store.putBundle("echo", "old bundle");
    const write = fs.writeFile.bind(fs);
    let failed = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (path, content) => {
      if (!failed && path === "/tools/echo.json" && content.includes("new")) { failed = true; throw Error("write failed"); }
      await write(path, content);
    });
    const app = customToolRoutes(() => ({ store, deployer: { async deploy() { return { errors: [], bundle: "new bundle", meta: toolMeta("echo", "new") }; } } }));
    const response = await app.request("/echo/deploy", jsonRequest({ source: "new" }));
    expect(await response.text()).toContain("event: error");
    expect(await store.getSource("echo")).toBe("old");
    expect(await store.getMeta("echo")).toMatchObject({ description: "old" });
    expect(await store.getBundle("echo")).toBe("old bundle");
    expect((await app.request("/", jsonRequest({ name: "echo", source: "new" }))).status).toBe(201);
  });

  it("retains ownership after SSE cancellation and preserves the completed deployment", async () => {
    const store = createCustomToolsStore(new MemoryFs(), "/tools");
    await store.putSource("echo", "old");
    const release = deferred<void>();
    const app = customToolRoutes(() => ({ store, deployer: {
      async deploy(name, _source, progress) {
        progress?.({ step: "validate" });
        await release.promise;
        return { errors: [], bundle: "new bundle", meta: toolMeta(name, "new") };
      },
    } }));
    const response = await app.request("/echo/deploy", jsonRequest({ source: "new" }));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("progress");
    await reader.cancel();
    expect((await app.request("/echo", { method: "DELETE" })).status).toBe(409);
    release.resolve();
    await vi.waitFor(async () => expect(await store.getBundle("echo")).toBe("new bundle"));
    expect(await store.getSource("echo")).toBe("new");
    expect(await store.getMeta("echo")).toMatchObject({ description: "new" });
    await vi.waitFor(async () => expect((await app.request("/echo", { method: "DELETE" })).status).toBe(200));
  });

  it("clears obsolete metadata and bundle when replacing an unvalidated source", async () => {
    const store = createCustomToolsStore(new MemoryFs(), "/tools");
    await store.putSource("echo", "old");
    await store.putMeta("echo", toolMeta("echo", "old"));
    await store.putBundle("echo", "old bundle");
    const app = customToolRoutes(() => ({ store }));
    expect((await app.request("/", jsonRequest({ name: "echo", source: "new" }))).status).toBe(201);
    expect(await store.getSource("echo")).toBe("new");
    expect(await store.getBundle("echo")).toBeNull();
    expect(await store.getMeta("echo")).toBeNull();
  });
});
