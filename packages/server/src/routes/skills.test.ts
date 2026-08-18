import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileEntry, FileStat, FileSystem } from "@polpo-ai/core";
import { skillRoutes } from "./skills.js";

class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(["/"]);

  async readFile(path: string): Promise<string> {
    const file = this.files.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return new TextDecoder().decode(file);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeFileBuffer(path, new TextEncoder().encode(content));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return new Uint8Array(file);
  }

  async writeFileBuffer(path: string, data: Uint8Array): Promise<void> {
    await this.mkdir(dirname(path));
    this.files.set(path, new Uint8Array(data));
  }

  async exists(path: string): Promise<boolean> {
    if (this.files.has(path) || this.dirs.has(path)) return true;
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...this.files.keys()].some((file) => file.startsWith(prefix));
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithTypes(path)).map((entry) => entry.name);
  }

  async readdirWithTypes(path: string): Promise<FileEntry[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const entries = new Map<string, FileEntry>();
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix) || dir === path) continue;
      const rest = dir.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      entries.set(rest, { name: rest, isDirectory: true, isFile: false });
    }
    for (const [file, data] of this.files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      entries.set(rest, { name: rest, isDirectory: false, isFile: true, size: data.byteLength });
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async mkdir(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      this.dirs.add(current);
    }
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
    for (const key of [...this.dirs]) {
      if (key === path || key.startsWith(prefix)) this.dirs.delete(key);
    }
  }

  async stat(path: string): Promise<FileStat> {
    const file = this.files.get(path);
    if (file) return { size: file.byteLength, isDirectory: false, isFile: true };
    if (await this.exists(path)) return { size: 0, isDirectory: true, isFile: false };
    throw new Error(`Not found: ${path}`);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const file = this.files.get(oldPath);
    if (file) {
      await this.writeFileBuffer(newPath, file);
      this.files.delete(oldPath);
      return;
    }
    const prefix = oldPath.endsWith("/") ? oldPath : `${oldPath}/`;
    const matches = [...this.files.entries()].filter(([path]) => path.startsWith(prefix));
    if (matches.length === 0 && !this.dirs.has(oldPath)) throw new Error(`File not found: ${oldPath}`);
    await this.mkdir(newPath);
    for (const [source, data] of matches) {
      await this.writeFileBuffer(`${newPath}/${source.slice(prefix.length)}`, data);
      this.files.delete(source);
    }
    for (const dir of [...this.dirs].filter((path) => path === oldPath || path.startsWith(prefix))) {
      const suffix = dir === oldPath ? "" : dir.slice(prefix.length);
      this.dirs.delete(dir);
      await this.mkdir(suffix ? `${newPath}/${suffix}` : newPath);
    }
  }
}

describe("skillRoutes", () => {
  it("installs the complete skill bundle, not only SKILL.md", async () => {
    const sourceFs = new MemoryFileSystem();
    const targetFs = new MemoryFileSystem();
    await sourceFs.writeFile(
      "/repo/skills/full-bundle/SKILL.md",
      "---\nname: full-bundle\ndescription: Full bundle\n---\n\nUse every file.",
    );
    await sourceFs.writeFile("/repo/skills/full-bundle/references/guide.md", "# Guide\n\nDetails.");
    await sourceFs.writeFile("/repo/skills/full-bundle/scripts/run.sh", "echo ok\n");
    await sourceFs.writeFileBuffer("/repo/skills/full-bundle/assets/logo.bin", new Uint8Array([0, 1, 2, 255]));

    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs: targetFs,
      installFs: sourceFs,
      shell: {
        execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      getAgents: async () => [],
    }));

    const response = await app.request("/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "/repo" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data.installed).toEqual(["full-bundle"]);
    expect(await targetFs.readFile("/project/.polpo/skills/full-bundle/SKILL.md")).toContain("Use every file.");
    expect(await targetFs.readFile("/project/.polpo/skills/full-bundle/references/guide.md")).toContain("Details.");
    expect(await targetFs.readFile("/project/.polpo/skills/full-bundle/scripts/run.sh")).toBe("echo ok\n");
    expect([...await targetFs.readFileBuffer("/project/.polpo/skills/full-bundle/assets/logo.bin")]).toEqual([0, 1, 2, 255]);
    expect(await targetFs.readdir("/project/.polpo/skills/full-bundle")).toEqual(expect.arrayContaining([
      "assets",
      "references",
      "scripts",
      "SKILL.md",
    ]));
  });

  it("round-trips complete skill bundles through the management API", async () => {
    const fs = new MemoryFileSystem();
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs,
      getAgents: async () => [],
    }));

    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from("---\nname: frontend-design\ndescription: Design interfaces\n---\n\nUse references.").toString("base64"),
        encoding: "base64",
      },
      {
        path: "references/guide.md",
        content: Buffer.from("# Guide\n\nRead me.").toString("base64"),
        encoding: "base64",
      },
      {
        path: "assets/palette.bin",
        content: Buffer.from([0, 1, 2, 255]).toString("base64"),
        encoding: "base64",
      },
    ];

    const put = await app.request("/frontend-design/bundle", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    expect(put.status).toBe(200);

    const get = await app.request("/frontend-design/bundle");
    expect(get.status).toBe(200);
    expect((await get.json()).data.files).toEqual(
      [...files].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  it("replaces a bundle and removes files absent from the new version", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile(
      "/project/.polpo/skills/reviewer/SKILL.md",
      "---\nname: reviewer\ndescription: Review code\n---\n\nOld.",
    );
    await fs.writeFile("/project/.polpo/skills/reviewer/references/stale.md", "stale");
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs,
      getAgents: async () => [],
    }));

    const response = await app.request("/reviewer/bundle", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{
          path: "SKILL.md",
          content: Buffer.from("---\nname: reviewer\ndescription: Review code\n---\n\nNew.").toString("base64"),
          encoding: "base64",
        }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await fs.readFile("/project/.polpo/skills/reviewer/SKILL.md")).toContain("New.");
    expect(await fs.exists("/project/.polpo/skills/reviewer/references/stale.md")).toBe(false);
  });

  it.each([
    ["a traversal path", [{ path: "../secret", content: "eA==", encoding: "base64" }]],
    ["an absolute path", [{ path: "/secret", content: "eA==", encoding: "base64" }]],
    ["duplicate paths", [
      { path: "SKILL.md", content: "eA==", encoding: "base64" },
      { path: "SKILL.md", content: "eQ==", encoding: "base64" },
    ]],
    ["no SKILL.md", [{ path: "references/guide.md", content: "eA==", encoding: "base64" }]],
    ["invalid base64", [{ path: "SKILL.md", content: "not base64!", encoding: "base64" }]],
  ])("rejects bundles containing %s", async (_label, files) => {
    const fs = new MemoryFileSystem();
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs,
      getAgents: async () => [],
    }));

    const response = await app.request("/safe-skill/bundle", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });

    expect(response.status).toBe(400);
    expect(await fs.exists("/project/.polpo/skills/safe-skill")).toBe(false);
  });
});
