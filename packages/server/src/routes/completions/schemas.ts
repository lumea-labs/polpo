/**
 * Zod request/response schemas + OpenAPI route definition for the
 * OpenAI-compatible chat completions endpoint.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { RuntimeRoutingSchema, RuntimeSandboxSchema } from "../../schemas.js";

// ── Zod Schemas ────────────────────────────────────────────────────────

/** OpenAI-compatible content part (text, image_url, or file reference). */
export const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z.string().openapi({ description: "Data URL (data:image/…;base64,…) or HTTPS URL" }),
      detail: z.enum(["auto", "low", "high"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("file"),
    file_id: z.string().openapi({ description: "Attachment ID from a previous upload" }),
  }),
]);

const assistantToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string().default("{}"),
  }),
});

export const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]).openapi({
    description: "Message role. System messages are appended as additional context. Tool messages carry results of client-side tool calls.",
  }),
  content: z.union([
    z.string(),
    z.array(contentPartSchema),
    z.null(),
  ]).openapi({ description: "Message content — plain string or array of content parts (text / image_url)" }),
  tool_calls: z.array(assistantToolCallSchema).optional().openapi({
    description: "OpenAI-compatible assistant tool calls awaiting matching role=tool results.",
  }),
  tool_call_id: z.string().optional().openapi({
    description: "ID of the tool call this message responds to (required for role=tool)",
  }),
  name: z.string().optional().openapi({
    description: "Tool name (for role=tool messages)",
  }),
});

const responseFormatNameSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, {
    message: "response_format.json_schema.name may contain only letters, numbers, underscores, and hyphens",
  });

const jsonSchemaObject = z.record(z.string(), z.unknown());

/** OpenAI-compatible text, JSON object, and strict JSON Schema response modes. */
export const responseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).strict(),
  z.object({ type: z.literal("json_object") }).strict(),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: responseFormatNameSchema,
      description: z.string().optional(),
      schema: jsonSchemaObject,
      strict: z.boolean().optional(),
    }).strict(),
  }).strict(),
]);

export type CompletionResponseFormat = z.infer<typeof responseFormatSchema>;

const chatSuggestionSchema = z.object({
  id: z.string(),
  label: z.string(),
  prompt: z.string(),
}).strict();

export const completionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1).openapi({
    description: "Conversation messages in OpenAI format",
  }),
  stream: z.boolean().optional().default(false).openapi({
    description: "If true, returns an SSE stream of OpenAI-format chunks. If false, returns a complete response.",
  }),
  model: z.string().optional().openapi({
    description: "Ignored. Polpo uses its configured orchestrator model (or the agent's model in agent-direct mode).",
  }),
  temperature: z.number().optional().openapi({
    description: "Ignored. Reserved for future use.",
  }),
  max_tokens: z.number().int().optional().openapi({
    description: "Ignored. Reserved for future use.",
  }),
  response_format: responseFormatSchema.optional().openapi({
    description:
      "OpenAI-compatible response format. Use json_object for valid JSON or json_schema for schema-validated structured output.",
  }),
  agent: z.string().optional().openapi({
    description: "Target a specific agent by name for direct conversation. Uses the agent's own model, system prompt, and coding tools instead of the orchestrator. Omit to talk to the orchestrator (default).",
  }),
  loop: z.string().optional().openapi({
    description: "Optional configurable loop name for agent-direct mode. Applies that loop's prompt, tools, model, reasoning, and maxTurns overrides.",
  }),
  sandbox: RuntimeSandboxSchema.optional().openapi({
    description: "Optional runtime sandbox policy for this chat request. Applies when chat executes through the shared Run lifecycle.",
  }),
  guardrails: z.object({
    policyPack: z.literal("strict"),
  }).strict().optional().openapi({
    description:
      "Optional stricter runtime policy. It can only upgrade an already-configured project policy to strict.",
  }),
  routing: RuntimeRoutingSchema.optional().openapi({
    description:
      "Optional bounded labels used by deterministic model and execution routing policies.",
  }),
  polpo: z.object({
    capabilities: z.object({
      ask_user_question: z.boolean().optional(),
      suggestions: z.boolean().optional(),
    }).strict().optional(),
  }).strict().optional().openapi({
    description:
      "Polpo client capabilities. Suggestions require explicit support; ask_user_question may be explicitly disabled by clients that cannot render it.",
  }),
  project: z.string().optional().openapi({
    description: "Deprecated. Ignored.",
  }),
  // OpenAI-compat identity fields. Persisted on the Session row and exposed
  // via GET /v1/chat/sessions filters. Polpo does NOT verify `user`; the
  // caller's API key is the trust anchor — `user` is purely opaque scoping.
  user: z.string().optional().openapi({
    description:
      "Opaque end-user identifier (OpenAI-compat). Persisted on the session and used for filtering, per-user analytics, and pass-through to billing integrations (e.g. Autumn customer_id). Polpo does not verify this — set it from your authenticated end-user id.",
  }),
  metadata: z
    .record(z.string(), z.string())
    .refine((m) => Object.keys(m).length <= 16, { message: "metadata: max 16 keys" })
    .refine((m) => Object.keys(m).every((k) => k.length <= 64), { message: "metadata: key max 64 chars" })
    .refine((m) => Object.values(m).every((v) => v.length <= 512), { message: "metadata: value max 512 chars" })
    .optional()
    .openapi({
      description:
        "Arbitrary key/value tags (OpenAI-compat). Up to 16 keys, key ≤64 chars, value ≤512 chars. Persisted on the session for filtering and analytics. Deterministic loop tool inputs can bind them from request.metadata.<key>; they are not added to model prompts. Use for tenant_id, plan, identity_provider, ab_variant, etc.",
    }),
});

/** Parsed request body shape (post-validation, defaults applied). */
export type CompletionRequestBody = z.infer<typeof completionRequestSchema>;

export const completionResponseSchema = z.object({
  id: z.string().openapi({ description: "Unique completion ID (chatcmpl-...)" }),
  object: z.literal("chat.completion"),
  created: z.number().int().openapi({ description: "Unix timestamp" }),
  model: z.literal("polpo"),
  choices: z.array(z.object({
    index: z.number().int(),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string(),
    }),
    finish_reason: z.enum(["stop", "length", "ask_user", "mission_preview", "vault_preview"]),
  })),
  usage: z.object({
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    total_tokens: z.number().int(),
  }),
  loop_trace: z.array(z.unknown()).optional(),
  polpo: z.object({
    suggestions: z.array(chatSuggestionSchema).optional(),
  }).strict().optional(),
});

export const errorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string().optional(),
  }),
});

// ── Route definition ───────────────────────────────────────────────────

export const chatCompletionsRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Chat Completions"],
  summary: "Chat completions",
  description: "Polpo's primary conversational interface. Send messages in OpenAI format, receive responses in OpenAI format. Polpo runs its full 37-tool agentic loop internally — you describe what you need, Polpo handles the rest. Supports streaming (SSE) and non-streaming modes.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: completionRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: completionResponseSchema,
        },
      },
      description: "Chat completion response (non-streaming). When stream=true, returns text/event-stream with OpenAI-format chunks ending with data: [DONE].",
    },
    400: {
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
      description: "Invalid request (missing messages or no project available)",
    },
    401: {
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
      description: "Invalid API key",
    },
  },
});
