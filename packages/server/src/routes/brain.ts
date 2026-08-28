import {
  OpenAPIHono,
  createRoute,
  z,
} from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  BRAIN_SOURCE_STATUSES,
  BRAIN_SOURCE_TYPES,
  BRAIN_TRUST_LEVELS,
  BrainContractError,
  BrainIngestionError,
  BrainStoreAuthorizationError,
  BrainStoreConflictError,
  BrainStoreValidationError,
  normalizeBrainScope,
  type BrainManagementService,
  type BrainScope,
  type BrainServiceContext,
} from "@polpo-ai/core/brain";

const ScopeSchema = z.object({
  kind: z.enum(["org", "project"]),
  subjectId: z.string().trim().min(1).max(512),
}).strict();

const PasteContentSchema = z.object({
  kind: z.literal("paste"),
  text: z.string().min(1),
  contentType: z.string().trim().min(1).max(256).optional(),
}).strict();
const FileContentSchema = z.object({
  kind: z.literal("file"),
  path: z.string().trim().min(1).max(8_192),
}).strict();
const UrlContentSchema = z.object({
  kind: z.literal("url"),
  url: z.string().trim().min(1).max(8_192),
}).strict();
const ConnectionContentSchema = z.object({
  kind: z.literal("connection"),
  connectionId: z.string().trim().min(1).max(512),
  locator: z.string().trim().min(1).max(8_192).optional(),
}).strict();
const ContentSchema = z.discriminatedUnion("kind", [
  PasteContentSchema,
  FileContentSchema,
  UrlContentSchema,
  ConnectionContentSchema,
]);

const CreateSourceSchema = z.object({
  scope: ScopeSchema.optional(),
  id: z.string().trim().min(1).max(512).optional(),
  label: z.string().trim().min(1).max(512),
  trust: z.enum(BRAIN_TRUST_LEVELS),
  metadata: z.record(z.string(), z.unknown()).optional(),
  content: ContentSchema,
}).strict();

const UpdateSourceSchema = z.object({
  label: z.string().trim().min(1).max(512).optional(),
  trust: z.enum(BRAIN_TRUST_LEVELS).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one source field is required",
);

const ReindexSourceSchema = z.object({
  content: ContentSchema,
}).strict();

const SearchSchema = z.object({
  query: z.string().trim().min(1).max(16_384),
  scopes: z.array(ScopeSchema).min(1).max(100).optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
  tokenBudget: z.number().int().min(0).max(1_000_000).optional(),
}).strict();

const SourceParamsSchema = z.object({
  sourceId: z.string().trim().min(1).max(512),
});
const ScopeQuerySchema = z.object({
  scopeKind: z.enum(["org", "project"]).optional(),
  scopeId: z.string().trim().min(1).max(512).optional(),
}).strict();
const ListQuerySchema = ScopeQuerySchema.extend({
  status: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
  cursor: z.string().trim().min(1).max(8_192).optional(),
});
const ReadSourceQuerySchema = ScopeQuerySchema.extend({
  version: z.string().trim().min(1).max(512).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  tokenBudget: z.coerce.number().int().min(1).max(100_000).optional(),
});

const SuccessSchema = z.object({
  ok: z.literal(true),
  data: z.any(),
});
const ErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string(),
});

function responses(successStatus: 200 | 201 | 202) {
  return {
    [successStatus]: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Success",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid request",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
    409: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Conflict",
    },
  } as const;
}

const listRoute = createRoute({
  method: "get",
  path: "/sources",
  tags: ["Brain"],
  summary: "List Brain sources",
  request: { query: ListQuerySchema },
  responses: responses(200),
});
const createRouteDefinition = createRoute({
  method: "post",
  path: "/sources",
  tags: ["Brain"],
  summary: "Create and ingest a Brain source",
  request: {
    body: {
      content: { "application/json": { schema: CreateSourceSchema } },
    },
  },
  responses: responses(201),
});
const getRoute = createRoute({
  method: "get",
  path: "/sources/{sourceId}",
  tags: ["Brain"],
  summary: "Get a Brain source",
  request: {
    params: SourceParamsSchema,
    query: ScopeQuerySchema,
  },
  responses: responses(200),
});
const updateRoute = createRoute({
  method: "patch",
  path: "/sources/{sourceId}",
  tags: ["Brain"],
  summary: "Update Brain source metadata",
  request: {
    params: SourceParamsSchema,
    query: ScopeQuerySchema,
    body: {
      content: { "application/json": { schema: UpdateSourceSchema } },
    },
  },
  responses: responses(200),
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/sources/{sourceId}",
  tags: ["Brain"],
  summary: "Delete a Brain source",
  request: {
    params: SourceParamsSchema,
    query: ScopeQuerySchema,
  },
  responses: responses(200),
});
const reindexRoute = createRoute({
  method: "post",
  path: "/sources/{sourceId}/reindex",
  tags: ["Brain"],
  summary: "Build and publish a new Brain source version",
  request: {
    params: SourceParamsSchema,
    query: ScopeQuerySchema,
    body: {
      content: { "application/json": { schema: ReindexSourceSchema } },
    },
  },
  responses: responses(202),
});
const listVersionsRoute = createRoute({
  method: "get",
  path: "/sources/{sourceId}/versions",
  tags: ["Brain"],
  summary: "List Brain source versions",
  request: {
    params: SourceParamsSchema,
    query: ScopeQuerySchema,
  },
  responses: responses(200),
});
const readSourceRoute = createRoute({
  method: "get",
  path: "/sources/{sourceId}/read",
  tags: ["Brain"],
  summary: "Read bounded chunks from a Brain source",
  request: {
    params: SourceParamsSchema,
    query: ReadSourceQuerySchema,
  },
  responses: responses(200),
});
const searchRoute = createRoute({
  method: "post",
  path: "/search",
  tags: ["Brain"],
  summary: "Search granted Brain sources",
  request: {
    body: {
      content: { "application/json": { schema: SearchSchema } },
    },
  },
  responses: responses(200),
});

export interface BrainRouteDeps {
  readonly service: BrainManagementService;
  readonly context: BrainServiceContext;
}

type BrainRouteDepsResolver = (
  context: Context,
) => BrainRouteDeps | Promise<BrainRouteDeps>;

const publicInputCodes = new Set([
  "content_too_large",
  "empty_content",
  "fetch_failed",
  "file_outside_root",
  "too_many_redirects",
  "unsafe_url",
  "unsupported_file",
  "unsupported_mime",
]);

function errorResponse(c: Context, error: unknown): Response {
  if (
    error instanceof BrainStoreAuthorizationError
    || (
      error instanceof BrainIngestionError
      && error.code === "access_denied"
    )
  ) {
    return c.json({
      ok: false,
      error: "Brain access denied",
      code: "forbidden",
    }, 403);
  }
  if (
    error instanceof BrainIngestionError
    && (
      error.code === "source_not_found"
      || error.code === "version_not_found"
    )
  ) {
    return c.json({
      ok: false,
      error: "Brain source not found",
      code: "not_found",
    }, 404);
  }
  if (error instanceof BrainStoreConflictError) {
    return c.json({
      ok: false,
      error: "Brain source changed; retry the request",
      code: "conflict",
    }, 409);
  }
  if (
    error instanceof BrainContractError
    || error instanceof BrainStoreValidationError
    || (
      error instanceof BrainIngestionError
      && error.code !== "ingestion_failed"
    )
    || (
      error
      && typeof error === "object"
      && "code" in error
      && publicInputCodes.has(String(error.code))
    )
  ) {
    return c.json({
      ok: false,
      error: "Invalid Brain request",
      code: "invalid_request",
    }, 400);
  }
  throw error;
}

function parseList<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T[] | undefined {
  if (!value) return undefined;
  const values = [...new Set(value.split(",").map((item) => item.trim()))];
  if (values.some((item) => !allowed.includes(item as T))) {
    throw new BrainStoreValidationError(`Unknown Brain ${label}`);
  }
  return values as T[];
}

function explicitScope(input: {
  readonly scopeKind?: "org" | "project";
  readonly scopeId?: string;
}): BrainScope | undefined {
  if ((input.scopeKind === undefined) !== (input.scopeId === undefined)) {
    throw new BrainStoreValidationError(
      "scopeKind and scopeId must be provided together",
    );
  }
  return input.scopeKind && input.scopeId
    ? normalizeBrainScope({
        kind: input.scopeKind,
        subjectId: input.scopeId,
      })
    : undefined;
}

function inferredScope(
  context: BrainServiceContext,
  mode: "read" | "write",
  requested?: BrainScope,
): BrainScope {
  if (requested) return normalizeBrainScope(requested);
  if (mode === "write" && context.defaultWriteScope) {
    return normalizeBrainScope(context.defaultWriteScope);
  }
  const scopes = mode === "write" ? context.writeScopes : context.readScopes;
  if (scopes.length !== 1) {
    throw new BrainStoreValidationError(
      `An explicit Brain ${mode} scope is required`,
    );
  }
  return normalizeBrainScope(scopes[0]);
}

export function brainRoutes(
  resolveDeps: BrainRouteDepsResolver,
): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (result.success) return;
      return c.json({
        ok: false as const,
        error: "Invalid Brain request",
        code: "invalid_request" as const,
      }, 400);
    },
  });

  app.openapi(listRoute, async (c) => {
    try {
      const { service, context } = await resolveDeps(c);
      const query = c.req.valid("query");
      const scope = explicitScope(query);
      const statuses = parseList(
        query.status,
        BRAIN_SOURCE_STATUSES,
        "source status",
      );
      const types = parseList(
        query.type,
        BRAIN_SOURCE_TYPES,
        "source type",
      );
      const data = await service.listSources(context, {
        ...(scope ? { scopes: [scope] } : {}),
        ...(statuses ? { statuses } : {}),
        ...(types ? { types } : {}),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return c.json({ ok: true as const, data }, 200);
    } catch (error) {
      return errorResponse(c, error) as never;
    }
  });

  app.openapi(createRouteDefinition, async (c) => {
    try {
      const { service, context } = await resolveDeps(c);
      const body = c.req.valid("json");
      const scope = inferredScope(context, "write", body.scope);
      const data = await service.createSource(context, {
        scope,
        ...(body.id === undefined ? {} : { id: body.id }),
        label: body.label,
        trust: body.trust,
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
        content: body.content,
      });
      return c.json({ ok: true as const, data }, 201);
    } catch (error) {
      return errorResponse(c, error) as never;
    }
  });

  app.openapi(getRoute, async (c) => {
    try {
      const { service, context } = await resolveDeps(c);
      const { sourceId } = c.req.valid("param");
      const scope = inferredScope(
        context,
        "read",
        explicitScope(c.req.valid("query")),
      );
      const data = await service.getSource(context, { scope, sourceId });
      if (!data) {
        return c.json({
          ok: false as const,
          error: "Brain source not found",
          code: "not_found",
        }, 404);
      }
      return c.json({ ok: true as const, data }, 200);
    } catch (error) {
      return errorResponse(c, error) as never;
    }
  });

  app.openapi(updateRoute, async (c) => {
    try {
      const { service, context } = await resolveDeps(c);
      const { sourceId } = c.req.valid("param");
      const scope = inferredScope(
        context,
        "write",
        explicitScope(c.req.valid("query")),
      );
      const body = c.req.valid("json");
      const data = await service.updateSource(
        context,
        { scope, sourceId },
        body,
      );
      return c.json({ ok: true as const, data }, 200);
    } catch (error) {
      return errorResponse(c, error) as never;
    }
  });

  app.openapi(deleteRoute, async (c) => {
    try {
      const { service, context } = await resolveDeps(c);
      const { sourceId } = c.req.valid("param");
      const scope = inferredScope(
        context,
        "write",
        explicitScope(c.req.valid("query")),
      );
      await service.deleteSource(context, { scope, sourceId });
      return c.json({
        ok: true as const,
        data: { deleted: true },
      }, 200);
    } catch (error) {
      return errorResponse(c, error) as never;
    }
  });

  app.openapi(reindexRoute, async (c) => {
    try {
      const { service, context } = await resolveDeps(c);
      const { sourceId } = c.req.valid("param");
      const scope = inferredScope(
        context,
        "write",
        explicitScope(c.req.valid("query")),
      );
      const body = c.req.valid("json");
      const data = await service.reindexSource(
        context,
        { scope, sourceId },
        body,
      );
      return c.json({ ok: true as const, data }, 202);
    } catch (error) {
      return errorResponse(c, error) as never;
    }
  });

  app.openapi(listVersionsRoute, async (c) => {
    try {
      const { service, context } = await resolveDeps(c);
      const { sourceId } = c.req.valid("param");
      const scope = inferredScope(
        context,
        "read",
        explicitScope(c.req.valid("query")),
      );
      const data = await service.listVersions(context, { scope, sourceId });
      return c.json({ ok: true as const, data }, 200);
    } catch (error) {
      return errorResponse(c, error) as never;
    }
  });

  app.openapi(readSourceRoute, async (c) => {
    try {
      const { service, context } = await resolveDeps(c);
      const { sourceId } = c.req.valid("param");
      const query = c.req.valid("query");
      const scope = inferredScope(
        context,
        "read",
        explicitScope(query),
      );
      const data = await service.readSource(context, {
        ref: { scope, sourceId },
        ...(query.version === undefined
          ? {}
          : { version: query.version }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.tokenBudget === undefined
          ? {}
          : { tokenBudget: query.tokenBudget }),
      });
      return c.json({ ok: true as const, data }, 200);
    } catch (error) {
      return errorResponse(c, error) as never;
    }
  });

  app.openapi(searchRoute, async (c) => {
    try {
      const { service, context } = await resolveDeps(c);
      const body = c.req.valid("json");
      const data = await service.search(context, body);
      return c.json({ ok: true as const, data }, 200);
    } catch (error) {
      return errorResponse(c, error) as never;
    }
  });

  return app;
}
