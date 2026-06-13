import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ProjectLoopRunStatus, LoopRunStore } from "@polpo-ai/core/loop-run-store";

export interface LoopRunRouteDeps {
  loopRunStore?: LoopRunStore;
}

const statusSchema = z.enum(["running", "completed", "failed", "awaiting_approval", "cancelled"]);

export function loopRunRoutes(getDeps: () => LoopRunRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["Loop Runs"],
      summary: "List agentic loop runs",
      request: {
        query: z.object({
          loopName: z.string().optional(),
          agentName: z.string().optional(),
          sessionId: z.string().optional(),
          user: z.string().optional(),
          status: statusSchema.optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } }, description: "Loop run list" },
        501: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run store unavailable" },
      },
    }),
    async (c) => {
      const store = getDeps().loopRunStore;
      if (!store) return c.json({ ok: false as const, error: "Loop run store is not configured", code: "LOOP_RUN_STORE_UNAVAILABLE" }, 501);
      const q = c.req.valid("query");
      const data = await store.listRuns({
        loopName: q.loopName,
        agentName: q.agentName,
        sessionId: q.sessionId,
        user: q.user,
        status: q.status as ProjectLoopRunStatus | undefined,
        limit: q.limit,
      });
      return c.json({ ok: true, data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/:id",
      tags: ["Loop Runs"],
      summary: "Get agentic loop run",
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Loop run" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run not found" },
        501: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run store unavailable" },
      },
    }),
    async (c: any) => {
      const store = getDeps().loopRunStore;
      if (!store) return c.json({ ok: false as const, error: "Loop run store is not configured", code: "LOOP_RUN_STORE_UNAVAILABLE" }, 501);
      const run = await store.getRun(c.req.param("id"));
      if (!run) return c.json({ ok: false as const, error: "Loop run not found", code: "NOT_FOUND" }, 404);
      return c.json({ ok: true, data: run }, 200);
    },
  );

  return app;
}
