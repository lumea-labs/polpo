import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectCustomToolSourceArtifact } from "../../src/util/custom-tool-source.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "polpo-tool-source-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  return root;
}

describe("collectCustomToolSourceArtifact", () => {
  it("collects extensionless, index, JSON, and cyclic local dependencies", async () => {
    const root = await fixture({
      "site_context_get.ts": `
        import { platform } from "./_leo_platform";
        import { value } from "./lib";
        import config from "./config.json";
        export default { platform, value, config };
      `,
      "_leo_platform.ts": `
        import { value } from "./lib/index";
        export const platform = value;
      `,
      "lib/index.ts": `
        import "../_leo_platform";
        export const value = 1;
      `,
      "config.json": `{ "enabled": true }`,
    });

    const artifact = await collectCustomToolSourceArtifact(
      join(root, "site_context_get.ts"),
      root,
    );
    expect(artifact.entry).toBe("site_context_get.ts");
    expect(Object.keys(artifact.files)).toEqual([
      "_leo_platform.ts",
      "config.json",
      "lib/index.ts",
      "site_context_get.ts",
    ]);
  });

  it("keeps bare packages external while packaging local modules", async () => {
    const root = await fixture({
      "entry.ts": `
        import { defineTool } from "@polpo-ai/tools";
        import { helper } from "./helper";
        export default defineTool({ name: "entry", description: helper } as any);
      `,
      "helper.ts": `export const helper = "ok";`,
    });
    const artifact = await collectCustomToolSourceArtifact(join(root, "entry.ts"), root);
    expect(Object.keys(artifact.files)).toEqual(["entry.ts", "helper.ts"]);
  });

  it("rejects source dependencies outside the selected root", async () => {
    const parent = await fixture({
      "tools/entry.ts": `import { secret } from "../secret"; export default secret;`,
      "secret.ts": `export const secret = "no";`,
    });
    await expect(collectCustomToolSourceArtifact(
      join(parent, "tools/entry.ts"),
      join(parent, "tools"),
    )).rejects.toThrow(/outside/i);
  });

  it("rejects symlinked source files", async () => {
    const root = await fixture({
      "entry.ts": `import { helper } from "./helper"; export default helper;`,
      "real-helper.ts": `export const helper = "no";`,
    });
    await symlink(join(root, "real-helper.ts"), join(root, "helper.ts"));
    await expect(collectCustomToolSourceArtifact(join(root, "entry.ts"), root))
      .rejects.toThrow(/symbolic link/i);
  });

  it("rejects computed dynamic imports but includes literal dynamic imports", async () => {
    const invalid = await fixture({
      "entry.ts": `const path = "./helper"; export const load = () => import(path);`,
    });
    await expect(collectCustomToolSourceArtifact(join(invalid, "entry.ts"), invalid))
      .rejects.toThrow(/dynamic import/i);

    const valid = await fixture({
      "entry.ts": `export const load = () => import("./helper");`,
      "helper.ts": `export const helper = "ok";`,
    });
    expect(Object.keys((await collectCustomToolSourceArtifact(
      join(valid, "entry.ts"),
      valid,
    )).files)).toEqual(["entry.ts", "helper.ts"]);
  });
});
