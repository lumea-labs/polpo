import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SkillBundleStoreConflictError,
  type FileEntry,
  type FileStat,
  type FileSystem,
  type SkillBundleStore,
  type SkillBundleReceipt,
  type StoredSkillBundle,
  type StoredSkillSummary,
  type ValidatedSkillBundle,
} from "@polpo-ai/core";
import { packSkillArchive } from "@polpo-ai/core/skill-archive";
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

class MemorySkillBundleStore implements SkillBundleStore {
  private readonly active = new Map<string, string>();
  private readonly versions = new Map<string, StoredSkillBundle>();

  private key(name: string, digest: string): string { return `${name}:${digest}`; }

  async get(name: string, digest?: string): Promise<StoredSkillBundle | null> {
    const resolved = digest ?? this.active.get(name);
    return resolved ? this.versions.get(this.key(name, resolved)) ?? null : null;
  }

  async put(input: ValidatedSkillBundle, options: { conflict: "error" | "replace"; expectedDigest?: string }): Promise<SkillBundleReceipt> {
    const currentDigest = this.active.get(input.bundle.name);
    if (currentDigest === input.digest) {
      return this.receipt(input, false);
    }
    if (options.expectedDigest !== undefined && currentDigest !== options.expectedDigest) {
      throw new SkillBundleStoreConflictError("skill_digest_conflict", "stale digest", currentDigest);
    }
    if (currentDigest && options.conflict === "error") {
      throw new SkillBundleStoreConflictError("skill_conflict", "already exists", currentDigest);
    }
    this.versions.set(this.key(input.bundle.name, input.digest), { ...input, root: `/immutable/${input.digest}` });
    this.active.set(input.bundle.name, input.digest);
    return this.receipt(input, true);
  }

  async delete(name: string): Promise<boolean> { return this.active.delete(name); }

  async list(): Promise<StoredSkillSummary[]> {
    const rows: StoredSkillSummary[] = [];
    for (const [name, digest] of this.active) {
      const stored = this.versions.get(this.key(name, digest))!;
      rows.push({
        name,
        description: stored.manifest.description,
        digest,
        files: stored.bundle.files.length,
        uncompressedBytes: stored.uncompressedBytes,
        source: stored.source,
        allowedTools: stored.manifest.allowedTools,
        root: stored.root,
      });
    }
    return rows;
  }

  private receipt(input: ValidatedSkillBundle, changed: boolean): SkillBundleReceipt {
    return {
      name: input.bundle.name,
      digest: input.digest,
      files: input.bundle.files.length,
      uncompressedBytes: input.uncompressedBytes,
      changed,
      source: input.source,
      warnings: [],
    };
  }
}

describe("skillRoutes", () => {
  it("uses a content-addressed store without mutating the compatibility filesystem", async () => {
    const fs = new MemoryFileSystem();
    const skillBundleStore = new MemorySkillBundleStore();
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs,
      skillBundleStore,
      getAgents: async () => [],
    }));
    const files = [{
      path: "SKILL.md",
      content: Buffer.from("---\nname: immutable-skill\ndescription: Immutable\n---\n\nFirst").toString("base64"),
      encoding: "base64",
    }];

    const first = await app.request("/immutable-skill/bundle", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    expect(first.status).toBe(200);
    const firstReceipt = (await first.json()).data;
    expect(await fs.exists("/project/.polpo/skills/immutable-skill")).toBe(false);
    expect((await app.request("/immutable-skill/bundle")).status).toBe(200);
    expect((await app.request("/immutable-skill/archive")).status).toBe(200);

    const replacement = [{
      ...files[0],
      content: Buffer.from("---\nname: immutable-skill\ndescription: Immutable\n---\n\nSecond").toString("base64"),
    }];
    const stale = await app.request("/immutable-skill/bundle", {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "\"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"" },
      body: JSON.stringify({ files: replacement }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("skill_digest_conflict");

    const replaced = await app.request("/immutable-skill/bundle", {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": `"${firstReceipt.digest}"` },
      body: JSON.stringify({ files: replacement }),
    });
    expect(replaced.status).toBe(200);
    const secondDigest = (await replaced.json()).data.digest;
    expect(secondDigest).not.toBe(firstReceipt.digest);
    expect((await skillBundleStore.get("immutable-skill", firstReceipt.digest))?.digest).toBe(firstReceipt.digest);
    expect((await skillBundleStore.get("immutable-skill"))?.digest).toBe(secondDigest);
  });

  it("rejects oversized archive requests before multipart parsing", async () => {
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs: new MemoryFileSystem(),
      getAgents: async () => [],
    }));
    const response = await app.request("/import", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=oversized",
        "content-length": String(31 * 1024 * 1024 + 1_048_576),
      },
      body: "--oversized--\r\n",
    });
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("archive_limit_exceeded");
  });

  it("imports and exports a portable .skill archive with an idempotent receipt", async () => {
    const fs = new MemoryFileSystem();
    const onSkillChanged = vi.fn(async () => {});
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs,
      getAgents: async () => [],
      onSkillChanged,
    }));
    const files = [{
      path: "SKILL.md",
      content: Buffer.from("---\nname: portable-skill\ndescription: Portable\n---\n\nUse it.").toString("base64"),
      encoding: "base64" as const,
    }, {
      path: "assets/data.bin",
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
      encoding: "base64" as const,
    }];
    const archive = await packSkillArchive({ name: "portable-skill", files });
    const form = new FormData();
    form.set("archive", new File([Uint8Array.from(archive)], "portable-skill.skill", { type: "application/zip" }));

    const imported = await app.request("/import", { method: "POST", body: form });
    expect(imported.status).toBe(201);
    const receipt = (await imported.json()).data;
    expect(receipt).toMatchObject({
      name: "portable-skill",
      changed: true,
      files: 2,
      source: "archive",
    });
    expect(receipt.digest).toMatch(/^sha256:/);
    expect(onSkillChanged).toHaveBeenCalledWith("portable-skill", receipt.digest);

    const replayForm = new FormData();
    replayForm.set("archive", new File([Uint8Array.from(archive)], "portable-skill.skill"));
    const replay = await app.request("/import", { method: "POST", body: replayForm });
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toMatchObject({ digest: receipt.digest, changed: false });

    const exported = await app.request("/portable-skill/archive");
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("portable-skill.skill");
    const exportedArchive = new Uint8Array(await exported.arrayBuffer());
    expect(exportedArchive).toEqual(archive);

    const restoredFs = new MemoryFileSystem();
    const updateAgentSkills = vi.fn(async () => {});
    const restoredApp = skillRoutes(() => ({
      polpoDir: "/restored/.polpo",
      fs: restoredFs,
      getAgents: async () => [{ name: "consumer", skills: [] }],
      updateAgentSkills,
    }));
    const restoreForm = new FormData();
    restoreForm.set("archive", new File([Uint8Array.from(exportedArchive)], "portable-skill.skill"));
    restoreForm.set("assignTo", "consumer");
    const restored = await restoredApp.request("/import", { method: "POST", body: restoreForm });
    expect(restored.status).toBe(201);
    expect((await restored.json()).data).toMatchObject({
      digest: receipt.digest,
      assignedTo: ["consumer"],
    });
    expect(updateAgentSkills).toHaveBeenCalledWith("consumer", ["portable-skill"]);
    expect([...await restoredFs.readFileBuffer("/restored/.polpo/skills/portable-skill/assets/data.bin")])
      .toEqual([0, 1, 2, 255]);
  });

  it("requires explicit archive replacement and preserves the old bundle on conflict", async () => {
    const fs = new MemoryFileSystem();
    const app = skillRoutes(() => ({ polpoDir: "/project/.polpo", fs, getAgents: async () => [] }));
    const archive = async (body: string) => packSkillArchive({
      name: "conflict-skill",
      files: [{
        path: "SKILL.md",
        content: Buffer.from(`---\nname: conflict-skill\ndescription: Conflict\n---\n\n${body}`).toString("base64"),
        encoding: "base64",
      }],
    });
    const send = async (bytes: Uint8Array, conflict?: "replace") => {
      const form = new FormData();
      form.set("archive", new File([Uint8Array.from(bytes)], "conflict-skill.skill"));
      if (conflict) form.set("conflict", conflict);
      return app.request("/import", { method: "POST", body: form });
    };

    expect((await send(await archive("Old"))).status).toBe(201);
    const conflict = await send(await archive("New"));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("skill_conflict");
    expect(await fs.readFile("/project/.polpo/skills/conflict-skill/SKILL.md")).toContain("Old");
    expect((await send(await archive("New"), "replace")).status).toBe(200);
    expect(await fs.readFile("/project/.polpo/skills/conflict-skill/SKILL.md")).toContain("New");
  });

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

  it("installs a project-local skill path without acquiring a shell", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile(
      "/project/imports/local-skill/SKILL.md",
      "---\nname: local-skill\ndescription: Local project skill\n---\n\nUse it.",
    );
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs,
      getAgents: async () => [],
    }));

    const response = await app.request("/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "/project/imports" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data.installed).toEqual(["local-skill"]);
    expect(await fs.readFile("/project/.polpo/skills/local-skill/SKILL.md"))
      .toContain("Local project skill");
  });

  it("installs a .skill archive data URL without acquiring a shell", async () => {
    const fs = new MemoryFileSystem();
    const updateAgentSkills = vi.fn(async () => {});
    const archive = await packSkillArchive({
      name: "mcp-portable",
      files: [{
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: mcp-portable\ndescription: Imported through MCP\n---\n\nUse it.",
        ).toString("base64"),
        encoding: "base64",
      }, {
        path: "references/guide.md",
        content: Buffer.from("# Guide\n\nPortable reference.").toString("base64"),
        encoding: "base64",
      }],
    });
    const source = `data:application/zip;base64,${Buffer.from(archive).toString("base64")}`;
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs,
      getAgents: async () => [{ name: "consumer", skills: [] }],
      updateAgentSkills,
    }));

    const response = await app.request("/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, assignTo: "consumer" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        installed: ["mcp-portable"],
        skipped: [],
        errors: [],
        source: "archive:data-url",
        assigned: ["mcp-portable"],
      },
    });
    expect(updateAgentSkills).toHaveBeenCalledWith("consumer", ["mcp-portable"]);
    expect(await fs.readFile("/project/.polpo/skills/mcp-portable/references/guide.md"))
      .toContain("Portable reference");
  });

  it("rejects malformed archive data URLs before shell acquisition", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs: new MemoryFileSystem(),
      shell: { execute },
      getAgents: async () => [],
    }));

    const response = await app.request("/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "data:text/plain;base64,bm90IGEgc2tpbGw=" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "invalid_archive" });
    expect(execute).not.toHaveBeenCalled();
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

  it("rejects unsafe builder names and assignments to missing skills", async () => {
    const fs = new MemoryFileSystem();
    const updateAgentSkills = vi.fn(async () => {});
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs,
      getAgents: async () => [{ name: "support", skills: [] }],
      updateAgentSkills,
    }));

    const create = await app.request("/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../escape", description: "Unsafe", content: "No" }),
    });
    expect(create.status).toBe(400);
    expect(await fs.exists("/project/escape")).toBe(false);

    const assign = await app.request("/missing-skill/assign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "support" }),
    });
    expect(assign.status).toBe(404);
    expect(updateAgentSkills).not.toHaveBeenCalled();
  });

  it("removes all assignments before deleting a skill", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile(
      "/project/.polpo/skills/reviewer/SKILL.md",
      "---\nname: reviewer\ndescription: Review\n---\n",
    );
    const agents = [
      { name: "one", skills: ["reviewer", "other"] },
      { name: "two", skills: ["reviewer"] },
    ];
    const updateAgentSkills = vi.fn(async (name: string, skills: string[]) => {
      const agent = agents.find((candidate) => candidate.name === name)!;
      agent.skills = skills;
    });
    const onSkillChanged = vi.fn(async () => {});
    const app = skillRoutes(() => ({
      polpoDir: "/project/.polpo",
      fs,
      getAgents: async () => agents,
      updateAgentSkills,
      onSkillChanged,
    }));

    const response = await app.request("/reviewer", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(updateAgentSkills).toHaveBeenCalledWith("one", ["other"]);
    expect(updateAgentSkills).toHaveBeenCalledWith("two", []);
    expect(onSkillChanged).toHaveBeenCalledWith("reviewer", null);
    expect(await fs.exists("/project/.polpo/skills/reviewer")).toBe(false);
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
