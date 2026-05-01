/**
 * Vault REST API — direct CRUD for encrypted vault entries.
 *
 * POST /vault/entries — Save a vault entry (used by UI after vault_preview confirm)
 * DELETE /vault/entries/:agent/:service — Remove a vault entry
 *
 * This bypasses the LLM entirely — credentials go straight to the encrypted store.
 * No credentials are logged, persisted in session history, or returned in responses.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { VaultEntry } from "@polpo-ai/core/types";

// ─── Per-type credential schemas ────────────────────
//
// Why discriminated unions and not `z.record(z.string(), z.string())`:
// every consumer of the vault looks up credentials by a *fixed* field
// name (e.g. tools call `vault.getKey("fal-ai", "key")`, the SMTP tool
// reads `host/port/user/pass/from`, IMAP reads `host/port/user/pass`,
// and so on). If callers stored the field under a different name —
// `api_key` instead of `key`, say — the lookup silently returned
// `undefined` and the user only found out when a tool failed at
// runtime with "Missing environment variable". Previously the schema
// allowed this; now we reject the request up front with a clear
// validation error.
//
// "custom" is the escape hatch for arbitrary key-value bags that
// don't fit any of the typed shapes — for those the user is on their
// own to remember the field names.

const ApiKeyCredentialsSchema = z.object({
  key: z.string().min(1).describe("The API key value (must be named exactly `key`)"),
}).strict();

const SmtpCredentialsSchema = z.object({
  host: z.string().min(1),
  port: z.string().regex(/^\d+$/, "port must be a numeric string").describe("Port as string, e.g. \"587\""),
  user: z.string().min(1),
  pass: z.string().min(1),
  from: z.string().min(1).describe("From address — usually an email"),
  secure: z.enum(["true", "false", "1", "0"]).optional(),
}).strict();

const ImapCredentialsSchema = z.object({
  host: z.string().min(1),
  port: z.string().regex(/^\d+$/, "port must be a numeric string"),
  user: z.string().min(1),
  pass: z.string().min(1),
  tls: z.enum(["true", "false", "1", "0"]).optional(),
}).strict();

// OAuth shapes vary widely by provider; we require at least an
// access_token but allow extra fields with `.passthrough()` so
// provider-specific keys (id_token, expires_at, scope, etc.) survive.
const OauthCredentialsSchema = z.object({
  access_token: z.string().min(1).describe("OAuth access token"),
  refresh_token: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  expires_at: z.string().optional(),
  scope: z.string().optional(),
}).passthrough();

const LoginCredentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
}).strict();

const CustomCredentialsSchema = z.record(z.string(), z.string()).refine(
  (r) => Object.keys(r).length > 0,
  { message: "credentials must have at least one field" },
);

// ─── Discriminated body schemas ─────────────────────

/** POST /vault/entries body — all credential fields required per type. */
const SaveVaultEntryBody = z.discriminatedUnion("type", [
  z.object({
    agent:   z.string().min(1).describe("Agent name"),
    service: z.string().min(1).describe("Service name (vault key)"),
    label:   z.string().optional().describe("Human-readable label"),
    type:    z.literal("api_key"),
    credentials: ApiKeyCredentialsSchema,
  }),
  z.object({
    agent:   z.string().min(1),
    service: z.string().min(1),
    label:   z.string().optional(),
    type:    z.literal("smtp"),
    credentials: SmtpCredentialsSchema,
  }),
  z.object({
    agent:   z.string().min(1),
    service: z.string().min(1),
    label:   z.string().optional(),
    type:    z.literal("imap"),
    credentials: ImapCredentialsSchema,
  }),
  z.object({
    agent:   z.string().min(1),
    service: z.string().min(1),
    label:   z.string().optional(),
    type:    z.literal("oauth"),
    credentials: OauthCredentialsSchema,
  }),
  z.object({
    agent:   z.string().min(1),
    service: z.string().min(1),
    label:   z.string().optional(),
    type:    z.literal("login"),
    credentials: LoginCredentialsSchema,
  }),
  z.object({
    agent:   z.string().min(1),
    service: z.string().min(1),
    label:   z.string().optional(),
    type:    z.literal("custom"),
    credentials: CustomCredentialsSchema,
  }),
]);

/**
 * PATCH /vault/entries/{agent}/{service} body.
 *
 * `type` must be provided so the schema knows which credential shape
 * to validate. `credentials` is partial (each field optional) since
 * patches merge — but the field NAMES must still match the type's
 * schema. `label` can be updated independently.
 */
const PatchVaultEntryBody = z.discriminatedUnion("type", [
  z.object({
    type:        z.literal("api_key"),
    label:       z.string().optional(),
    credentials: ApiKeyCredentialsSchema.partial().optional(),
  }),
  z.object({
    type:        z.literal("smtp"),
    label:       z.string().optional(),
    credentials: SmtpCredentialsSchema.partial().optional(),
  }),
  z.object({
    type:        z.literal("imap"),
    label:       z.string().optional(),
    credentials: ImapCredentialsSchema.partial().optional(),
  }),
  z.object({
    type:        z.literal("oauth"),
    label:       z.string().optional(),
    credentials: OauthCredentialsSchema.partial().optional(),
  }),
  z.object({
    type:        z.literal("login"),
    label:       z.string().optional(),
    credentials: LoginCredentialsSchema.partial().optional(),
  }),
  z.object({
    type:        z.literal("custom"),
    label:       z.string().optional(),
    credentials: CustomCredentialsSchema.optional(),
  }),
]);

export function vaultRoutes(getDeps: () => { vaultStore?: any }): OpenAPIHono {
  const app = new OpenAPIHono();

  // POST /vault/entries — save a vault entry
  const saveEntryRoute = createRoute({
    method: "post",
    path: "/entries",
    tags: ["Vault"],
    summary: "Save vault entry",
    description: "Save credentials to the encrypted vault store. Credentials are encrypted at rest (AES-256-GCM) and never logged or persisted in chat history.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: SaveVaultEntryBody,
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              data: z.object({
                agent: z.string(),
                service: z.string(),
                type: z.string(),
                keys: z.array(z.string()),
              }),
            }),
          },
        },
        description: "Vault entry saved successfully",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(saveEntryRoute, async (c) => {
    const { vaultStore } = getDeps();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }

    const body = c.req.valid("json");
    const entry: VaultEntry = {
      type: body.type,
      ...(body.label ? { label: body.label } : {}),
      credentials: body.credentials as Record<string, string>,
    };

    await vaultStore.set(body.agent, body.service, entry);

    // Return only metadata — NEVER return credential values
    return c.json({
      ok: true,
      data: {
        agent: body.agent,
        service: body.service,
        type: body.type,
        keys: Object.keys(body.credentials),
      },
    }, 200);
  });

  // GET /vault/entries/:agent — list vault entries (metadata only, no credential values)
  const listEntriesRoute = createRoute({
    method: "get",
    path: "/entries/{agent}",
    tags: ["Vault"],
    summary: "List vault entries",
    description: "Returns metadata (service name, type, label, credential key names) without any secret values.",
    request: {
      params: z.object({
        agent: z.string(),
      }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              data: z.array(z.object({
                service: z.string(),
                type: z.enum(["smtp", "imap", "oauth", "api_key", "login", "custom"]),
                label: z.string().optional(),
                keys: z.array(z.string()),
              })),
            }),
          },
        },
        description: "Vault entries metadata for the agent",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(listEntriesRoute, async (c) => {
    const { vaultStore } = getDeps();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }

    const { agent } = c.req.valid("param");
    const entries = await vaultStore.list(agent);
    return c.json({ ok: true, data: entries }, 200);
  });

  // PATCH /vault/entries/:agent/:service — partially update credentials
  const patchEntryRoute = createRoute({
    method: "patch",
    path: "/entries/{agent}/{service}",
    tags: ["Vault"],
    summary: "Update vault credentials",
    description: "Partially update credential fields in an existing vault entry. Only the provided fields are merged — existing fields are preserved. Optionally update type and label.",
    request: {
      params: z.object({
        agent: z.string(),
        service: z.string(),
      }),
      body: {
        content: {
          "application/json": {
            schema: PatchVaultEntryBody,
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              data: z.object({
                agent: z.string(),
                service: z.string(),
                type: z.string(),
                keys: z.array(z.string()),
              }),
            }),
          },
        },
        description: "Vault entry updated successfully",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault entry not found",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(patchEntryRoute, async (c) => {
    const { vaultStore } = getDeps();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }

    const { agent, service } = c.req.valid("param");
    const existing = await vaultStore.get(agent, service);
    if (!existing) {
      return c.json({ ok: false, error: `No vault entry "${service}" for agent "${agent}".` }, 404);
    }

    const body = c.req.valid("json");
    const mergedKeys = await vaultStore.patch(agent, service, {
      type: body.type,
      label: body.label,
      credentials: body.credentials,
    });

    const updated = (await vaultStore.get(agent, service))!;
    return c.json({
      ok: true,
      data: {
        agent,
        service,
        type: updated.type,
        keys: mergedKeys,
      },
    }, 200);
  });

  // DELETE /vault/entries/:agent/:service — remove a vault entry
  const deleteEntryRoute = createRoute({
    method: "delete",
    path: "/entries/{agent}/{service}",
    tags: ["Vault"],
    summary: "Remove vault entry",
    request: {
      params: z.object({
        agent: z.string(),
        service: z.string(),
      }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ removed: z.boolean() }) }) } },
        description: "Result",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(deleteEntryRoute, async (c) => {
    const { vaultStore } = getDeps();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available." }, 503);
    }

    const { agent, service } = c.req.valid("param");
    const removed = await vaultStore.remove(agent, service);
    return c.json({ ok: true, data: { removed } }, 200);
  });

  return app;
}
