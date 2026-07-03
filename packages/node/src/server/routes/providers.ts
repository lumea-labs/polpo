import { resolve } from "node:path";
import { getPolpoDir } from "../../core/constants.js";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROVIDER_ENV_MAP, listModels } from "../../llm/pi-client.js";
import {
  detectProviders,
  persistToEnvFile,
  removeFromEnvFile,
} from "../../setup/index.js";

// ── Route definitions ─────────────────────────────────────────────

const listProvidersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Providers"],
  summary: "List all LLM providers with credential status",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.array(z.object({
              name: z.string(),
              envVar: z.string().optional(),
              hasKey: z.boolean(),
              source: z.enum(["env", "none"]),
            })),
          }),
        },
      },
      description: "Provider list with credential status",
    },
  },
});

const allModelsRoute = createRoute({
  method: "get",
  path: "/models",
  tags: ["Providers"],
  summary: "List all available models, optionally filtered by provider",
  request: {
    query: z.object({ provider: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }),
        },
      },
      description: "Model list",
    },
  },
});

const providerModelsRoute = createRoute({
  method: "get",
  path: "/{name}/models",
  tags: ["Providers"],
  summary: "List models for a specific provider",
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }),
        },
      },
      description: "Provider models",
    },
  },
});

const saveApiKeyRoute = createRoute({
  method: "post",
  path: "/{name}/api-key",
  tags: ["Providers"],
  summary: "Save an API key for a provider",
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            apiKey: z.string(),
            workDir: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.object({ message: z.string() }) }),
        },
      },
      description: "API key saved",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Unknown provider",
    },
  },
});

const deleteApiKeyRoute = createRoute({
  method: "delete",
  path: "/{name}/api-key",
  tags: ["Providers"],
  summary: "Remove an API key for a provider",
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ workDir: z.string().optional() }).optional(),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.object({ message: z.string() }) }),
        },
      },
      description: "API key removed",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Unknown provider",
    },
  },
});

const disconnectRoute = createRoute({
  method: "delete",
  path: "/{name}/disconnect",
  tags: ["Providers"],
  summary: "Disconnect a provider — removes API key",
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ workDir: z.string().optional() }).optional(),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), data: z.object({ message: z.string() }) }),
        },
      },
      description: "Provider disconnected",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), error: z.string() }),
        },
      },
      description: "Unknown provider",
    },
  },
});

// ── Route handlers ──────────────────────────────────────────────────

/**
 * Provider management routes — always available.
 * Auth is handled by the middleware in app.ts (conditional on setup mode).
 */
export function providerRoutes(polpoDir: string): OpenAPIHono {
  const app = new OpenAPIHono();

  // ── Static paths first (before /:name wildcard) ──

  // GET /providers
  app.openapi(listProvidersRoute, (c) => {
    return c.json({ ok: true, data: detectProviders() });
  });

  // GET /providers/models
  app.openapi(allModelsRoute, (c) => {
    const provider = c.req.query("provider");
    const models = listModels(provider || undefined)
      .sort((a, b) => a.cost.input - b.cost.input);
    return c.json({ ok: true, data: models });
  });

  // ── Dynamic /:name paths ──

  // GET /providers/:name/models
  app.openapi(providerModelsRoute, (c: any) => {
    const { name } = c.req.valid("param");
    const models = listModels(name).sort((a, b) => a.cost.input - b.cost.input);
    return c.json({ ok: true, data: models });
  });

  // POST /providers/:name/api-key
  app.openapi(saveApiKeyRoute, (c: any) => {
    const { name } = c.req.valid("param");
    const { apiKey, workDir: bodyWorkDir } = c.req.valid("json");
    const envVar = PROVIDER_ENV_MAP[name];
    if (!envVar) return c.json({ ok: false, error: `Unknown provider: ${name}` }, 400);

    process.env[envVar] = apiKey;
    const targetDir = bodyWorkDir ? getPolpoDir(resolve(bodyWorkDir)) : polpoDir;
    persistToEnvFile(targetDir, envVar, apiKey);

    return c.json({ ok: true, data: { message: `${envVar} saved to .polpo/.env` } });
  });

  // DELETE /providers/:name/api-key
  app.openapi(deleteApiKeyRoute, (c: any) => {
    const { name } = c.req.valid("param");
    let bodyWorkDir: string | undefined;
    try {
      const body = c.req.valid("json");
      bodyWorkDir = body?.workDir;
    } catch { /* no body is fine for DELETE */ }

    const envVar = PROVIDER_ENV_MAP[name];
    if (!envVar) return c.json({ ok: false, error: `Unknown provider: ${name}` }, 400);

    delete process.env[envVar];
    const targetDir = bodyWorkDir ? getPolpoDir(resolve(bodyWorkDir)) : polpoDir;
    removeFromEnvFile(targetDir, envVar);

    return c.json({ ok: true, data: { message: `${envVar} removed` } });
  });

  // DELETE /providers/:name/disconnect — remove env key
  app.openapi(disconnectRoute, async (c: any) => {
    const { name } = c.req.valid("param");
    let bodyWorkDir: string | undefined;
    try {
      const body = c.req.valid("json");
      bodyWorkDir = body?.workDir;
    } catch { /* no body is fine for DELETE */ }

    const actions: string[] = [];

    // Remove env var from process + .env file
    const envVar = PROVIDER_ENV_MAP[name];
    if (envVar && process.env[envVar]) {
      delete process.env[envVar];
      const targetDir = bodyWorkDir ? getPolpoDir(resolve(bodyWorkDir)) : polpoDir;
      removeFromEnvFile(targetDir, envVar);
      actions.push("API key removed");
    }

    return c.json({
      ok: true,
      data: { message: actions.length > 0 ? actions.join(", ") : "No credentials found" },
    });
  });

  return app;
}
