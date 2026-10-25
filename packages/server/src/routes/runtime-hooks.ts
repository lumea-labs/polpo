import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  HookConfigError,
  PORTABLE_HOOK_CAPABILITIES,
  validateHookPack,
  type HookCapabilities,
  type HookPackStore,
} from "@polpo-ai/core/runtime-hooks";

export interface RuntimeHookRouteDeps {
  store?: HookPackStore;
  capabilities?: HookCapabilities | (() => HookCapabilities | Promise<HookCapabilities>);
}

const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
// Structural envelope only; validateHookPack enforces the Claude Code contract.
const hookPackSchema = z.object({
  name: nameSchema,
  description: z.string().optional(),
  hooks: z.unknown(),
}).passthrough();
const responseSchema = z.object({ ok: z.literal(true), data: z.unknown() });
const errorSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.string() });

const listRoute = createRoute({
  method: "get", path: "/", tags: ["Hooks"], summary: "List runtime hook packs",
  responses: { 200: { content: { "application/json": { schema: responseSchema } }, description: "Hook packs" }, 501: { content: { "application/json": { schema: errorSchema } }, description: "Unavailable" } },
});
const capabilitiesRoute = createRoute({
  method: "get", path: "/capabilities", tags: ["Hooks"], summary: "Get runtime hook capabilities",
  responses: { 200: { content: { "application/json": { schema: responseSchema } }, description: "Runtime hook contract capabilities" } },
});
const getRoute = createRoute({
  method: "get", path: "/{name}", tags: ["Hooks"], summary: "Get a runtime hook pack",
  request: { params: z.object({ name: nameSchema }) },
  responses: { 200: { content: { "application/json": { schema: responseSchema } }, description: "Hook pack" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" }, 501: { content: { "application/json": { schema: errorSchema } }, description: "Unavailable" } },
});
const putRoute = createRoute({
  method: "put", path: "/{name}", tags: ["Hooks"], summary: "Create or replace a runtime hook pack",
  request: { params: z.object({ name: nameSchema }), body: { content: { "application/json": { schema: hookPackSchema } } } },
  responses: { 200: { content: { "application/json": { schema: responseSchema } }, description: "Stored" }, 400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid pack" }, 501: { content: { "application/json": { schema: errorSchema } }, description: "Unavailable" } },
});
const deleteRoute = createRoute({
  method: "delete", path: "/{name}", tags: ["Hooks"], summary: "Delete a runtime hook pack",
  request: { params: z.object({ name: nameSchema }) },
  responses: { 200: { content: { "application/json": { schema: responseSchema } }, description: "Deleted" }, 404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" }, 501: { content: { "application/json": { schema: errorSchema } }, description: "Unavailable" } },
});

export function runtimeHookRoutes(getDeps: () => RuntimeHookRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const unavailable = (c: any) => c.json({ ok: false, error: "Runtime hook storage is not configured", code: "HOOKS_UNAVAILABLE" }, 501);
  app.openapi(listRoute, async (c: any) => {
    const store = getDeps().store;
    if (!store) return unavailable(c);
    return c.json({ ok: true, data: await store.list() }, 200);
  });
  app.openapi(capabilitiesRoute, async (c: any) => {
    const configured = getDeps().capabilities;
    const capabilities = typeof configured === "function"
      ? await configured()
      : configured ?? PORTABLE_HOOK_CAPABILITIES;
    return c.json({ ok: true, data: capabilities }, 200);
  });
  app.openapi(getRoute, async (c: any) => {
    const store = getDeps().store;
    if (!store) return unavailable(c);
    const pack = await store.get(c.req.valid("param").name);
    if (!pack) return c.json({ ok: false, error: "Runtime hook pack not found", code: "HOOK_NOT_FOUND" }, 404);
    return c.json({ ok: true, data: pack }, 200);
  });
  app.openapi(putRoute, async (c: any) => {
    const store = getDeps().store;
    if (!store) return unavailable(c);
    const name = c.req.valid("param").name;
    try {
      const pack = validateHookPack(c.req.valid("json"));
      if (pack.name !== name) return c.json({ ok: false, error: "Hook pack name must match the URL", code: "INVALID_HOOK_PACK" }, 400);
      await store.put(pack);
      return c.json({ ok: true, data: pack }, 200);
    } catch (error) {
      if (!(error instanceof HookConfigError)) throw error;
      return c.json({ ok: false, error: error.message, code: "INVALID_HOOK_PACK" }, 400);
    }
  });
  app.openapi(deleteRoute, async (c: any) => {
    const store = getDeps().store;
    if (!store) return unavailable(c);
    const deleted = await store.delete(c.req.valid("param").name);
    if (!deleted) return c.json({ ok: false, error: "Runtime hook pack not found", code: "HOOK_NOT_FOUND" }, 404);
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });
  return app;
}
