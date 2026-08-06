import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  SteeringAbortError,
  SteeringClosedError,
  SteeringQueueFullError,
  SteeringRunConflictError,
  SteeringRunNotFoundError,
  SteeringValidationError,
  type SteeringJsonValue,
  type SteeringMessageInput,
  type SteeringRunRegistry,
} from "@polpo-ai/core/steering";

export interface RunSteeringRouteDeps {
  steeringRegistry?: SteeringRunRegistry;
}

const attachmentSchema = z.object({
  type: z.enum(["image", "audio", "file"]),
  url: z.string().min(1),
  mediaType: z.string().min(1).max(127).optional(),
  name: z.string().min(1).max(255).optional(),
}).strict();

const steeringBodySchema = z.object({
  id: z.string().min(1).max(128),
  mode: z.enum(["steer", "follow_up"]),
  content: z.object({
    text: z.string().optional(),
    attachments: z.array(attachmentSchema).max(16).optional(),
  }).strict(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const abortBodySchema = z.object({
  reason: z.unknown().optional(),
}).strict();

const successSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    runId: z.string(),
    id: z.string().optional(),
    accepted: z.boolean().optional(),
    duplicate: z.boolean().optional(),
    aborted: z.boolean().optional(),
  }),
});

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string(),
});

const steeringRoute = createRoute({
  method: "post",
  path: "/{runId}/steering",
  tags: ["Runs"],
  summary: "Steer an active run",
  description:
    "Queue a user message for the next model/tool safe boundary. follow_up messages wait until the run would otherwise finish.",
  request: {
    params: z.object({ runId: z.string().min(1).max(128) }),
    body: { content: { "application/json": { schema: steeringBodySchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: successSchema } }, description: "Duplicate message already accepted" },
    202: { content: { "application/json": { schema: successSchema } }, description: "Message accepted" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid steering message" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Active run not found" },
    409: { content: { "application/json": { schema: errorSchema } }, description: "Run is no longer accepting messages" },
    429: { content: { "application/json": { schema: errorSchema } }, description: "Run steering queue is full" },
    501: { content: { "application/json": { schema: errorSchema } }, description: "Host does not support steering" },
  },
});

const abortRoute = createRoute({
  method: "post",
  path: "/{runId}/abort",
  tags: ["Runs"],
  summary: "Abort an active run",
  request: {
    params: z.object({ runId: z.string().min(1).max(128) }),
    body: { content: { "application/json": { schema: abortBodySchema } } },
  },
  responses: {
    202: { content: { "application/json": { schema: successSchema } }, description: "Abort accepted" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid abort reason" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Active run not found" },
    501: { content: { "application/json": { schema: errorSchema } }, description: "Host does not support steering" },
  },
});

export function runSteeringRoutes(getDeps: () => RunSteeringRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(steeringRoute, async (c: any) => {
    const registry = getDeps().steeringRegistry;
    if (!registry) return unavailable(c);
    const runId = c.req.valid("param").runId as string;
    const input = c.req.valid("json") as SteeringMessageInput;
    try {
      const result = await registry.enqueue(runId, input);
      return c.json({
        ok: true,
        data: {
          runId,
          id: input.id,
          accepted: result.accepted,
          duplicate: result.duplicate,
        },
      }, result.duplicate ? 200 : 202);
    } catch (error) {
      return steeringError(c, error);
    }
  });

  app.openapi(abortRoute, async (c: any) => {
    const registry = getDeps().steeringRegistry;
    if (!registry) return unavailable(c);
    const runId = c.req.valid("param").runId as string;
    const body = c.req.valid("json") as { reason?: SteeringJsonValue };
    try {
      await registry.abort(runId, body.reason);
      return c.json({ ok: true, data: { runId, aborted: true } }, 202);
    } catch (error) {
      return steeringError(c, error);
    }
  });

  return app;
}

function unavailable(c: any) {
  return c.json({ ok: false, error: "Run steering is not configured", code: "STEERING_UNAVAILABLE" }, 501);
}

function steeringError(c: any, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SteeringRunNotFoundError) {
    return c.json({ ok: false, error: message, code: "RUN_NOT_ACTIVE" }, 404);
  }
  if (error instanceof SteeringQueueFullError) {
    return c.json({ ok: false, error: message, code: "STEERING_QUEUE_FULL" }, 429);
  }
  if (
    error instanceof SteeringClosedError
    || error instanceof SteeringAbortError
    || error instanceof SteeringRunConflictError
  ) {
    return c.json({ ok: false, error: message, code: "RUN_NOT_ACCEPTING_STEERING" }, 409);
  }
  if (error instanceof SteeringValidationError) {
    return c.json({ ok: false, error: message, code: "INVALID_STEERING_MESSAGE" }, 400);
  }
  throw error;
}
