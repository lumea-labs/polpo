import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ChannelManagementError,
  type ChannelManagementService,
} from "@polpo-ai/channels";
import type { ChannelManagementRouteDeps } from "../deps.js";

const providerId = z.enum(["slack", "telegram", "discord", "whatsapp"]);
const channelIdentityResolver = z.object({
  connectionId: z.string().min(1).max(256),
  endpoint: z.string().url().max(2_048),
  timeoutMs: z.number().int().min(250).max(10_000).optional(),
  type: z.literal("http"),
  version: z.literal(1),
}).strict();
const channelSettings = z.object({
  concurrency: z.object({
    debounceMs: z.number().int().nonnegative().optional(),
    maxConcurrent: z.number().int().positive().optional(),
    maxQueueSize: z.number().int().nonnegative().optional(),
    onQueueFull: z.enum(["drop-oldest", "drop-newest"]).optional(),
    queueEntryTtlMs: z.number().int().positive().optional(),
    strategy: z.enum(["drop", "queue", "debounce", "burst", "concurrent"]),
  }).strict().optional(),
  identityResolver: channelIdentityResolver.optional(),
  responseDelivery: z.object({
    maxMessages: z.number().int().positive().optional(),
    style: z.enum(["single", "conversational"]),
    targetCharacters: z.number().int().positive().optional(),
  }).strict().optional(),
  responseModality: z.enum(["text", "voice"]).optional(),
  typingEnabled: z.boolean().optional(),
}).strict();

const configureBody = z.object({
  agentName: z.string().min(1).max(256),
  connectionId: z.string().min(1).max(256).optional(),
  externalChannelId: z.string().min(1).max(512).optional(),
  idempotencyKey: z.string().min(1).max(512),
  name: z.string().min(1).max(256).optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  provider: providerId,
  settings: channelSettings.optional(),
}).strict();

const updateBody = z.object({
  name: z.string().min(1).max(256).optional(),
  settings: channelSettings.extend({
    identityResolver: channelIdentityResolver.nullable().optional(),
  }).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Channel update must include at least one field",
});

const routeBody = z.object({
  agentName: z.string().min(1).max(256),
  enabled: z.boolean().optional(),
  externalChannelId: z.string().max(512).nullable().optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
}).strict();
const testBody = z.object({
  to: z.string().min(1).max(512).optional(),
}).strict();

const channelParams = z.object({ channelId: z.string().min(1).max(256) });
const routeParams = channelParams.extend({ routeId: z.string().min(1).max(256) });
const setupParams = z.object({ setupId: z.string().min(1).max(256) });
const success = z.object({ ok: z.literal(true), data: z.any() });
const failure = z.object({
  ok: z.literal(false),
  code: z.string(),
  error: z.string(),
  retryable: z.boolean().optional(),
});

const errors = {
  400: { content: { "application/json": { schema: failure } }, description: "Invalid request" },
  403: { content: { "application/json": { schema: failure } }, description: "Forbidden" },
  404: { content: { "application/json": { schema: failure } }, description: "Not found" },
  409: { content: { "application/json": { schema: failure } }, description: "Conflict" },
  429: { content: { "application/json": { schema: failure } }, description: "Rate limited" },
  500: { content: { "application/json": { schema: failure } }, description: "Operation failed" },
  501: { content: { "application/json": { schema: failure } }, description: "Management unavailable" },
  503: { content: { "application/json": { schema: failure } }, description: "Provider unavailable" },
} as const;

export function conversationChannelRoutes(
  getDeps: () => ChannelManagementRouteDeps,
): OpenAPIHono {
  const app = new OpenAPIHono();
  const openapi = app.openapi.bind(app) as any;

  openapi(createRoute({
    method: "get",
    path: "/providers",
    tags: ["Conversation Channels"],
    summary: "List conversational Channel providers",
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Providers" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service) =>
    c.json({ ok: true, data: service.listProviders() }, 200)));

  openapi(createRoute({
    method: "get",
    path: "/",
    tags: ["Conversation Channels"],
    summary: "List conversational Channels",
    request: { query: z.object({
      provider: providerId.optional(),
      status: z.enum(["pending", "active", "disabled", "error"]).optional(),
      connectionId: z.string().min(1).optional(),
    }) },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Channels" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) =>
    c.json({ ok: true, data: await service.list(await deps.resolveChannelManagementScope(c), c.req.valid("query")) }, 200)));

  openapi(createRoute({
    method: "post",
    path: "/configure",
    tags: ["Conversation Channels"],
    summary: "Configure a conversational Channel and agent Route",
    request: { body: { content: { "application/json": { schema: configureBody } } } },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Provisioning result" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) =>
    c.json({ ok: true, data: await service.configure(
      await deps.resolveChannelManagementScope(c),
      c.req.valid("json"),
    ) }, 200)));

  openapi(createRoute({
    method: "get",
    path: "/setups/{setupId}",
    tags: ["Conversation Channels"],
    summary: "Get secure Channel setup status",
    request: { params: setupParams },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Setup status" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) =>
    c.json({ ok: true, data: await service.setupStatus(
      await deps.resolveChannelManagementScope(c),
      c.req.valid("param").setupId,
    ) }, 200)));

  openapi(createRoute({
    method: "get",
    path: "/{channelId}",
    tags: ["Conversation Channels"],
    summary: "Get a conversational Channel",
    request: { params: channelParams },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Channel" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) =>
    c.json({ ok: true, data: await service.get(
      await deps.resolveChannelManagementScope(c),
      c.req.valid("param").channelId,
    ) }, 200)));

  openapi(createRoute({
    method: "patch",
    path: "/{channelId}",
    tags: ["Conversation Channels"],
    summary: "Update a conversational Channel",
    request: { params: channelParams, body: { content: { "application/json": { schema: updateBody } } } },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Updated Channel" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) =>
    c.json({ ok: true, data: await service.update(
      await deps.resolveChannelManagementScope(c),
      c.req.valid("param").channelId,
      c.req.valid("json"),
    ) }, 200)));

  openapi(createRoute({
    method: "delete",
    path: "/{channelId}",
    tags: ["Conversation Channels"],
    summary: "Remove a conversational Channel",
    request: { params: channelParams },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Removed Channel" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) =>
    c.json({ ok: true, data: await service.remove(
      await deps.resolveChannelManagementScope(c),
      c.req.valid("param").channelId,
    ) }, 200)));

  openapi(createRoute({
    method: "post",
    path: "/{channelId}/test",
    tags: ["Conversation Channels"],
    summary: "Test a conversational Channel",
    request: {
      params: channelParams,
      body: { required: false, content: { "application/json": { schema: testBody } } },
    },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Test result" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) =>
    c.json({ ok: true, data: await service.test(
      await deps.resolveChannelManagementScope(c),
      c.req.valid("param").channelId,
      { recipient: c.req.valid("json")?.to },
    ) }, 200)));

  openapi(createRoute({
    method: "get",
    path: "/{channelId}/routes",
    tags: ["Conversation Channels"],
    summary: "List agent Routes for a conversational Channel",
    request: { params: channelParams },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Channel Routes" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) =>
    c.json({ ok: true, data: await service.listRoutes(
      await deps.resolveChannelManagementScope(c),
      c.req.valid("param").channelId,
    ) }, 200)));

  openapi(createRoute({
    method: "post",
    path: "/{channelId}/routes",
    tags: ["Conversation Channels"],
    summary: "Add or update an agent Route",
    request: { params: channelParams, body: { content: { "application/json": { schema: routeBody } } } },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Channel Route" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) =>
    c.json({ ok: true, data: await service.upsertRoute(
      await deps.resolveChannelManagementScope(c),
      { ...c.req.valid("json"), channelId: c.req.valid("param").channelId },
    ) }, 200)));

  openapi(createRoute({
    method: "delete",
    path: "/{channelId}/routes/{routeId}",
    tags: ["Conversation Channels"],
    summary: "Remove an agent Route",
    request: { params: routeParams },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Removed Route" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) => {
    const scope = await deps.resolveChannelManagementScope(c);
    await service.get(scope, c.req.valid("param").channelId);
    const params = c.req.valid("param");
    return c.json({
      ok: true,
      data: await service.removeRoute(scope, params.routeId, params.channelId),
    }, 200);
  }));

  return app;
}

async function withService(
  c: any,
  getDeps: () => ChannelManagementRouteDeps,
  handler: (
    service: ChannelManagementService,
    deps: ChannelManagementRouteDeps,
  ) => Promise<Response> | Response,
): Promise<Response> {
  const deps = getDeps();
  if (!deps.channelManagementService) {
    return c.json({
      ok: false,
      error: "Conversation Channel management is not configured",
      code: "CHANNEL_MANAGEMENT_UNAVAILABLE",
    }, 501);
  }
  try {
    return await handler(deps.channelManagementService, deps);
  } catch (error) {
    if (error instanceof ChannelManagementError) {
      return c.json({
        ok: false,
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      }, error.status as any);
    }
    throw error;
  }
}
