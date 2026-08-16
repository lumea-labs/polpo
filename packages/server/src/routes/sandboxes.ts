import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import {
  SANDBOX_ACTIONS,
  SANDBOX_ALLOCATION_STATES,
  SANDBOX_HEALTH_STATES,
  SANDBOX_MANAGEMENT_ERROR_CODES,
  SANDBOX_OPERATIONAL_STATES,
  SandboxManagementError,
  isSandboxManagementError,
  type SandboxManagementContext,
  type SandboxManager,
  type SandboxMutationContext,
  type SandboxOperationalState,
} from "@polpo-ai/core";

export type SandboxRoutePermission = "read" | "control";

export interface SandboxManagementContextInput {
  readonly projectId: string;
  readonly permission: SandboxRoutePermission;
  readonly requestContext: unknown;
}

export interface SandboxManagementRouteDeps {
  readonly manager?: SandboxManager;
  readonly resolveContext?: (
    input: SandboxManagementContextInput,
  ) => SandboxManagementContext | Promise<SandboxManagementContext>;
  readonly createOperationId?: () => string;
}

interface ResolvedSandboxRouteContext {
  readonly ok: true;
  readonly deps: SandboxManagementRouteDeps;
  readonly manager: SandboxManager;
  readonly context: SandboxManagementContext;
}

interface FailedSandboxRouteContext {
  readonly ok: false;
  readonly response: any;
}

const identifierSchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), {
    message: "Leading or trailing whitespace is not allowed",
  })
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Control characters are not allowed",
  });
const projectParamsSchema = z.object({
  projectId: identifierSchema,
}).strict();
const sandboxParamsSchema = z.object({
  projectId: identifierSchema,
  sandboxId: identifierSchema,
}).strict();

const actionCapabilitySchema = z.object({
  allowed: z.boolean(),
  reason: z.string().max(128).optional(),
}).strict();

const capabilitiesSchema = z.object({
  inventory: z.boolean(),
  detail: z.boolean(),
  actions: z.object({
    start: actionCapabilitySchema,
    stop: actionCapabilitySchema,
    destroy: actionCapabilitySchema,
    clearIdle: actionCapabilitySchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (
    !value.inventory
    && Object.values(value.actions).some((capability) => capability.allowed)
  ) {
    context.addIssue({
      code: "custom",
      message: "Controls cannot be available without inventory",
      path: ["actions"],
    });
  }
});

const runReferenceSchema = z.object({
  runId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256).optional(),
  agentName: z.string().min(1).max(256).optional(),
  surface: z.string().min(1).max(64).optional(),
  acquiredAt: z.string().datetime().optional(),
}).strict();

const sandboxSummarySchema = z.object({
  id: identifierSchema,
  name: z.string().min(1).max(256).optional(),
  operationalState: z.enum(SANDBOX_OPERATIONAL_STATES),
  allocationState: z.enum(SANDBOX_ALLOCATION_STATES),
  health: z.enum(SANDBOX_HEALTH_STATES),
  providerState: z.string().max(128).optional(),
  healthReasons: z.array(z.string().min(1).max(128)).max(16).optional(),
  workspace: z.object({
    mode: z.enum(["local", "volume-backed"]),
    volumeCount: z.number().int().nonnegative().max(1_000),
    strategies: z.array(z.enum(["mounted", "hydrated"])).max(2).optional(),
  }).strict(),
  lifecycle: z.object({
    autoStopMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
    autoDeleteMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
  }).strict(),
  capacity: z.object({
    cpu: z.number().nonnegative().max(100_000).optional(),
    memoryGiB: z.number().nonnegative().max(1_000_000).optional(),
    diskGiB: z.number().nonnegative().max(1_000_000).optional(),
    gpu: z.number().nonnegative().max(100_000).optional(),
  }).strict().optional(),
  holderCount: z.number().int().nonnegative().max(100_000),
  currentRuns: z.array(runReferenceSchema).max(100).optional(),
  latestRun: runReferenceSchema.optional(),
  snapshot: z.object({
    id: z.string().min(1).max(256).optional(),
    compatible: z.boolean().optional(),
    reason: z.string().min(1).max(256).optional(),
  }).strict().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  acquiredAt: z.string().datetime().optional(),
  releasedAt: z.string().datetime().optional(),
  lastActivityAt: z.string().datetime().optional(),
  actions: z.object({
    start: actionCapabilitySchema,
    stop: actionCapabilitySchema,
    destroy: actionCapabilitySchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (
    value.allocationState !== "idle"
    && SANDBOX_ACTIONS.some((action) => value.actions[action].allowed)
  ) {
    context.addIssue({
      code: "custom",
      message: "Allocated sandboxes cannot expose lifecycle actions",
      path: ["actions"],
    });
  }
  if (value.allocationState === "idle" && value.holderCount !== 0) {
    context.addIssue({
      code: "custom",
      message: "Idle sandboxes cannot have holders",
      path: ["holderCount"],
    });
  }
  if (
    (value.allocationState === "leased" || value.allocationState === "shared")
    && value.holderCount === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Allocated sandboxes must have a holder",
      path: ["holderCount"],
    });
  }
  if (
    value.currentRuns !== undefined
    && value.currentRuns.length > value.holderCount
  ) {
    context.addIssue({
      code: "custom",
      message: "Current run references cannot exceed holder count",
      path: ["currentRuns"],
    });
  }
  if (value.actions.stop.allowed && value.operationalState !== "running") {
    context.addIssue({
      code: "custom",
      message: "Only running sandboxes can be stopped",
      path: ["actions", "stop"],
    });
  }
  if (
    value.actions.start.allowed
    && !["stopped", "archived", "error"].includes(value.operationalState)
  ) {
    context.addIssue({
      code: "custom",
      message: "Sandbox state cannot be started",
      path: ["actions", "start"],
    });
  }
});

const inventoryPageSchema = z.object({
  items: z.array(sandboxSummarySchema).max(100),
  nextCursor: z.string().min(1).max(2_048).nullable(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    operational: z.partialRecord(
      z.enum(SANDBOX_OPERATIONAL_STATES),
      z.number().int().nonnegative(),
    ),
    allocation: z.partialRecord(
      z.enum(SANDBOX_ALLOCATION_STATES),
      z.number().int().nonnegative(),
    ),
  }).strict(),
  observedAt: z.string().datetime(),
  sources: z.object({
    provider: z.enum(["available", "degraded", "unavailable"]),
    coordination: z.enum(["available", "degraded", "unavailable"]),
    enrichment: z.enum(["available", "degraded", "unavailable"]),
  }).strict(),
  capabilities: capabilitiesSchema,
}).strict().superRefine((value, context) => {
  if (!value.capabilities.inventory) {
    context.addIssue({
      code: "custom",
      message: "An inventory page requires inventory capability",
      path: ["capabilities", "inventory"],
    });
  }
  if (value.summary.total < value.items.length) {
    context.addIssue({
      code: "custom",
      message: "Inventory total cannot be smaller than the returned page",
      path: ["summary", "total"],
    });
  }
  const ids = new Set(value.items.map((item) => item.id));
  if (ids.size !== value.items.length) {
    context.addIssue({
      code: "custom",
      message: "Inventory pages cannot contain duplicate sandbox ids",
      path: ["items"],
    });
  }
  if (
    value.sources.coordination === "unavailable"
    && (
      Object.values(value.capabilities.actions).some((item) => item.allowed)
      || value.items.some((item) => (
        SANDBOX_ACTIONS.some((action) => item.actions[action].allowed)
      ))
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Controls require available coordination",
      path: ["sources", "coordination"],
    });
  }
});

const mutationResultSchema = z.object({
  sandboxId: identifierSchema,
  operationId: identifierSchema,
  outcome: z.enum(["applied", "already_satisfied"]),
  sandbox: sandboxSummarySchema.optional(),
}).strict();

const clearIdleResultSchema = z.object({
  operationId: identifierSchema,
  inspected: z.number().int().nonnegative(),
  destroyed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failures: z.array(z.object({
    sandboxId: identifierSchema,
    code: z.enum(SANDBOX_MANAGEMENT_ERROR_CODES),
  }).strict()).max(100),
}).strict();

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.enum(SANDBOX_MANAGEMENT_ERROR_CODES),
  retryable: z.boolean().optional(),
}).strict();

const success = <T extends z.ZodType>(schema: T) => z.object({
  ok: z.literal(true),
  data: schema,
}).strict();

const listQuerySchema = z.object({
  operationalState: z.string().max(256).optional(),
  allocationState: z.string().max(256).optional(),
  workspaceMode: z.string().max(128).optional(),
  search: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
}).strict();

const mutationBodySchema = z.object({
  operationId: identifierSchema.optional(),
  expectedState: z.enum(SANDBOX_OPERATIONAL_STATES).optional(),
}).strict();

const destroyQuerySchema = z.object({
  expectedState: z.enum(SANDBOX_OPERATIONAL_STATES).optional(),
}).strict();

const clearIdleBodySchema = z.object({
  operationId: identifierSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

const standardErrors = {
  400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid request" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Forbidden" },
  404: { content: { "application/json": { schema: errorSchema } }, description: "Sandbox not found" },
  409: { content: { "application/json": { schema: errorSchema } }, description: "Sandbox state conflict" },
  501: { content: { "application/json": { schema: errorSchema } }, description: "Management unavailable" },
  503: { content: { "application/json": { schema: errorSchema } }, description: "Provider or coordination unavailable" },
  504: { content: { "application/json": { schema: errorSchema } }, description: "Provider action timed out" },
  500: { content: { "application/json": { schema: errorSchema } }, description: "Sandbox management failed" },
} as const;

const capabilitiesRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/sandboxes/capabilities",
  tags: ["Sandboxes"],
  summary: "Get sandbox management capabilities",
  request: { params: projectParamsSchema },
  responses: {
    200: { content: { "application/json": { schema: success(capabilitiesSchema) } }, description: "Capabilities" },
    ...standardErrors,
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/sandboxes",
  tags: ["Sandboxes"],
  summary: "List current project sandboxes",
  request: { params: projectParamsSchema, query: listQuerySchema },
  responses: {
    200: { content: { "application/json": { schema: success(inventoryPageSchema) } }, description: "Sandbox inventory" },
    ...standardErrors,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/sandboxes/{sandboxId}",
  tags: ["Sandboxes"],
  summary: "Get one sandbox",
  request: { params: sandboxParamsSchema },
  responses: {
    200: { content: { "application/json": { schema: success(sandboxSummarySchema) } }, description: "Sandbox detail" },
    ...standardErrors,
  },
});

function actionRoute(action: "start" | "stop") {
  return createRoute({
    method: "post",
    path: `/projects/{projectId}/sandboxes/{sandboxId}/${action}`,
    tags: ["Sandboxes"],
    summary: `${action === "start" ? "Start" : "Stop"} one sandbox`,
    request: {
      params: sandboxParamsSchema,
      body: {
        required: false,
        content: { "application/json": { schema: mutationBodySchema } },
      },
    },
    responses: {
      200: { content: { "application/json": { schema: success(mutationResultSchema) } }, description: "Mutation result" },
      ...standardErrors,
    },
  });
}

const startRoute = actionRoute("start");
const stopRoute = actionRoute("stop");

const destroyRoute = createRoute({
  method: "delete",
  path: "/projects/{projectId}/sandboxes/{sandboxId}",
  tags: ["Sandboxes"],
  summary: "Destroy one idle sandbox",
  request: {
    params: sandboxParamsSchema,
    query: destroyQuerySchema,
    headers: z.object({
      "x-polpo-operation-id": identifierSchema.optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: success(mutationResultSchema) } }, description: "Mutation result" },
    ...standardErrors,
  },
});

const clearIdleRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/sandboxes/clear-idle",
  tags: ["Sandboxes"],
  summary: "Destroy a bounded batch of idle retained sandboxes",
  request: {
    params: projectParamsSchema,
    body: {
      required: false,
      content: { "application/json": { schema: clearIdleBodySchema } },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: success(clearIdleResultSchema) } }, description: "Clear idle result" },
    ...standardErrors,
  },
});

const listQueryKeys = new Set([
  "operationalState",
  "allocationState",
  "workspaceMode",
  "search",
  "limit",
  "cursor",
]);
const destroyQueryKeys = new Set(["expectedState"]);

const publicMessages: Record<
  (typeof SANDBOX_MANAGEMENT_ERROR_CODES)[number],
  string
> = {
  SANDBOX_MANAGEMENT_UNAVAILABLE: "Sandbox management is not available",
  SANDBOX_INVALID_REQUEST: "Invalid sandbox management request",
  SANDBOX_INVALID_RESPONSE: "The sandbox provider returned an invalid response",
  SANDBOX_FORBIDDEN: "Sandbox access is not allowed for this project",
  SANDBOX_NOT_FOUND: "Sandbox not found",
  SANDBOX_BUSY: "Sandbox is currently in use",
  SANDBOX_STATE_CONFLICT: "Sandbox state changed before the operation completed",
  SANDBOX_PROVIDER_UNAVAILABLE: "The sandbox provider is unavailable",
  SANDBOX_COORDINATION_UNAVAILABLE: "Sandbox coordination is unavailable",
  SANDBOX_ACTION_TIMEOUT: "The sandbox operation timed out",
  SANDBOX_ACTION_UNSUPPORTED: "The sandbox operation is not supported",
  SANDBOX_INTERNAL_ERROR: "Sandbox management failed",
};

const statusByCode: Record<
  (typeof SANDBOX_MANAGEMENT_ERROR_CODES)[number],
  400 | 403 | 404 | 409 | 500 | 501 | 503 | 504
> = {
  SANDBOX_MANAGEMENT_UNAVAILABLE: 501,
  SANDBOX_INVALID_REQUEST: 400,
  SANDBOX_INVALID_RESPONSE: 500,
  SANDBOX_FORBIDDEN: 403,
  SANDBOX_NOT_FOUND: 404,
  SANDBOX_BUSY: 409,
  SANDBOX_STATE_CONFLICT: 409,
  SANDBOX_PROVIDER_UNAVAILABLE: 503,
  SANDBOX_COORDINATION_UNAVAILABLE: 503,
  SANDBOX_ACTION_TIMEOUT: 504,
  SANDBOX_ACTION_UNSUPPORTED: 409,
  SANDBOX_INTERNAL_ERROR: 500,
};

export function sandboxManagementRoutes(
  getDeps: (requestContext: unknown) => SandboxManagementRouteDeps,
): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, context) => {
      if (!result.success) {
        return errorResponse(
          context,
          new SandboxManagementError(
            "SANDBOX_INVALID_REQUEST",
            "Invalid request",
          ),
        );
      }
    },
  });

  app.openapi(capabilitiesRoute, async (context: any) => {
    const resolved = await resolve(
      context,
      getDeps,
      context.req.valid("param").projectId,
      "read",
    );
    if (!resolved.ok) return resolved.response;
    try {
      return validData(
        context,
        capabilitiesSchema,
        await resolved.manager.capabilities(resolved.context),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.openapi(listRoute, async (context: any) => {
    const invalidKeys = invalidQueryKeys(context.req.url, listQueryKeys);
    if (invalidKeys.length > 0) {
      return errorResponse(context, new SandboxManagementError(
        "SANDBOX_INVALID_REQUEST",
        "Unknown query field",
      ));
    }
    const resolved = await resolve(
      context,
      getDeps,
      context.req.valid("param").projectId,
      "read",
    );
    if (!resolved.ok) return resolved.response;
    try {
      const query = context.req.valid("query") as z.infer<typeof listQuerySchema>;
      const data = await resolved.manager.list(resolved.context, {
        operationalStates: commaEnum(
          query.operationalState,
          SANDBOX_OPERATIONAL_STATES,
        ),
        allocationStates: commaEnum(
          query.allocationState,
          SANDBOX_ALLOCATION_STATES,
        ),
        workspaceModes: commaEnum(
          query.workspaceMode,
          ["local", "volume-backed"] as const,
        ),
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return validData(context, inventoryPageSchema, data);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.openapi(getRoute, async (context: any) => {
    const params = context.req.valid("param") as z.infer<typeof sandboxParamsSchema>;
    const resolved = await resolve(context, getDeps, params.projectId, "read");
    if (!resolved.ok) return resolved.response;
    try {
      const data = await resolved.manager.get(resolved.context, params.sandboxId);
      if (!data) {
        throw new SandboxManagementError("SANDBOX_NOT_FOUND", "Not found");
      }
      return validData(context, sandboxSummarySchema, data);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.openapi(startRoute, async (context: any) => runMutation(
    context,
    getDeps,
    "start",
  ));
  app.openapi(stopRoute, async (context: any) => runMutation(
    context,
    getDeps,
    "stop",
  ));

  app.openapi(destroyRoute, async (context: any) => {
    if (invalidQueryKeys(context.req.url, destroyQueryKeys).length > 0) {
      return errorResponse(context, new SandboxManagementError(
        "SANDBOX_INVALID_REQUEST",
        "Invalid destroy query",
      ));
    }
    const params = context.req.valid("param") as z.infer<typeof sandboxParamsSchema>;
    const query = context.req.valid("query") as z.infer<typeof destroyQuerySchema>;
    const headers = context.req.valid("header") as {
      "x-polpo-operation-id"?: string;
    };
    const resolved = await resolve(context, getDeps, params.projectId, "control");
    if (!resolved.ok) return resolved.response;
    try {
      const mutation: SandboxMutationContext = {
        ...resolved.context,
        sandboxId: params.sandboxId,
        operationId: headers["x-polpo-operation-id"]
          ?? operationId(resolved.deps),
        ...(query.expectedState === undefined
          ? {}
          : { expectedState: query.expectedState }),
        signal: context.req.raw.signal,
      };
      return validData(
        context,
        mutationResultSchema,
        await resolved.manager.destroy(mutation),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.openapi(clearIdleRoute, async (context: any) => {
    const params = context.req.valid("param") as z.infer<typeof projectParamsSchema>;
    const body = (context.req.valid("json") ?? {}) as z.infer<
      typeof clearIdleBodySchema
    >;
    const resolved = await resolve(context, getDeps, params.projectId, "control");
    if (!resolved.ok) return resolved.response;
    try {
      return validData(
        context,
        clearIdleResultSchema,
        await resolved.manager.clearIdle({
          ...resolved.context,
          operationId: body.operationId ?? operationId(resolved.deps),
          ...(body.limit === undefined ? {} : { limit: body.limit }),
          signal: context.req.raw.signal,
        }),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return app;
}

async function runMutation(
  context: any,
  getDeps: (requestContext: unknown) => SandboxManagementRouteDeps,
  action: "start" | "stop",
) {
  const params = context.req.valid("param") as z.infer<typeof sandboxParamsSchema>;
  const body = (context.req.valid("json") ?? {}) as z.infer<
    typeof mutationBodySchema
  >;
  const resolved = await resolve(context, getDeps, params.projectId, "control");
  if (!resolved.ok) return resolved.response;
  try {
    const mutation: SandboxMutationContext = {
      ...resolved.context,
      sandboxId: params.sandboxId,
      operationId: body.operationId ?? operationId(resolved.deps),
      ...(body.expectedState === undefined
        ? {}
        : { expectedState: body.expectedState }),
      signal: context.req.raw.signal,
    };
    return validData(
      context,
      mutationResultSchema,
      await resolved.manager[action](mutation),
    );
  } catch (error) {
    return errorResponse(context, error);
  }
}

async function resolve(
  requestContext: any,
  getDeps: (requestContext: unknown) => SandboxManagementRouteDeps,
  projectId: string,
  permission: SandboxRoutePermission,
): Promise<ResolvedSandboxRouteContext | FailedSandboxRouteContext> {
  try {
    const deps = getDeps(requestContext);
    if (!deps.manager || !deps.resolveContext) {
      return {
        ok: false,
        response: errorResponse(requestContext, new SandboxManagementError(
          "SANDBOX_MANAGEMENT_UNAVAILABLE",
          "Unavailable",
        )),
      };
    }
    const context = await deps.resolveContext({
      projectId,
      permission,
      requestContext,
    });
    if (context.projectId !== projectId) {
      return {
        ok: false,
        response: errorResponse(requestContext, new SandboxManagementError(
          "SANDBOX_FORBIDDEN",
          "Project context mismatch",
        )),
      };
    }
    return { ok: true, deps, manager: deps.manager, context };
  } catch (error) {
    return { ok: false, response: errorResponse(requestContext, error) };
  }
}

function operationId(deps: SandboxManagementRouteDeps): string {
  return deps.createOperationId?.() ?? `sandbox-op-${nanoid(16)}`;
}

function commaEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw.split(",").map((value) => value.trim());
  const set = new Set<string>(allowed);
  if (
    values.length === 0
    || values.some((value) => value.length === 0 || !set.has(value))
  ) {
    throw new SandboxManagementError(
      "SANDBOX_INVALID_REQUEST",
      "Invalid enum filter",
    );
  }
  return [...new Set(values)] as T[];
}

function invalidQueryKeys(url: string, allowed: ReadonlySet<string>): string[] {
  const keys = [...new URL(url).searchParams.keys()];
  const seen = new Set<string>();
  return keys.filter((key) => {
    if (!allowed.has(key) || seen.has(key)) return true;
    seen.add(key);
    return false;
  });
}

function validData(
  context: any,
  schema: z.ZodType,
  data: unknown,
) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return errorResponse(context, new SandboxManagementError(
      "SANDBOX_INVALID_RESPONSE",
      "Invalid adapter response",
    ));
  }
  return context.json({ ok: true, data: parsed.data }, 200);
}

function errorResponse(context: any, value: unknown) {
  const error = isSandboxManagementError(value)
    ? value
    : new SandboxManagementError(
      "SANDBOX_INTERNAL_ERROR",
      "Internal sandbox management error",
      { cause: value },
    );
  return context.json({
    ok: false,
    error: publicMessages[error.code],
    code: error.code,
    ...(error.retryable ? { retryable: true } : {}),
  }, statusByCode[error.code]);
}
