import type { Context } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { DataError, type DataService } from "@polpo-ai/core/data";
import { registerDataOpenApi } from "./data-openapi.js";

export type DataServiceResolver = (
  request: Request,
) => DataService | Promise<DataService>;
/** The host authenticates requests and resolves grants afresh before each operation. */
export function dataRoutes(resolve: DataServiceResolver): OpenAPIHono {
  const app = new OpenAPIHono();
  registerDataOpenApi(app);
  app.use(
    "*",
    bodyLimit({
      maxSize: 262144,
      onError: (c) =>
        c.json(
          {
            ok: false,
            code: "data_limit",
            error: "Data request exceeds 256 KiB",
          },
          413,
        ),
    }),
  );
  app.onError((error, c) => {
    const known = error instanceof DataError;
    const code = known ? error.code : "data_unavailable";
    const statuses = {
      data_invalid: 400,
      data_forbidden: 403,
      data_not_found: 404,
      data_conflict: 409,
      data_constraint: 422,
      data_limit: 413,
      data_unavailable: 503,
    } as const;
    return c.json(
      {
        ok: false,
        code,
        error: known ? error.message : "Data service unavailable",
      },
      statuses[code],
    );
  });
  const body = async (c: Context) => {
    try {
      return await c.req.json();
    } catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError")
        throw error;
      throw new DataError("data_invalid", "Expected a JSON request body");
    }
  };
  app.get("/", async (c) =>
    c.json({ ok: true, data: await (await resolve(c.req.raw)).list() }),
  );
  app.post("/", async (c) => {
    const input = await body(c);
    return c.json(
      { ok: true, data: await (await resolve(c.req.raw)).create(input) },
      201,
    );
  });
  app.get("/:resource", async (c) =>
    c.json({
      ok: true,
      data: await (await resolve(c.req.raw)).describe(c.req.param("resource")),
    }),
  );
  app.patch("/:resource", async (c) => {
    const input = await body(c);
    return c.json({
      ok: true,
      data: await (
        await resolve(c.req.raw)
      ).rename(c.req.param("resource"), input),
    });
  });
  app.put("/:resource/schema", async (c) => {
    const input = await body(c);
    return c.json({
      ok: true,
      data: await (
        await resolve(c.req.raw)
      ).migrate(c.req.param("resource"), input),
    });
  });
  app.delete("/:resource", async (c) => {
    const version = c.req.query("expectedVersion");
    if (!version || !/^[1-9][0-9]*$/.test(version))
      throw new DataError("data_invalid", "expectedVersion is required");
    await (
      await resolve(c.req.raw)
    ).remove(c.req.param("resource"), Number(version));
    return c.json({ ok: true, data: { deleted: true } });
  });
  app.post("/:resource/transactions", async (c) => {
    const input = await body(c);
    return c.json({
      ok: true,
      data: await (
        await resolve(c.req.raw)
      ).execute(c.req.param("resource"), input),
    });
  });
  app.post("/:resource/query", async (c) => {
    const input = await body(c);
    return c.json({
      ok: true,
      data: await (
        await resolve(c.req.raw)
      ).query(c.req.param("resource"), input),
    });
  });
  app.get("/:resource/migrations", async (c) =>
    c.json({
      ok: true,
      data: await (
        await resolve(c.req.raw)
      ).migrations(c.req.param("resource")),
    }),
  );
  app.post("/:resource/migrations", async (c) => {
    const input = await body(c);
    return c.json({
      ok: true,
      data: await (
        await resolve(c.req.raw)
      ).migrateSql(c.req.param("resource"), input),
    });
  });
  return app;
}
