import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { join } from "node:path";
import type { FileSystem, ProjectLoopConfig } from "@polpo-ai/core";
import { projectLoopConfigSchema } from "@polpo-ai/core/schemas";
import { compileLoopSource, LoopDslCompileError } from "../loop-dsl-compiler.js";

export interface LoopRouteDeps {
  polpoDir: string;
  fs: FileSystem;
}

function loopPath(polpoDir: string, name: string): string {
  return join(polpoDir, "loops", `${name}.json`);
}

async function readLoop(fs: FileSystem, polpoDir: string, name: string): Promise<ProjectLoopConfig | null> {
  const path = loopPath(polpoDir, name);
  if (!(await fs.exists(path))) return null;
  const raw = await fs.readFile(path);
  return projectLoopConfigSchema.parse(JSON.parse(raw)) as ProjectLoopConfig;
}

function parseLoopPayload(payload: unknown): ProjectLoopConfig {
  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as { source?: unknown }).source === "string"
  ) {
    const { source, fileName } = payload as { source: string; fileName?: unknown };
    return compileLoopSource(source, typeof fileName === "string" ? fileName : "loop.ts");
  }
  return projectLoopConfigSchema.parse(payload) as ProjectLoopConfig;
}

function validationMessage(error: unknown): string {
  if (error instanceof LoopDslCompileError) return error.message;
  if (error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues?: unknown }).issues)) {
    return (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues
      .map((issue) => `${issue.path.join(".") || "loop"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export function loopRoutes(getDeps: () => LoopRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["Loops"],
      summary: "List project loops",
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } }, description: "Loop list" } },
    }),
    async (c) => {
      const { fs, polpoDir } = getDeps();
      const dir = join(polpoDir, "loops");
      if (!(await fs.exists(dir))) return c.json({ ok: true, data: [] });
      const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json"));
      const loops: ProjectLoopConfig[] = [];
      for (const file of files) {
        const name = file.replace(/\.json$/, "");
        const loop = await readLoop(fs, polpoDir, name).catch(() => null);
        if (loop) loops.push(loop);
      }
      return c.json({ ok: true, data: loops });
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/:name",
      tags: ["Loops"],
      summary: "Get project loop",
      request: { params: z.object({ name: z.string().min(1) }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Loop" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Not found" },
      },
    }),
    async (c: any) => {
      const { fs, polpoDir } = getDeps();
      const loop = await readLoop(fs, polpoDir, c.req.param("name")).catch(() => null);
      if (!loop) return c.json({ ok: false, error: "Loop not found" }, 404);
      return c.json({ ok: true, data: loop });
    },
  );

  const upsert = async (c: any) => {
    const { fs, polpoDir } = getDeps();
    let parsed: ProjectLoopConfig;
    try {
      parsed = parseLoopPayload(await c.req.json());
    } catch (error) {
      return c.json({
        ok: false,
        error: validationMessage(error),
        code: error instanceof LoopDslCompileError ? "LOOP_DSL_COMPILE_ERROR" : "INVALID_LOOP",
      }, 400);
    }
    await fs.mkdir(join(polpoDir, "loops")).catch(() => {});
    await fs.writeFile(loopPath(polpoDir, parsed.name), JSON.stringify(parsed, null, 2) + "\n");
    return c.json({ ok: true, data: parsed });
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["Loops"],
      summary: "Create or replace a project loop",
      request: { body: { content: { "application/json": { schema: z.any() } } } },
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Saved" } },
    }),
    upsert,
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/:name",
      tags: ["Loops"],
      summary: "Replace a project loop",
      request: { params: z.object({ name: z.string().min(1) }), body: { content: { "application/json": { schema: z.any() } } } },
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Saved" } },
    }),
    upsert,
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/:name",
      tags: ["Loops"],
      summary: "Delete a project loop",
      request: { params: z.object({ name: z.string().min(1) }) },
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Deleted" } },
    }),
    async (c: any) => {
      const { fs, polpoDir } = getDeps();
      const name = c.req.param("name");
      const path = loopPath(polpoDir, name);
      if (await fs.exists(path)) await fs.remove(path);
      return c.json({ ok: true, data: { removed: true, name } });
    },
  );

  return app;
}
