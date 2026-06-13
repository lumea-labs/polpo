import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import type { ProjectLoopRunStatus, LoopRunStore } from "@polpo-ai/core/loop-run-store";

export interface LoopRunRouteDeps {
  loopRunStore?: LoopRunStore;
  approvalStore?: ApprovalStore;
}

const statusSchema = z.enum(["running", "completed", "failed", "awaiting_approval", "approval_approved", "approval_rejected", "cancelled"]);
const resolveApprovalBodySchema = z.object({
  resolvedBy: z.string().optional(),
  note: z.string().optional(),
});
const rejectApprovalBodySchema = resolveApprovalBodySchema.extend({
  feedback: z.string().optional(),
});

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

  app.openapi(
    createRoute({
      method: "post",
      path: "/:id/approve",
      tags: ["Loop Runs"],
      summary: "Approve a loop run approval gate",
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: { content: { "application/json": { schema: resolveApprovalBodySchema } }, required: false },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Loop run approval resolved" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run is not awaiting approval" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run not found" },
        501: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run store unavailable" },
      },
    }),
    async (c: any) => resolveLoopApproval(c, getDeps(), "approved"),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/:id/reject",
      tags: ["Loop Runs"],
      summary: "Reject a loop run approval gate",
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: { content: { "application/json": { schema: rejectApprovalBodySchema } }, required: false },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Loop run approval rejected" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run is not awaiting approval" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run not found" },
        501: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run store unavailable" },
      },
    }),
    async (c: any) => resolveLoopApproval(c, getDeps(), "rejected"),
  );

  return app;
}

async function resolveLoopApproval(c: any, deps: LoopRunRouteDeps, decision: "approved" | "rejected") {
  const store = deps.loopRunStore;
  if (!store) return c.json({ ok: false as const, error: "Loop run store is not configured", code: "LOOP_RUN_STORE_UNAVAILABLE" }, 501);

  const run = await store.getRun(c.req.param("id"));
  if (!run) return c.json({ ok: false as const, error: "Loop run not found", code: "NOT_FOUND" }, 404);
  if (run.status !== "awaiting_approval") {
    return c.json({ ok: false as const, error: `Loop run is ${run.status}, not awaiting approval`, code: "NOT_AWAITING_APPROVAL" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const now = new Date().toISOString();
  const note = decision === "rejected" ? body.feedback ?? body.note : body.note;

  if (deps.approvalStore && run.approvalRequestId) {
    const approval = await deps.approvalStore.get(run.approvalRequestId);
    if (approval) {
      await deps.approvalStore.upsert({
        ...approval,
        status: decision,
        resolvedAt: now,
        resolvedBy: body.resolvedBy,
        note,
      });
    }
  }

  await store.appendTrace(run.id, {
    id: `trace-approval-${Date.now()}`,
    ts: now,
    loop: run.loopName,
    type: "approval.required",
    status: decision === "approved" ? "completed" : "failed",
    data: {
      decision,
      approvalRequestId: run.approvalRequestId,
      resolvedBy: body.resolvedBy,
      note,
    },
  });

  const updated = await store.updateRun(run.id, {
    status: decision === "approved" ? "approval_approved" : "approval_rejected",
    approval: run.approval ? {
      ...run.approval,
      status: decision,
      resolvedAt: now,
      resolvedBy: body.resolvedBy,
      note,
    } : undefined,
    metadata: {
      ...run.metadata,
      approvalDecision: decision,
      approvalResolvedAt: now,
      ...(body.resolvedBy ? { approvalResolvedBy: body.resolvedBy } : {}),
    },
    completedAt: now,
  });

  return c.json({ ok: true, data: updated }, 200);
}
