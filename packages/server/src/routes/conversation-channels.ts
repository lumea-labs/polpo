import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ChannelManagementError,
  type ChannelManagementService,
} from "@polpo-ai/channels";
import type { ChannelManagementRouteDeps } from "../deps.js";
import {
  inspectClientJsonSchema,
  MAX_CLIENT_TOOLS_BYTES,
} from "./completions/schemas.js";

const providerId = z.enum(["slack", "telegram", "discord", "whatsapp"]);
const routeAllowedTools = z.array(z.string().trim().min(1).max(256)).max(256)
  .superRefine((tools, ctx) => {
    const seen = new Set<string>();
    for (const [index, tool] of tools.entries()) {
      const key = tool.toLocaleLowerCase("en-US");
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate tool pattern: ${tool}`,
          path: [index],
        });
      }
      seen.add(key);
    }
  });
const channelIdentityResolver = z.object({
  connectionId: z.string().min(1).max(256),
  endpoint: z.string().url().max(2_048),
  timeoutMs: z.number().int().min(250).max(10_000).optional(),
  type: z.literal("http"),
  version: z.literal(1),
}).strict();
const channelActiveRunPolicy = z.object({
  behavior: z.literal("reject"),
  reply: z.string().trim().min(1).max(1_000),
}).strict();
const channelClientToolDefinition = {
  description: z.string().max(8_192).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
};
const channelClientToolContinuation = z.discriminatedUnion("mode", [
  z.object({
    ...channelClientToolDefinition,
    mode: z.literal("direct"),
  }).strict(),
  z.object({
    ...channelClientToolDefinition,
    loop: z.string().trim().min(1).max(256),
    mode: z.literal("loop"),
  }).strict(),
]);
const channelClientToolHandler = z.object({
  connectionId: z.string().min(1).max(256),
  endpoint: z.string().url().max(2_048),
  maxContinuations: z.number().int().min(1).max(8).optional(),
  timeoutMs: z.number().int().min(250).max(30_000).optional(),
  tools: z.record(z.string().trim().min(1).max(256), channelClientToolContinuation)
    .refine((tools) => Object.keys(tools).length > 0 && Object.keys(tools).length <= 32, {
      message: "clientToolHandler.tools must contain between 1 and 32 tools",
    })
    .superRefine((tools, ctx) => {
      for (const [name, tool] of Object.entries(tools)) {
        if (tool.parameters === undefined) continue;
        if (tool.parameters.type !== "object") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Tool parameters must be a JSON Schema with type=object",
            path: [name, "parameters", "type"],
          });
        }
        inspectClientJsonSchema(
          tool.parameters,
          ctx,
          [name, "parameters"],
          { nodes: 0 },
        );
      }
      if (new TextEncoder().encode(JSON.stringify(tools)).byteLength > MAX_CLIENT_TOOLS_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Client tool declarations exceed ${MAX_CLIENT_TOOLS_BYTES} bytes`,
          path: [],
        });
      }
    }),
  type: z.literal("http"),
  version: z.literal(1),
}).strict();
const channelSettings = z.object({
  activeRunPolicy: channelActiveRunPolicy.optional(),
  clientToolHandler: channelClientToolHandler.optional(),
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
  allowedTools: routeAllowedTools.optional(),
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
    activeRunPolicy: channelActiveRunPolicy.nullable().optional(),
    clientToolHandler: channelClientToolHandler.nullable().optional(),
    identityResolver: channelIdentityResolver.nullable().optional(),
  }).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Channel update must include at least one field",
});

const routeBody = z.object({
  agentName: z.string().min(1).max(256),
  allowedTools: routeAllowedTools.optional(),
  enabled: z.boolean().optional(),
  externalChannelId: z.string().max(512).nullable().optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
}).strict();
const testBody = z.object({
  to: z.string().min(1).max(512).optional(),
}).strict();
const templateParameter = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(4_096) }).strict(),
  z.object({
    type: z.literal("currency"),
    currency: z.object({
      amount_1000: z.number().int(),
      code: z.string().min(3).max(3),
      fallback_value: z.string().min(1).max(1_024),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("date_time"),
    date_time: z.object({ fallback_value: z.string().min(1).max(1_024) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("image"),
    image: z.object({ id: z.string().min(1).max(512).optional(), link: z.string().url().max(2_048).optional() })
      .strict().refine((value) => Boolean(value.id || value.link), "image requires id or link"),
  }).strict(),
  z.object({
    type: z.literal("document"),
    document: z.object({
      filename: z.string().min(1).max(512).optional(),
      id: z.string().min(1).max(512).optional(),
      link: z.string().url().max(2_048).optional(),
    }).strict().refine((value) => Boolean(value.id || value.link), "document requires id or link"),
  }).strict(),
  z.object({
    type: z.literal("video"),
    video: z.object({ id: z.string().min(1).max(512).optional(), link: z.string().url().max(2_048).optional() })
      .strict().refine((value) => Boolean(value.id || value.link), "video requires id or link"),
  }).strict(),
]);
const templateButtonParameter = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(4_096) }).strict(),
  z.object({ type: z.literal("payload"), payload: z.string().max(4_096) }).strict(),
]);
const templateComponent = z.union([
  z.object({
    type: z.enum(["header", "body"]),
    parameters: z.array(templateParameter).max(50),
  }).strict(),
  z.object({
    type: z.literal("button"),
    sub_type: z.enum(["url", "quick_reply"]),
    index: z.number().int().min(0).max(9),
    parameters: z.array(templateButtonParameter).max(10),
  }).strict(),
]);
const templateBody = z.object({
  idempotencyKey: z.string().min(1).max(512),
  to: z.string().min(1).max(100),
  template: z.object({
    name: z.string().regex(/^[a-z0-9_]+$/).max(512),
    language: z.string().regex(/^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?$/).max(35),
    components: z.array(templateComponent).max(20).optional(),
  }).strict(),
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
    method: "post",
    path: "/{channelId}/templates",
    tags: ["Conversation Channels"],
    summary: "Send an approved WhatsApp template",
    request: {
      params: channelParams,
      body: { content: { "application/json": { schema: templateBody } } },
    },
    responses: { 200: { content: { "application/json": { schema: success } }, description: "Template delivery" }, ...errors },
  }), (c: any) => withService(c, getDeps, async (service, deps) => {
    const body = c.req.valid("json");
    return c.json({ ok: true, data: await service.sendTemplate(
      await deps.resolveChannelManagementScope(c),
      c.req.valid("param").channelId,
      {
        idempotencyKey: body.idempotencyKey,
        recipient: body.to,
        template: body.template,
      },
    ) }, 200);
  }));

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
