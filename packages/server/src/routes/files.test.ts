import { describe, it, expect, vi } from "vitest";
import { fileRoutes, type FileRouteDeps } from "./files.js";
import type { FileSystem, FileEntry } from "@polpo-ai/core";

function makeFs(tree: Record<string, FileEntry[]>) {
  const stat = vi.fn(async () => ({
    size: 999, isDirectory: false, isFile: true, modifiedAt: new Date(),
  }));
  const fs = {
    readdirWithTypes: async (p: string) => tree[p] ?? [],
    readdir: async (p: string) => (tree[p] ?? []).map((e) => e.name),
    stat,
  } as unknown as FileSystem;
  return { fs, stat };
}

function mount(fs: FileSystem) {
  const deps: FileRouteDeps = {
    workDir: "/work",
    polpoDir: "/polpo",
    agentWorkDir: "/work",
    fs,
    emit: () => {},
  };
  return fileRoutes(() => deps);
}

describe("GET /roots — dirStats size accounting", () => {
  it("sums sizes from the directory listing without a per-file stat", async () => {
    const { fs, stat } = makeFs({
      "/work": [
        { name: "a.txt", isFile: true, isDirectory: false, size: 10 },
        { name: "b.txt", isFile: true, isDirectory: false, size: 20 },
        { name: "sub", isFile: false, isDirectory: true },
      ],
      "/work/sub": [{ name: "c.txt", isFile: true, isDirectory: false, size: 5 }],
      "/polpo": [{ name: "x", isFile: true, isDirectory: false, size: 3 }],
    });

    const res = await mount(fs).request("/roots");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const ws = body.data.roots.find((r: any) => r.id === "workspace");
    const polpo = body.data.roots.find((r: any) => r.id === "polpo");

    expect(ws).toMatchObject({ totalFiles: 3, totalSize: 35 }); // 10 + 20 + 5
    expect(polpo).toMatchObject({ totalFiles: 1, totalSize: 3 });
    // The whole point of the fix: no N+1 HeadObject storm.
    expect(stat).not.toHaveBeenCalled();
  });

  it("falls back to fs.stat when the listing carries no size", async () => {
    const { fs, stat } = makeFs({
      "/work": [{ name: "a.txt", isFile: true, isDirectory: false }], // no size
      "/polpo": [],
    });

    const res = await mount(fs).request("/roots");
    expect(res.status).toBe(200);
    expect(stat).toHaveBeenCalledTimes(1); // exactly the one file with no listed size
  });
});
