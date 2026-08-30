import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ConnectError } from "@polpo-ai/connect";
import type { ConnectSubject, ConnectionListFilter } from "@polpo-ai/connect";
import type { ConnectService } from "@polpo-ai/connect-server";
import type { ConnectRouteDeps } from "../deps.js";

const subjectSchema = z.object({
  type: z.enum(["user", "project", "org", "agent", "service"]),
  id: z.string().min(1),
});

const ownerSchema = z.union([
  subjectSchema,
  z.object({
    type: z.literal("external_user"),
    namespace: z.string().min(1).max(256),
    id: z.string().min(1).max(256),
  }),
]);

const connectionBindingSchema = z.object({
  principal: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
  tenant: z.object({ namespace: z.string().min(1), id: z.string().min(1) }).optional(),
  resource: z.object({
    namespace: z.string().min(1),
    type: z.string().min(1),
    id: z.string().min(1),
  }).optional(),
  scopeEpoch: z.string().min(1).optional(),
});

const createApiKeyConnectionBody = z.object({
  providerId: z.string().min(1),
  apiKey: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  subject: subjectSchema.optional(),
  name: z.string().optional(),
  projectId: z.string().optional(),
  orgId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const startOAuthBody = z.object({
  providerId: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  subject: subjectSchema.optional(),
  redirectUri: z.string().url(),
  projectId: z.string().optional(),
  orgId: z.string().optional(),
  connectionName: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const completeOAuthBody = z.object({
  state: z.string().min(1),
  code: z.string().optional(),
  error: z.string().optional(),
  errorDescription: z.string().optional(),
});

const getTokenBody = z.object({
  scopes: z.array(z.string()).optional(),
  subject: subjectSchema.optional(),
  actionId: z.string().optional(),
  forceRefresh: z.boolean().optional(),
}).optional();

const createSetupSessionBody = z.object({
  providerId: z.string().min(1),
  projectId: z.string().min(1),
  orgId: z.string().min(1).optional(),
  audience: z.enum(["personal", "shared", "end_user"]),
  subject: ownerSchema,
  binding: connectionBindingSchema.optional(),
  scopes: z.array(z.string().min(1)).optional(),
  returnUrl: z.string().url(),
  oauthClientMode: z.enum(["managed", "customer", "instance"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const gatewayRequestBody = z.object({
  scopes: z.array(z.string().min(1)).optional(),
  subject: subjectSchema.optional(),
  actionId: z.string().min(1).optional(),
  forceRefresh: z.boolean().optional(),
  request: z.object({
    method: z.string().min(1),
    path: z.string().min(1),
    query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    idempotencyKey: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
});

const connectionFilterQuery = z.object({
  providerId: z.string().optional(),
  projectId: z.string().optional(),
  orgId: z.string().optional(),
  status: z.enum(["active", "pending", "revoked", "error"]).optional(),
  ownerType: z.enum(["user", "project", "org", "agent", "service"]).optional(),
  ownerId: z.string().optional(),
});

const connectionLinkFilterQuery = z.object({
  connectionId: z.string().optional(),
  projectId: z.string().optional(),
  status: z.enum(["active", "revoked"]).optional(),
});

const createConnectionLinkBody = z.object({
  connectionId: z.string().min(1),
  projectId: z.string().min(1),
});

const okAnySchema = z.object({ ok: z.boolean(), data: z.any() });
const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional(), details: z.unknown().optional() });

export function connectRoutes(getDeps: () => ConnectRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const openapi = app.openapi.bind(app) as any;

  openapi(
    createRoute({
      method: "get",
      path: "/providers",
      tags: ["Connect"],
      summary: "List connector providers",
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "Connector providers" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => c.json({ ok: true, data: service.listProviders() }, 200)),
  );

  openapi(
    createRoute({
      method: "get",
      path: "/connections",
      tags: ["Connect"],
      summary: "List connections",
      request: { query: connectionFilterQuery },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "Connections" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      const query = c.req.valid("query");
      const owner = query.ownerType && query.ownerId ? { type: query.ownerType, id: query.ownerId } satisfies ConnectSubject : undefined;
      const filter: ConnectionListFilter = {
        providerId: query.providerId,
        projectId: query.projectId,
        orgId: query.orgId,
        status: query.status,
        owner,
      };
      return c.json({ ok: true, data: await service.listConnections(filter) }, 200);
    }),
  );

  openapi(
    createRoute({
      method: "get",
      path: "/connection-links",
      tags: ["Connect"],
      summary: "List Connection project links",
      request: { query: connectionLinkFilterQuery },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "Connection links" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      return c.json({ ok: true, data: await service.listConnectionLinks(c.req.valid("query")) }, 200);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/connection-links",
      tags: ["Connect"],
      summary: "Link a Connection to a project",
      request: { body: { content: { "application/json": { schema: createConnectionLinkBody } } } },
      responses: {
        201: { content: { "application/json": { schema: okAnySchema } }, description: "Connection linked" },
        404: { content: { "application/json": { schema: errorSchema } }, description: "Connection not found" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      return c.json({ ok: true, data: await service.linkConnection(c.req.valid("json")) }, 201);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/connection-links/:id/revoke",
      tags: ["Connect"],
      summary: "Revoke a Connection project link",
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "Connection link revoked" },
        404: { content: { "application/json": { schema: errorSchema } }, description: "Connection link not found" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      return c.json({
        ok: true,
        data: await service.unlinkConnection({ linkId: c.req.param("id") }),
      }, 200);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/connections/api-key",
      tags: ["Connect"],
      summary: "Create API-key connection",
      request: { body: { content: { "application/json": { schema: createApiKeyConnectionBody } } } },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "Connection created" },
        400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid request" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      const body = c.req.valid("json");
      const data = await service.createApiKeyConnection(body);
      return c.json({ ok: true, data }, 200);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/oauth/start",
      tags: ["Connect"],
      summary: "Start OAuth connection flow",
      request: { body: { content: { "application/json": { schema: startOAuthBody } } } },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "OAuth authorization URL" },
        400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid request" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      const data = await service.startOAuth(c.req.valid("json"));
      return c.json({ ok: true, data }, 200);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/oauth/callback",
      tags: ["Connect"],
      summary: "Complete OAuth connection flow",
      request: { body: { content: { "application/json": { schema: completeOAuthBody } } } },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "Connection created" },
        400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid OAuth callback" },
        403: { content: { "application/json": { schema: errorSchema } }, description: "Expired OAuth state" },
        404: { content: { "application/json": { schema: errorSchema } }, description: "OAuth state not found" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      const data = await service.completeOAuth(c.req.valid("json"));
      return c.json({ ok: true, data }, 200);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/setup-sessions",
      tags: ["Connect"],
      summary: "Create a trusted end-user Connection setup session",
      request: { body: { content: { "application/json": { schema: createSetupSessionBody } } } },
      responses: {
        201: { content: { "application/json": { schema: okAnySchema } }, description: "Setup session created" },
        400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid request" },
        422: { content: { "application/json": { schema: errorSchema } }, description: "Invalid setup policy" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      const data = await service.createSetupSession(c.req.valid("json"));
      return c.json({ ok: true, data }, 201);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/setup-sessions/:id/start",
      tags: ["Connect"],
      summary: "Consume a setup session and start OAuth",
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "OAuth authorization URL" },
        409: { content: { "application/json": { schema: errorSchema } }, description: "Setup session already consumed" },
        410: { content: { "application/json": { schema: errorSchema } }, description: "Setup session expired" },
        422: { content: { "application/json": { schema: errorSchema } }, description: "Invalid setup session" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      const data = await service.startOAuthSetup({ setupSessionId: c.req.param("id") });
      return c.json({ ok: true, data }, 200);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/connections/:id/token",
      tags: ["Connect"],
      summary: "Get runtime token for a connection",
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: { content: { "application/json": { schema: getTokenBody } }, required: false },
      },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "Runtime token" },
        403: { content: { "application/json": { schema: errorSchema } }, description: "Connection denied" },
        404: { content: { "application/json": { schema: errorSchema } }, description: "Connection not found" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      const input = (await parseOptionalJson(c)) ?? {};
      const data = await service.getToken({ connectionId: c.req.param("id"), ...input });
      return c.json({ ok: true, data }, 200);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/connections/:id/request",
      tags: ["Connect"],
      summary: "Execute a policy-bound Connection gateway request",
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: { content: { "application/json": { schema: gatewayRequestBody } } },
      },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "Provider response" },
        400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid request" },
        403: { content: { "application/json": { schema: errorSchema } }, description: "Operation denied" },
        404: { content: { "application/json": { schema: errorSchema } }, description: "Connection not found" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
        503: { content: { "application/json": { schema: errorSchema } }, description: "Provider or refresh unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      const body = c.req.valid("json");
      const data = await service.request({
        connectionId: c.req.param("id"),
        ...body,
        signal: c.req.raw.signal,
      });
      return c.json({ ok: true, data }, 200);
    }),
  );

  openapi(
    createRoute({
      method: "post",
      path: "/connections/:id/revoke",
      tags: ["Connect"],
      summary: "Revoke a connection",
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: { content: { "application/json": { schema: okAnySchema } }, description: "Connection revoked" },
        404: { content: { "application/json": { schema: errorSchema } }, description: "Connection not found" },
        501: { content: { "application/json": { schema: errorSchema } }, description: "Connect service unavailable" },
      },
    }),
    async (c: any) => withConnect(c, getDeps, async (service) => {
      const data = await service.revokeConnection({ connectionId: c.req.param("id") });
      return c.json({ ok: true, data }, 200);
    }),
  );

  return app;
}

async function withConnect(
  c: any,
  getDeps: () => ConnectRouteDeps,
  handler: (service: ConnectService) => Promise<Response> | Response,
): Promise<Response> {
  const service = getDeps().connectService;
  if (!service) {
    return c.json({ ok: false, error: "Connect service is not configured", code: "CONNECT_SERVICE_UNAVAILABLE" }, 501);
  }
  try {
    return await handler(service);
  } catch (error) {
    if (error instanceof ConnectError) {
      return c.json({ ok: false, error: error.message, code: error.code, details: error.details }, error.status);
    }
    throw error;
  }
}

async function parseOptionalJson(c: any): Promise<z.infer<typeof getTokenBody>> {
  const length = c.req.header("content-length");
  const type = c.req.header("content-type");
  if (length === "0" || !type?.includes("application/json")) return undefined;
  return getTokenBody.parse(await c.req.json());
}
