import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import type { LoopApprovalSnapshot, LoopApprovedGate, ProjectLoopRunStatus, LoopRunStore } from "@polpo-ai/core/loop-run-store";

export interface LoopRunRouteDeps {
  loopRunStore?: LoopRunStore;
  approvalStore?: ApprovalStore;
  resumeLoopRun?: (id: string, opts?: { resolvedBy?: string }) => Promise<unknown>;
}

const statusSchema = z.enum(["running", "completed", "failed", "awaiting_approval", "approval_approved", "approval_rejected", "resuming", "cancelled"]);
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

  app.openapi(
    createRoute({
      method: "post",
      path: "/:id/resume",
      tags: ["Loop Runs"],
      summary: "Resume an approved loop run from its approval checkpoint",
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: { content: { "application/json": { schema: resolveApprovalBodySchema } }, required: false },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Loop run resumed" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run cannot be resumed" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Loop run not found" },
        501: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Resume handler unavailable" },
      },
    }),
    async (c: any) => {
      const deps = getDeps();
      if (!deps.loopRunStore) return c.json({ ok: false as const, error: "Loop run store is not configured", code: "LOOP_RUN_STORE_UNAVAILABLE" }, 501);
      if (!deps.resumeLoopRun) return c.json({ ok: false as const, error: "Loop resume handler is not configured", code: "LOOP_RESUME_UNAVAILABLE" }, 501);
      const run = await deps.loopRunStore.getRun(c.req.param("id"));
      if (!run) return c.json({ ok: false as const, error: "Loop run not found", code: "NOT_FOUND" }, 404);
      if (run.status !== "approval_approved") {
        return c.json({ ok: false as const, error: `Loop run is ${run.status}, not approval_approved`, code: "NOT_APPROVED" }, 400);
      }
      const body = await c.req.json().catch(() => ({}));
      try {
        const data = await deps.resumeLoopRun(run.id, { resolvedBy: body.resolvedBy });
        return c.json({ ok: true, data }, 200);
      } catch (err) {
        return c.json({ ok: false as const, error: err instanceof Error ? err.message : String(err), code: "RESUME_FAILED" }, 400);
      }
    },
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

  const approvedGate = decision === "approved" ? approvalSnapshotToGate(run.approval, run.approvalRequestId, now, body.resolvedBy) : undefined;
  const resume = run.resume && approvedGate
    ? {
        ...run.resume,
        approvedGates: [
          ...(run.resume.approvedGates ?? []).filter((gate) => !(gate.type === approvedGate.type && gate.id === approvedGate.id && gate.hook === approvedGate.hook)),
          approvedGate,
        ],
        updatedAt: now,
      }
    : run.resume;

  const updated = await store.updateRun(run.id, {
    status: decision === "approved" ? "approval_approved" : "approval_rejected",
    approval: run.approval ? {
      ...run.approval,
      status: decision,
      resolvedAt: now,
      resolvedBy: body.resolvedBy,
      note,
    } : undefined,
    resume,
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

function approvalSnapshotToGate(
  approval: LoopApprovalSnapshot | undefined,
  approvalRequestId: string | undefined,
  resolvedAt: string,
  resolvedBy: string | undefined,
): LoopApprovedGate | undefined {
  if (!approval) return undefined;
  return {
    type: approval.type ?? "policy",
    id: approval.type === "permission" ? approval.permissionId ?? "anonymous" : approval.policyId,
    hook: approval.hook,
    approvalRequestId,
    resolvedAt,
    resolvedBy,
  };
}
