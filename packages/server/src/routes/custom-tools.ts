import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import {
  CUSTOM_TOOL_NAME_RE,
  CustomToolBusyError,
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

/** The caller retains mutation ownership through publication and rollback.
 * This compensates failed writes; it is not an atomic filesystem transaction. */
async function publish(store: CustomToolsStore, input: ValidatedInput, result: CustomToolDeployResult) {
  const previous = await snapshot(store, input.name);
  try {
    await store.remove(input.name);
    await store.putArtifact(input.name, input.artifact);
    if (result.meta) await store.putMeta(input.name, result.meta);
    if (result.bundle) await store.putBundle(input.name, result.bundle);
  } catch (error) {
    await restore(store, input.name, previous);
    throw error;
  }
}

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
    try {
      return await deps.store.withMutation(input.name, async () => {
        // Validation receives the candidate directly. It must not expose
        // unvalidated source to agents or replace a working deployment.
        const result = deps.deployer ? await deployArtifact(deps.deployer, input) : { errors: [] };
        if (result.errors.length > 0) {
          return c.json({ error: "Tool failed to deploy", code: "invalid_tool", details: result.errors }, 400);
        }
        await publish(deps.store, input, result);
        return c.json({
          ok: true,
          data: { name: input.name, validated: !!result.meta, bundled: !!result.bundle, skipped: !!result.skipped },
        }, 201);
      });
    } catch (error) {
      if (error instanceof CustomToolBusyError) return c.json({ error: error.message, code: error.code }, 409);
      throw error;
    }
  });

  app.post("/:name/deploy", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => null);
    const input = validateInput({ name, source: body?.source, artifact: body?.artifact });
    if ("error" in input) return c.json(input, 400);
    const deps = getDeps(c);
    if (!deps.deployer) return c.json({ error: "Deploy not available", code: "no_deployer" }, 503);

    // Claim ownership before returning SSE, and keep it until the actual work
    // finishes even when the client stops consuming the response.
    let begin!: (output: (event: string, data: unknown) => Promise<void>) => void;
    const output = new Promise<(event: string, data: unknown) => Promise<void>>(resolve => { begin = resolve; });
    let admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const work = deps.store.withMutation(name, async () => {
      admitted();
      const send = await output;
      try {
        const result = await deployArtifact(deps.deployer!, input, progress => { void send("progress", progress); });
        if (result.errors.length > 0) { await send("error", { errors: result.errors }); return; }
        await publish(deps.store, input, result);
        await send("done", { name, bundled: !!result.bundle, deps: result.deps ?? [], skipped: !!result.skipped });
      } catch (error) {
        await send("error", { errors: [(error as Error).message] });
      }
    });
    try { await Promise.race([admission, work]); }
    catch (error) {
      if (error instanceof CustomToolBusyError) return c.json({ error: error.message, code: error.code }, 409);
      throw error;
    }
    return streamSSE(c, async stream => {
      let writes = Promise.resolve();
      begin((event, data) => {
        // A disconnected observer cannot roll back an already-published tool.
        writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined);
        return writes;
      });
      await work;
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
    if (!CUSTOM_TOOL_NAME_RE.test(name)) return c.json({ error: "Invalid tool name", code: "invalid_name" }, 400);
    const { store } = getDeps(c);
    try {
      const existed = await store.withMutation(name, () => store.remove(name));
      if (!existed) return c.json({ error: "Tool not found", code: "not_found" }, 404);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof CustomToolBusyError) return c.json({ error: error.message, code: error.code }, 409);
      throw error;
    }
  });

  return app;
}
