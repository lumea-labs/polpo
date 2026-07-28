import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ScheduleConflictError,
  ScheduleInvalidStateError,
  ScheduleNotFoundError,
  translateLegacyMissionSchedule,
  type Schedule,
  type CreateScheduleInput,
  type ScheduleFilter,
  type ScheduleMetadata,
  type ScheduleRunFilter,
  type UpdateScheduleInput,
} from "@polpo-ai/core/scheduling";
import type { ScheduleRouteDeps } from "../deps.js";
import {
  ScheduleServiceError,
  type ScheduleService,
} from "../services/schedules.js";

const MetadataSchema = z.record(z.string(), z.unknown());
const TimingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    expression: z.string().min(1),
    timezone: z.string().min(1),
  }).passthrough(),
  z.object({
    kind: z.literal("once"),
    at: z.string().min(1),
    timezone: z.string().min(1),
  }).passthrough(),
]);
const InvocationSchema = z.discriminatedUnion("surface", [
  z.object({ surface: z.literal("agent") }).passthrough(),
  z.object({ surface: z.literal("task") }).passthrough(),
  z.object({ surface: z.literal("channel") }).passthrough(),
  z.object({ surface: z.literal("webhook") }).passthrough(),
  z.object({ surface: z.literal("legacy_mission") }).passthrough(),
]);
const PolicySchema = z.object({
  catchUp: z.enum(["skip", "latest"]).optional(),
  misfireGraceSeconds: z.number().int().nonnegative().optional(),
  maxConcurrency: z.number().int().positive().optional(),
}).passthrough();

const V2CreateScheduleSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  timing: TimingSchema,
  invocation: InvocationSchema,
  status: z.enum(["active", "paused"]).optional(),
  policy: PolicySchema.optional(),
  metadata: MetadataSchema.optional(),
}).passthrough();

const LegacyCreateScheduleSchema = z.object({
  missionId: z.string().min(1),
  expression: z.string().min(1),
  recurring: z.boolean().optional(),
  endDate: z.string().datetime().optional(),
}).strict();

const V2UpdateScheduleSchema = z.object({
  name: z.string().min(1).nullable().optional(),
  description: z.string().min(1).nullable().optional(),
  timing: TimingSchema.optional(),
  invocation: InvocationSchema.optional(),
  status: z.enum(["active", "paused", "completed"]).optional(),
  policy: PolicySchema.optional(),
  metadata: MetadataSchema.optional(),
}).passthrough();

const LegacyUpdateScheduleSchema = z.object({
  expression: z.string().min(1).optional(),
  recurring: z.boolean().optional(),
  enabled: z.boolean().optional(),
  endDate: z.string().datetime().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Schedule update must include at least one field",
});

const ScheduleIdParams = z.object({ scheduleId: z.string().min(1) });
const RevisionHeaders = z.object({ "if-match": z.string().optional() });
const SuccessSchema = z.object({ ok: z.literal(true), data: z.any() });
const ErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string(),
  retryable: z.boolean().optional(),
});

const commonErrors = {
  400: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Invalid request",
  },
  404: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Schedule not found",
  },
  409: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Schedule conflict",
  },
  500: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Schedule operation failed",
  },
  503: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Schedule service unavailable",
  },
} as const;

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Schedules"],
  summary: "List schedules",
  request: {
    query: z.object({
      status: z.enum(["active", "paused", "completed", "deleted"]).optional(),
      surface: z.enum([
        "agent",
        "task",
        "channel",
        "webhook",
        "legacy_mission",
      ]).optional(),
      includeDeleted: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Schedules",
    },
    ...commonErrors,
  },
});

const createRouteDefinition = createRoute({
  method: "post",
  path: "/",
  tags: ["Schedules"],
  summary: "Create a schedule",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.union([
            V2CreateScheduleSchema,
            LegacyCreateScheduleSchema,
          ]),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Schedule created",
    },
    ...commonErrors,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{scheduleId}",
  tags: ["Schedules"],
  summary: "Get a schedule",
  request: { params: ScheduleIdParams },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Schedule",
    },
    ...commonErrors,
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/{scheduleId}",
  tags: ["Schedules"],
  summary: "Update a schedule",
  request: {
    params: ScheduleIdParams,
    headers: RevisionHeaders,
    body: {
      content: {
        "application/json": {
          schema: z.union([
            LegacyUpdateScheduleSchema,
            V2UpdateScheduleSchema,
          ]),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Schedule updated",
    },
    ...commonErrors,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{scheduleId}",
  tags: ["Schedules"],
  summary: "Delete a schedule",
  request: { params: ScheduleIdParams, headers: RevisionHeaders },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Schedule deleted",
    },
    ...commonErrors,
  },
});

const lifecycleRoute = (action: "pause" | "resume") => createRoute({
  method: "post",
  path: `/{scheduleId}/${action}` as const,
  tags: ["Schedules"],
  summary: `${action === "pause" ? "Pause" : "Resume"} a schedule`,
  request: { params: ScheduleIdParams, headers: RevisionHeaders },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: `Schedule ${action}d`,
    },
    ...commonErrors,
  },
});

const pauseRoute = lifecycleRoute("pause");
const resumeRoute = lifecycleRoute("resume");

const listRunsRoute = createRoute({
  method: "get",
  path: "/{scheduleId}/runs",
  tags: ["Schedules"],
  summary: "List schedule runs",
  request: {
    params: ScheduleIdParams,
    query: z.object({
      status: z.enum([
        "pending",
        "claimed",
        "running",
        "succeeded",
        "failed",
        "skipped",
        "cancelled",
      ]).optional(),
      limit: z.string().regex(/^\d+$/).refine(
        (value) => Number(value) >= 1 && Number(value) <= 1_000,
        "Run history limit must be between 1 and 1000",
      ).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Schedule runs",
    },
    ...commonErrors,
  },
});

const triggerRoute = createRoute({
  method: "post",
  path: "/{scheduleId}/runs",
  tags: ["Schedules"],
  summary: "Create an idempotent manual schedule run",
  request: {
    params: ScheduleIdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            idempotencyKey: z.string().min(1),
          }).strict(),
        },
      },
    },
  },
  responses: {
    202: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Run accepted",
    },
    ...commonErrors,
  },
});

export function scheduleRoutes(
  getDeps: () => ScheduleRouteDeps,
): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(listRoute, async (c): Promise<any> => {
    const deps = getDeps();
    if (!deps.scheduleService) return legacyList(c, deps);
    try {
      const query = c.req.valid("query");
      const filter: ScheduleFilter = {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.surface === undefined ? {} : { surface: query.surface }),
        includeDeleted: query.includeDeleted === "true",
      };
      const schedules = await deps.scheduleService.list(filter);
      return c.json({
        ok: true,
        data: schedules.map(withLegacyCompatibility),
      }, 200);
    } catch (error) {
      return scheduleError(c, error);
    }
  });

  app.openapi(createRouteDefinition, async (c): Promise<any> => {
    const deps = getDeps();
    const body = c.req.valid("json");
    if (isLegacyCreate(body)) {
      if (!deps.scheduleService) return legacyCreate(c, deps, body);
      try {
        const mission = await deps.getMission?.(body.missionId);
        if (!mission) throw new ScheduleNotFoundError("Schedule", body.missionId);
        const translated = translateLegacyRequest(body);
        const created = await deps.scheduleService.create({
          ...translated,
          id: legacyScheduleId(body.missionId),
        });
        await deps.updateMission?.(body.missionId, {
          schedule: body.expression,
          status: body.recurring ? "recurring" : "scheduled",
          ...(body.endDate === undefined ? {} : { endDate: body.endDate }),
        });
        return c.json({
          ok: true,
          data: withLegacyCompatibility(created),
        }, 201);
      } catch (error) {
        return scheduleError(c, error);
      }
    }

    const service = deps.scheduleService;
    if (!service) return unavailable(c);
    try {
      const created = await service.create(body as unknown as CreateScheduleInput);
      return c.json({ ok: true, data: created }, 201);
    } catch (error) {
      return scheduleError(c, error);
    }
  });

  app.openapi(getRoute, async (c): Promise<any> => {
    const deps = getDeps();
    const service = deps.scheduleService;
    if (!service) return unavailable(c);
    try {
      const schedule = await resolveSchedule(
        service,
        c.req.valid("param").scheduleId,
      );
      return c.json({
        ok: true,
        data: withLegacyCompatibility(schedule),
      }, 200);
    } catch (error) {
      return scheduleError(c, error);
    }
  });

  app.openapi(updateRoute, async (c): Promise<any> => {
    const deps = getDeps();
    const body = c.req.valid("json");
    const { scheduleId } = c.req.valid("param");
    if (!deps.scheduleService) {
      if (isLegacyUpdate(body)) return legacyUpdate(c, deps, scheduleId, body);
      return unavailable(c);
    }

    try {
      const expectedRevision = parseRevision(c.req.header("if-match"));
      if (isLegacyUpdate(body)) {
        const existing = await resolveSchedule(deps.scheduleService, scheduleId);
        if (existing.invocation.surface !== "legacy_mission") {
          throw new ScheduleServiceError(
            "INVALID_REQUEST",
            `Schedule "${scheduleId}" is not a legacy mission schedule`,
            false,
          );
        }
        const missionId = existing.invocation.missionId;
        const patch = legacyUpdatePatch(existing, body);
        const updated = await deps.scheduleService.update(
          existing.id,
          patch,
          expectedRevision === undefined ? {} : { expectedRevision },
        );
        await deps.updateMission?.(missionId, legacyMissionPatch(existing, body));
        return c.json({
          ok: true,
          data: withLegacyCompatibility(updated),
        }, 200);
      }

      const updated = await deps.scheduleService.update(
        scheduleId,
        body as unknown as UpdateScheduleInput,
        expectedRevision === undefined ? {} : { expectedRevision },
      );
      return c.json({ ok: true, data: updated }, 200);
    } catch (error) {
      return scheduleError(c, error);
    }
  });

  app.openapi(deleteRoute, async (c): Promise<any> => {
    const deps = getDeps();
    const { scheduleId } = c.req.valid("param");
    if (!deps.scheduleService) return legacyDelete(c, deps, scheduleId);
    try {
      const expectedRevision = parseRevision(c.req.header("if-match"));
      const existing = await resolveSchedule(deps.scheduleService, scheduleId);
      const deleted = await deps.scheduleService.delete(
        existing.id,
        expectedRevision === undefined ? {} : { expectedRevision },
      );
      if (existing.invocation.surface === "legacy_mission") {
        await deps.updateMission?.(existing.invocation.missionId, {
          schedule: undefined,
          status: "draft",
        });
        return c.json({
          ok: true,
          data: { deleted: true, schedule: withLegacyCompatibility(deleted) },
        }, 200);
      }
      return c.json({ ok: true, data: deleted }, 200);
    } catch (error) {
      return scheduleError(c, error);
    }
  });

  app.openapi(pauseRoute, async (c): Promise<any> => {
    const service = getDeps().scheduleService;
    if (!service) return unavailable(c);
    try {
      const expectedRevision = parseRevision(c.req.header("if-match"));
      const paused = await service.pause(
        c.req.valid("param").scheduleId,
        expectedRevision === undefined ? {} : { expectedRevision },
      );
      return c.json({ ok: true, data: paused }, 200);
    } catch (error) {
      return scheduleError(c, error);
    }
  });

  app.openapi(resumeRoute, async (c): Promise<any> => {
    const service = getDeps().scheduleService;
    if (!service) return unavailable(c);
    try {
      const expectedRevision = parseRevision(c.req.header("if-match"));
      const resumed = await service.resume(
        c.req.valid("param").scheduleId,
        expectedRevision === undefined ? {} : { expectedRevision },
      );
      return c.json({ ok: true, data: resumed }, 200);
    } catch (error) {
      return scheduleError(c, error);
    }
  });

  app.openapi(listRunsRoute, async (c): Promise<any> => {
    const service = getDeps().scheduleService;
    if (!service) return unavailable(c);
    try {
      const query = c.req.valid("query");
      const filter: Omit<ScheduleRunFilter, "scheduleId"> = {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        ...(query.order === undefined ? {} : { order: query.order }),
      };
      const runs = await service.listRuns(
        c.req.valid("param").scheduleId,
        filter,
      );
      return c.json({ ok: true, data: runs }, 200);
    } catch (error) {
      return scheduleError(c, error);
    }
  });

  app.openapi(triggerRoute, async (c): Promise<any> => {
    const service = getDeps().scheduleService;
    if (!service) return unavailable(c);
    try {
      const run = await service.trigger(
        c.req.valid("param").scheduleId,
        c.req.valid("json"),
      );
      return c.json({ ok: true, data: run }, 202);
    } catch (error) {
      return scheduleError(c, error);
    }
  });

  return app;
}

function isLegacyCreate(
  body: z.infer<typeof V2CreateScheduleSchema>
    | z.infer<typeof LegacyCreateScheduleSchema>,
): body is z.infer<typeof LegacyCreateScheduleSchema> {
  return "missionId" in body;
}

function isLegacyUpdate(
  body: z.infer<typeof V2UpdateScheduleSchema>
    | z.infer<typeof LegacyUpdateScheduleSchema>,
): body is z.infer<typeof LegacyUpdateScheduleSchema> {
  return ["expression", "recurring", "enabled", "endDate"]
    .some((key) => key in body);
}

async function resolveSchedule(
  service: ScheduleService,
  idOrMissionId: string,
): Promise<Schedule> {
  try {
    return await service.get(idOrMissionId);
  } catch (error) {
    if (!(error instanceof ScheduleNotFoundError)) throw error;
  }
  const legacy = (await service.list({ surface: "legacy_mission" }))
    .find((schedule) =>
      schedule.invocation.surface === "legacy_mission"
      && schedule.invocation.missionId === idOrMissionId
    );
  if (!legacy) throw new ScheduleNotFoundError("Schedule", idOrMissionId);
  return legacy;
}

function withLegacyCompatibility(
  schedule: Schedule,
): Schedule | Record<string, unknown> {
  if (schedule.invocation.surface !== "legacy_mission") return schedule;
  const compatibility = compatibilityMetadata(schedule);
  return {
    ...schedule,
    missionId: schedule.invocation.missionId,
    expression: timingExpression(schedule),
    recurring: compatibility.recurring === true,
    enabled: schedule.status === "active",
    ...(schedule.nextOccurrenceAt === undefined
      ? {}
      : { nextRunAt: schedule.nextOccurrenceAt }),
    ...(schedule.lastOccurrenceAt === undefined
      ? {}
      : { lastRunAt: schedule.lastOccurrenceAt }),
  };
}

function legacyUpdatePatch(
  existing: Schedule,
  body: z.infer<typeof LegacyUpdateScheduleSchema>,
): UpdateScheduleInput {
  if (existing.invocation.surface !== "legacy_mission") {
    throw new ScheduleServiceError(
      "INVALID_REQUEST",
      "Legacy update requires a legacy mission invocation",
      false,
    );
  }
  const missionId = existing.invocation.missionId;
  const currentCompatibility = compatibilityMetadata(existing);
  const expression = body.expression ?? timingExpression(existing);
  const recurring = body.recurring
    ?? (currentCompatibility.recurring === true);
  const endDate = body.endDate === undefined
    ? stringValue(currentCompatibility.endDate)
    : body.endDate ?? undefined;
  const translated = translateLegacyRequest({
    missionId,
    expression,
    recurring,
    ...(endDate === undefined ? {} : { endDate }),
  }, { allowPastOnce: true });
  return {
    ...(body.expression === undefined && body.recurring === undefined
      ? {}
      : { timing: translated.timing }),
    invocation: translated.invocation,
    metadata: {
      ...existing.metadata,
      ...translated.metadata,
    },
    ...(body.enabled === undefined
      ? {}
      : { status: body.enabled ? "active" : "paused" }),
  };
}

function legacyMissionPatch(
  existing: Schedule,
  body: z.infer<typeof LegacyUpdateScheduleSchema>,
): Record<string, unknown> {
  const currentCompatibility = compatibilityMetadata(existing);
  const recurring = body.recurring
    ?? (currentCompatibility.recurring === true);
  return {
    ...(body.expression === undefined ? {} : { schedule: body.expression }),
    ...(body.expression === undefined && body.recurring === undefined
      ? {}
      : { status: recurring ? "recurring" : "scheduled" }),
    ...(body.endDate === undefined
      ? {}
      : { endDate: body.endDate ?? undefined }),
  };
}

function compatibilityMetadata(
  schedule: Schedule,
): Record<string, unknown> {
  const value = schedule.metadata.compatibility;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function timingExpression(schedule: Schedule): string {
  return schedule.timing.kind === "cron"
    ? schedule.timing.expression
    : schedule.timing.at;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function legacyScheduleId(missionId: string): string {
  return `legacy-mission:${missionId}`;
}

function parseRevision(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new ScheduleServiceError(
      "INVALID_REQUEST",
      "If-Match must contain a positive schedule revision",
      false,
    );
  }
  const revision = Number(normalized);
  if (!Number.isSafeInteger(revision)) {
    throw new ScheduleServiceError(
      "INVALID_REQUEST",
      "If-Match must contain a safe positive schedule revision",
      false,
    );
  }
  return revision;
}

function unavailable(c: any): any {
  return c.json({
    ok: false,
    error: "Schedule service is not enabled on this host",
    code: "SCHEDULE_SERVICE_UNAVAILABLE",
  }, 503);
}

function scheduleError(c: any, error: unknown): any {
  if (
    error instanceof ScheduleNotFoundError
    || (error instanceof ScheduleServiceError && error.code === "NOT_FOUND")
  ) {
    return c.json({
      ok: false,
      error: error.message,
      code: "NOT_FOUND",
      retryable: false,
    }, 404);
  }
  if (error instanceof ScheduleConflictError) {
    return c.json({
      ok: false,
      error: error.message,
      code: "CONFLICT",
      retryable: false,
    }, 409);
  }
  if (
    error instanceof ScheduleInvalidStateError
    || (error instanceof ScheduleServiceError && error.code === "INVALID_STATE")
  ) {
    return c.json({
      ok: false,
      error: error.message,
      code: "INVALID_STATE",
      retryable: false,
    }, 409);
  }
  if (error instanceof ScheduleServiceError) {
    return c.json({
      ok: false,
      error: error.message,
      code: error.code,
      retryable: error.retryable,
    }, 400);
  }
  return c.json({
    ok: false,
    error: "Schedule operation failed",
    code: "SCHEDULE_OPERATION_FAILED",
  }, 500);
}

function translateLegacyRequest(
  value: unknown,
  options: Parameters<typeof translateLegacyMissionSchedule>[1] = {},
) {
  try {
    return translateLegacyMissionSchedule(value, options);
  } catch (cause) {
    throw new ScheduleServiceError(
      "INVALID_REQUEST",
      cause instanceof Error ? cause.message : "Invalid legacy schedule request",
      false,
      { cause },
    );
  }
}

async function legacyList(c: any, deps: ScheduleRouteDeps): Promise<any> {
  const schedules = deps.getScheduler?.()?.getAllSchedules() ?? [];
  return c.json({ ok: true, data: schedules }, 200);
}

async function legacyCreate(
  c: any,
  deps: ScheduleRouteDeps,
  body: z.infer<typeof LegacyCreateScheduleSchema>,
): Promise<any> {
  const scheduler = deps.getScheduler?.();
  if (!scheduler) return unavailable(c);
  const mission = await deps.getMission?.(body.missionId);
  if (!mission) {
    return c.json({
      ok: false,
      error: `Mission "${body.missionId}" not found`,
      code: "NOT_FOUND",
    }, 404);
  }
  const updatedMission = await deps.updateMission?.(body.missionId, {
    schedule: body.expression,
    status: body.recurring ? "recurring" : "scheduled",
    ...(body.endDate === undefined ? {} : { endDate: body.endDate }),
  });
  const entry = scheduler.registerMission(updatedMission);
  if (!entry) {
    return c.json({
      ok: false,
      error: "Could not create schedule",
      code: "INVALID_EXPRESSION",
    }, 400);
  }
  return c.json({ ok: true, data: entry }, 201);
}

async function legacyUpdate(
  c: any,
  deps: ScheduleRouteDeps,
  missionId: string,
  body: z.infer<typeof LegacyUpdateScheduleSchema>,
): Promise<any> {
  const scheduler = deps.getScheduler?.();
  if (!scheduler) return unavailable(c);
  const existing = scheduler.getScheduleByMissionId(missionId);
  if (!existing) {
    return c.json({
      ok: false,
      error: `No schedule found for mission "${missionId}"`,
      code: "NOT_FOUND",
    }, 404);
  }
  if (body.expression !== undefined || body.recurring !== undefined) {
    const mission = await deps.getMission?.(missionId);
    if (!mission) {
      return c.json({
        ok: false,
        error: `Mission "${missionId}" not found`,
        code: "NOT_FOUND",
      }, 404);
    }
    const recurring = body.recurring ?? existing.recurring;
    const updated = await deps.updateMission?.(missionId, {
      schedule: body.expression ?? existing.expression,
      status: recurring ? "recurring" : "scheduled",
    });
    scheduler.unregisterMission(missionId);
    scheduler.registerMission(updated);
  }
  if (body.enabled !== undefined) existing.enabled = body.enabled;
  if (body.endDate !== undefined) {
    await deps.updateMission?.(missionId, {
      endDate: body.endDate ?? undefined,
    });
  }
  return c.json({
    ok: true,
    data: scheduler.getScheduleByMissionId(missionId),
  }, 200);
}

async function legacyDelete(
  c: any,
  deps: ScheduleRouteDeps,
  missionId: string,
): Promise<any> {
  const scheduler = deps.getScheduler?.();
  if (!scheduler) return unavailable(c);
  if (!scheduler.unregisterMission(missionId)) {
    return c.json({
      ok: false,
      error: `No schedule found for mission "${missionId}"`,
      code: "NOT_FOUND",
    }, 404);
  }
  await deps.updateMission?.(missionId, {
    schedule: undefined,
    status: "draft",
  });
  return c.json({ ok: true, data: { deleted: true } }, 200);
}
