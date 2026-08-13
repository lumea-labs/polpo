import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import {
  CUSTOM_TOOL_NAME_RE,
  createSingleFileCustomToolArtifact,
  customToolArtifactEntrySource,
  parseCustomToolSourceArtifact,
  type CustomToolMeta,
  type CustomToolSourceArtifact,
  type CustomToolsStore,
} from "@polpo-ai/tools";

export interface CustomToolDeployProgress {
  step: "detect" | "install" | "bundle" | "validate" | "deployed" | "done" | "error";
  detail?: string;
  log?: string;
}

export interface CustomToolDeployResult {
  errors: string[];
  meta?: CustomToolMeta;
  bundle?: string;
  deps?: string[];
  skipped?: boolean;
}

export interface CustomToolDeployer {
  deploy(
    name: string,
    source: string,
    onProgress?: (progress: CustomToolDeployProgress) => void,
  ): Promise<CustomToolDeployResult>;
  deployArtifact?(
    name: string,
    artifact: CustomToolSourceArtifact,
    onProgress?: (progress: CustomToolDeployProgress) => void,
  ): Promise<CustomToolDeployResult>;
}

export interface CustomToolRunner {
  run(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface CustomToolRouteDeps {
  store: CustomToolsStore;
  deployer?: CustomToolDeployer;
  runner?: CustomToolRunner;
  generateTests?: (name: string, source: string) => Promise<unknown>;
  generateExample?: (name: string, source: string) => Promise<Record<string, unknown>>;
}

type StoredSnapshot = {
  artifact: CustomToolSourceArtifact | null;
  meta: CustomToolMeta | null;
  bundle: string | null;
};

async function snapshot(store: CustomToolsStore, name: string): Promise<StoredSnapshot> {
  const [artifact, meta, bundle] = await Promise.all([
    store.getArtifact(name),
    store.getMeta(name),
    store.getBundle(name),
  ]);
  return { artifact, meta, bundle };
}

async function restore(store: CustomToolsStore, name: string, previous: StoredSnapshot) {
  await store.remove(name);
  if (previous.artifact === null) return;
  await store.putArtifact(name, previous.artifact);
  if (previous.meta) await store.putMeta(name, previous.meta);
  if (previous.bundle) await store.putBundle(name, previous.bundle);
}

type ValidatedInput = {
  name: string;
  source: string;
  artifact: CustomToolSourceArtifact;
};

function validateInput(body: unknown): ValidatedInput | { error: string; code: string } {
  const input = body as { name?: unknown; source?: unknown; artifact?: unknown } | null;
  if (typeof input?.name !== "string" || !CUSTOM_TOOL_NAME_RE.test(input.name)) {
    return {
      error: "`name` is required and must be snake_case (lowercase letters, digits, underscores; starting with a letter)",
      code: "invalid_name",
    };
  }
  if (input.source !== undefined && input.artifact !== undefined) {
    return { error: "Provide either `source` or `artifact`, not both", code: "ambiguous_source" };
  }
  if (input.artifact !== undefined) {
    try {
      const artifact = parseCustomToolSourceArtifact(input.artifact);
      return {
        name: input.name,
        source: customToolArtifactEntrySource(artifact),
        artifact,
      };
    } catch (error) {
      return { error: (error as Error).message, code: "invalid_artifact" };
    }
  }
  if (typeof input.source !== "string" || input.source.trim().length === 0) {
    return {
      error: "`source` or `artifact` is required",
      code: "invalid_source",
    };
  }
  return {
    name: input.name,
    source: input.source,
    artifact: createSingleFileCustomToolArtifact(input.name, input.source),
  };
}

function deployArtifact(
  deployer: CustomToolDeployer,
  input: ValidatedInput,
  onProgress?: (progress: CustomToolDeployProgress) => void,
): Promise<CustomToolDeployResult> {
  if (deployer.deployArtifact) {
    return deployer.deployArtifact(input.name, input.artifact, onProgress);
  }
  if (Object.keys(input.artifact.files).length > 1) {
    return Promise.resolve({
      errors: ["This runtime does not support multi-file custom tools"],
    });
  }
  return deployer.deploy(input.name, input.source, onProgress);
}

/**
 * Host-neutral custom-tool API. Authentication, tenancy, storage and execution
 * are supplied by the composition root.
 */
export function customToolRoutes(
  getDeps: (context: unknown) => CustomToolRouteDeps,
): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const { store } = getDeps(c);
    const names = await store.list();
    const data = await Promise.all(
      names.map(async (name) => ({
        name,
        description: (await store.getMeta(name))?.description ?? null,
      })),
    );
    return c.json({ ok: true, data });
  });

  app.post("/", async (c) => {
    const input = validateInput(await c.req.json().catch(() => null));
    if ("error" in input) return c.json(input, 400);

    const deps = getDeps(c);
    const previous = await snapshot(deps.store, input.name);
    await deps.store.putArtifact(input.name, input.artifact);
    if (!deps.deployer) {
      return c.json({ ok: true, data: { name: input.name, validated: false, bundled: false } }, 201);
    }

    try {
      const result = await deployArtifact(deps.deployer, input);
      if (result.errors.length > 0) {
        await restore(deps.store, input.name, previous);
        return c.json({ error: "Tool failed to deploy", code: "invalid_tool", details: result.errors }, 400);
      }
      if (result.meta) await deps.store.putMeta(input.name, result.meta);
      if (result.bundle) await deps.store.putBundle(input.name, result.bundle);
      return c.json({
        ok: true,
        data: {
          name: input.name,
          validated: !!result.meta,
          bundled: !!result.bundle,
          skipped: !!result.skipped,
        },
      }, 201);
    } catch (error) {
      await restore(deps.store, input.name, previous);
      throw error;
    }
  });

  app.post("/:name/deploy", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => null);
    const input = validateInput({
      name,
      source: body?.source,
      artifact: body?.artifact,
    });
    if ("error" in input) return c.json(input, 400);

    const deps = getDeps(c);
    if (!deps.deployer) return c.json({ error: "Deploy not available", code: "no_deployer" }, 503);
    const previous = await snapshot(deps.store, name);
    await deps.store.putArtifact(name, input.artifact);

    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      const send = (event: string, data: unknown) => {
        writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
        return writes;
      };
      try {
        const result = await deployArtifact(deps.deployer!, input, (progress) => {
          void send("progress", progress);
        });
        if (result.errors.length > 0) {
          await restore(deps.store, name, previous);
          await send("error", { errors: result.errors });
          return;
        }
        if (result.meta) await deps.store.putMeta(name, result.meta);
        if (result.bundle) await deps.store.putBundle(name, result.bundle);
        await send("done", {
          name,
          bundled: !!result.bundle,
          deps: result.deps ?? [],
          skipped: !!result.skipped,
        });
      } catch (error) {
        await restore(deps.store, name, previous).catch(() => undefined);
        await send("error", { errors: [(error as Error).message] });
      }
    });
  });

  app.get("/:name", async (c) => {
    const name = c.req.param("name");
    if (!CUSTOM_TOOL_NAME_RE.test(name)) return c.json({ error: "Invalid tool name", code: "invalid_name" }, 400);
    const { store } = getDeps(c);
    const artifact = await store.getArtifact(name);
    if (artifact === null) return c.json({ error: "Tool not found", code: "not_found" }, 404);
    return c.json({
      ok: true,
      data: {
        name,
        source: customToolArtifactEntrySource(artifact),
        artifact,
        meta: await store.getMeta(name),
      },
    });
  });

  app.post("/:name/run", async (c) => {
    const name = c.req.param("name");
    const deps = getDeps(c);
    if (!(await deps.store.has(name))) return c.json({ error: "Tool not found", code: "not_found" }, 404);
    if (!deps.runner) return c.json({ error: "Tool execution not available", code: "no_runner" }, 503);
    const body = await c.req.json().catch(() => ({}));
    try {
      const data = await deps.runner.run(name, (body?.args ?? {}) as Record<string, unknown>);
      return c.json({ ok: true, data });
    } catch (error) {
      return c.json({ error: (error as Error).message, code: "run_failed" }, 502);
    }
  });

  app.post("/:name/generate", async (c) => {
    const name = c.req.param("name");
    const deps = getDeps(c);
    const source = await deps.store.getSource(name);
    if (source === null) return c.json({ error: "Tool not found", code: "not_found" }, 404);
    if (!deps.generateTests) return c.json({ error: "Generation not available", code: "no_generator" }, 503);
    try {
      return c.json({ ok: true, data: await deps.generateTests(name, source) });
    } catch (error) {
      return c.json({ error: (error as Error).message, code: "generate_failed" }, 502);
    }
  });

  app.post("/:name/example", async (c) => {
    const name = c.req.param("name");
    const deps = getDeps(c);
    const source = await deps.store.getSource(name);
    if (source === null) return c.json({ error: "Tool not found", code: "not_found" }, 404);
    if (!deps.generateExample) return c.json({ error: "Example generation not available", code: "no_generator" }, 503);
    try {
      return c.json({ ok: true, data: { args: await deps.generateExample(name, source) } });
    } catch (error) {
      return c.json({ error: (error as Error).message, code: "example_failed" }, 502);
    }
  });

  app.delete("/:name", async (c) => {
    const name = c.req.param("name");
    const existed = await getDeps(c).store.remove(name);
    if (!existed) return c.json({ error: "Tool not found", code: "not_found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
