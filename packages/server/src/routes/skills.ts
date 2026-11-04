/**
 * Skill routes — discover, list, read, create, delete, assign/unassign.
 *
 * Uses FileSystem abstraction so it works on any backend:
 *   - NodeFileSystem (local)
 *   - SandboxProxyFS (remote, lazy)
 *
 * Install from GitHub (git clone) is NOT included — that's shell-specific
 * and stays in the root src/server/routes/skills.ts.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import { resolve, join, basename, dirname } from "node:path";
import type { FileSystem } from "@polpo-ai/core";
import type { Shell } from "@polpo-ai/core";
import {
  SkillBundleStoreConflictError,
  type SkillBundleStore,
  type StoredSkillBundle,
  type ValidatedSkillBundle,
} from "@polpo-ai/core";
import {
  decodeBase64,
  digestSkillBundle,
  validateSkillBundleFiles,
  validateSkillName,
  type SkillBundle,
  type SkillBundleFile,
} from "@polpo-ai/core/skill-bundle";
import {
  packSkillArchive,
  SKILL_ARCHIVE_MAX_COMPRESSED_BYTES,
  SkillArchiveError,
  unpackSkillArchive,
} from "@polpo-ai/core/skill-archive";
import { parseSkillManifest, type SkillManifest } from "@polpo-ai/core/skill-manifest";
// Dynamic import to work around workspace version resolution.
// At publish time, @polpo-ai/core@^0.3.5 will be resolved correctly.
// @ts-ignore — resolved at publish time with @polpo-ai/core@^0.3.5
const coreImport = (): Promise<any> => import("@polpo-ai/core");

// Types inlined — mirror @polpo-ai/core/skills-reader types.
interface SkillInfo {
  name: string;
  description: string;
  allowedTools?: string[];
  source: "project" | "global";
  path: string;
  tags?: string[];
  category?: string;
}

interface LoadedSkill extends SkillInfo {
  content: string;
}

const skillBundleFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.literal("base64"),
});

function bytesAsUtf8(bytes: Uint8Array, filePath: string): string {
  const text = new TextDecoder().decode(bytes);
  const encoded = new TextEncoder().encode(text);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) {
    throw new Error(`FileSystem requires binary read/write support for ${filePath}`);
  }
  return text;
}

async function readBundleFile(fs: FileSystem, filePath: string): Promise<Uint8Array> {
  if (fs.readFileBuffer) return fs.readFileBuffer(filePath);
  return new TextEncoder().encode(await fs.readFile(filePath));
}

async function writeBundleFile(fs: FileSystem, filePath: string, bytes: Uint8Array): Promise<void> {
  if (fs.writeFileBuffer) {
    await fs.writeFileBuffer(filePath, bytes);
    return;
  }
  await fs.writeFile(filePath, bytesAsUtf8(bytes, filePath));
}

async function readSkillBundle(fs: FileSystem, root: string, name: string): Promise<SkillBundle> {
  const files: SkillBundleFile[] = [];

  async function walk(directory: string, relativeDirectory = ""): Promise<void> {
    const entries = fs.readdirWithTypes
      ? await fs.readdirWithTypes(directory)
      : await Promise.all((await fs.readdir(directory)).map(async (entryName) => {
          const stat = await fs.stat(join(directory, entryName));
          return { name: entryName, isDirectory: stat.isDirectory, isFile: stat.isFile };
        }));

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile) {
        const bytes = await readBundleFile(fs, absolutePath);
        files.push({
          path: relativePath,
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
        });
      } else {
        throw new Error(`Skill bundle contains an unsupported filesystem entry: ${relativePath}`);
      }
    }
  }

  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const validationError = validateSkillBundleFiles(files);
  if (validationError) throw new Error(validationError);
  return { name, files };
}

async function writeSkillBundle(fs: FileSystem, root: string, files: readonly SkillBundleFile[]): Promise<void> {
  for (const file of files) {
    const destination = join(root, ...file.path.split("/"));
    await fs.mkdir(dirname(destination)).catch(() => {});
    const bytes = new Uint8Array(Buffer.from(file.content, "base64"));
    await writeBundleFile(fs, destination, bytes);
  }
}

async function replaceSkillBundle(
  fs: FileSystem,
  polpoDir: string,
  name: string,
  files: readonly SkillBundleFile[],
  finalize?: () => Promise<void>,
): Promise<void> {
  const target = join(polpoDir, "skills", name);
  const transactionRoot = join(polpoDir, ".skill-bundle-staging", `${name}-${randomUUID()}`);
  const staged = join(transactionRoot, "next");
  const backup = join(transactionRoot, "previous");
  const targetExists = await fs.exists(target);
  let preserveTransaction = false;

  try {
    await writeSkillBundle(fs, staged, files);
    await readSkillBundle(fs, staged, name);

    if (targetExists) await fs.rename(target, backup);
    try {
      await fs.rename(staged, target);
      await finalize?.();
    } catch (error) {
      try {
        if (await fs.exists(target)) await fs.remove(target);
        if (targetExists && await fs.exists(backup)) await fs.rename(backup, target);
      } catch (rollbackError) {
        preserveTransaction = true;
        throw new AggregateError(
          [error, rollbackError],
          `Could not replace or restore skill bundle ${name}; backup retained at ${backup}`,
        );
      }
      throw error;
    }

    if (await fs.exists(backup)) await fs.remove(backup).catch(() => {});
  } finally {
    if (!preserveTransaction && await fs.exists(transactionRoot)) {
      await fs.remove(transactionRoot).catch(() => {});
    }
  }
}

type SkillIndex = Record<string, { tags?: string[]; category?: string }>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const SKILL_ARCHIVE_DATA_URL_MIME_TYPES = new Set([
  "application/zip",
  "application/octet-stream",
  "application/x-zip-compressed",
]);

function decodeSkillArchiveDataUrl(source: string): Uint8Array | null {
  if (!/^data:/i.test(source)) return null;
  const match = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/i.exec(source);
  if (!match || !SKILL_ARCHIVE_DATA_URL_MIME_TYPES.has(match[1].toLowerCase())) {
    throw new SkillArchiveError(
      "invalid_archive",
      "Skill archive data URL must use a supported ZIP media type and base64 encoding",
    );
  }
  const encoded = match[2];
  const maxEncodedBytes = Math.ceil(SKILL_ARCHIVE_MAX_COMPRESSED_BYTES / 3) * 4;
  if (encoded.length === 0 || encoded.length > maxEncodedBytes) {
    throw new SkillArchiveError(
      "archive_limit_exceeded",
      "Skill archive compressed size is outside the supported limit",
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(encoded);
  } catch {
    throw new SkillArchiveError("invalid_archive", "Skill archive data URL contains invalid base64");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > SKILL_ARCHIVE_MAX_COMPRESSED_BYTES) {
    throw new SkillArchiveError(
      "archive_limit_exceeded",
      "Skill archive compressed size is outside the supported limit",
    );
  }
  return bytes;
}

// ── Dependencies ──

export interface SkillRouteDeps {
  polpoDir: string;
  /** FileSystem for CRUD on installed skills under `<polpoDir>/skills/*`. */
  fs: FileSystem;
  /** Shell for executing git clone (optional — install route disabled without it). */
  shell?: Shell;
  /** FileSystem used by the install route to scan the cloned repo in `/tmp`.
   *  Defaults to `fs` when the clone target shares the same namespace. */
  installFs?: FileSystem;
  getAgents: () => Promise<Array<{ name: string; skills?: string[] }>>;
  /** Update an agent's skills list. Used for assign/unassign. */
  updateAgentSkills?: (agentName: string, skills: string[]) => Promise<void>;
  /** Optional metadata index. When provided, list/install/remove mirror
   *  through it so GET /skills can answer from a fast lookup. */
  skillStore?: import("@polpo-ai/core").SkillStore;
  /** Optional content-addressed store. Managed hosts use this instead of
   *  emulating atomic directory renames on object storage. */
  skillBundleStore?: SkillBundleStore;
  /** Invalidate host runtime caches after a durable bundle mutation. */
  onSkillChanged?: (name: string, digest: string | null) => Promise<void> | void;
}

type ValidatedBundle = Omit<ValidatedSkillBundle, "source" | "uncompressedBytes"> & {
  bytes: number;
};

async function validateBundle(name: string, files: SkillBundleFile[]): Promise<ValidatedBundle> {
  const nameError = validateSkillName(name);
  if (nameError) throw new TypeError(nameError);
  const validationError = validateSkillBundleFiles(files);
  if (validationError) throw new TypeError(validationError);
  const skillFile = files.find((file) => file.path === "SKILL.md")!;
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(skillFile.content));
  } catch {
    throw new TypeError("SKILL.md must be valid UTF-8");
  }
  const parsed = parseSkillManifest(raw, { mode: "strict", directoryName: name });
  return {
    bundle: { name, files },
    manifest: parsed.manifest,
    digest: await digestSkillBundle({ name, files }),
    bytes: files.reduce((total, file) => total + decodeBase64(file.content).byteLength, 0),
  };
}

async function currentBundle(
  deps: SkillRouteDeps,
  name: string,
  digest?: string,
): Promise<{ bundle: SkillBundle; digest: string; stored?: StoredSkillBundle } | null> {
  if (deps.skillBundleStore) {
    const stored = await deps.skillBundleStore.get(name, digest);
    return stored ? { bundle: stored.bundle, digest: stored.digest, stored } : null;
  }
  if (digest !== undefined) return null;
  const target = join(deps.polpoDir, "skills", name);
  if (!(await deps.fs.exists(target))) return null;
  const bundle = await readSkillBundle(deps.fs, target, name);
  return { bundle, digest: await digestSkillBundle(bundle) };
}

async function persistValidatedBundle(
  deps: SkillRouteDeps,
  input: ValidatedBundle,
  options: { conflict: "error" | "replace"; source: string; expectedDigest?: string },
): Promise<{ receipt: Record<string, unknown>; created: boolean; conflict: boolean }> {
  const existing = await currentBundle(deps, input.bundle.name);
  if (existing?.digest === input.digest) {
    return {
      receipt: skillReceipt(input, options.source, false),
      created: false,
      conflict: false,
    };
  }
  if (options.expectedDigest !== undefined && existing?.digest !== options.expectedDigest) {
    return {
      receipt: {
        ...skillReceipt(input, options.source, false),
        ...(existing?.digest ? { currentDigest: existing.digest } : {}),
      },
      created: false,
      conflict: true,
    };
  }
  if (existing && options.conflict === "error") {
    return {
      receipt: {
        ...skillReceipt(input, options.source, false),
        currentDigest: existing.digest,
      },
      created: false,
      conflict: true,
    };
  }

  if (deps.skillBundleStore) {
    try {
      const receipt = await deps.skillBundleStore.put({
        bundle: input.bundle,
        manifest: input.manifest,
        digest: input.digest,
        uncompressedBytes: input.bytes,
        source: options.source,
      }, {
        conflict: options.conflict,
        ...(options.expectedDigest ? { expectedDigest: options.expectedDigest } : {}),
      });
      await deps.onSkillChanged?.(input.bundle.name, input.digest);
      return { receipt: { ...receipt }, created: !existing, conflict: false };
    } catch (error) {
      if (error instanceof SkillBundleStoreConflictError) {
        return {
          receipt: {
            ...skillReceipt(input, options.source, false),
            ...(error.currentDigest ? { currentDigest: error.currentDigest } : {}),
          },
          created: false,
          conflict: true,
        };
      }
      throw error;
    }
  }

  await replaceSkillBundle(
    deps.fs,
    deps.polpoDir,
    input.bundle.name,
    input.bundle.files,
    async () => {
      await deps.skillStore?.upsert({
        name: input.bundle.name,
        description: input.manifest.description,
        source: options.source,
        installedAt: new Date().toISOString(),
        allowedTools: input.manifest.allowedTools,
      });
    },
  );
  await deps.onSkillChanged?.(input.bundle.name, input.digest);
  return {
    receipt: skillReceipt(input, options.source, true),
    created: !existing,
    conflict: false,
  };
}

function skillReceipt(input: ValidatedBundle, source: string, changed: boolean): Record<string, unknown> {
  return {
    name: input.bundle.name,
    digest: input.digest,
    files: input.bundle.files.length,
    uncompressedBytes: input.bytes,
    changed,
    source,
    warnings: [],
  };
}

// ── Helpers ──

async function loadSkillIndex(fs: FileSystem, polpoDir: string): Promise<SkillIndex | null> {
  const indexPath = join(polpoDir, "skills-index.json");
  if (!(await fs.exists(indexPath))) return null;
  try {
    const raw = await fs.readFile(indexPath);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SkillIndex;
  } catch { return null; }
}

async function saveSkillIndex(fs: FileSystem, polpoDir: string, index: SkillIndex): Promise<void> {
  await fs.mkdir(polpoDir).catch(() => {});
  await fs.writeFile(join(polpoDir, "skills-index.json"), JSON.stringify(index, null, 2) + "\n");
}

async function loadSkillContent(fs: FileSystem, info: SkillInfo): Promise<LoadedSkill | null> {
  const skillPath = resolve(info.path, "SKILL.md");
  try {
    const raw = await fs.readFile(skillPath);
    const core = await coreImport();
    return { ...info, content: core.extractSkillBody(raw) };
  } catch { return null; }
}

// ── Route factory ──

export function skillRoutes(getDeps: () => SkillRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET / — list skills with assignments
  app.openapi(
    createRoute({
      method: "get", path: "/", tags: ["Skills"], summary: "List skills with agent assignments",
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } }, description: "Skills list" } },
    }),
    async (c) => {
      const { fs, polpoDir, getAgents, skillStore, skillBundleStore } = getDeps();
      const agents = await getAgents();
      const agentNames = agents.map((a) => a.name);
      const configSkills = new Map<string, string[]>();
      for (const a of agents) {
        if (a.skills?.length) configSkills.set(a.name, a.skills);
      }

      if (skillBundleStore) {
        const records = await skillBundleStore.list();
        const data = records.map((record) => ({
          name: record.name,
          description: record.description,
          source: "project" as const,
          path: record.root ?? resolve(polpoDir, "skills", record.name),
          digest: record.digest,
          allowedTools: record.allowedTools,
          assignedTo: agentNames.filter((name) => configSkills.get(name)?.includes(record.name)),
        }));
        return c.json({ ok: true, data });
      }

      // Fast path: read from the indexed SkillStore and compute
      // per-agent assignments from `agent.skills[]` (single query).
      if (skillStore) {
        const records = await skillStore.list();
        const data = records.map((r) => ({
          name: r.name,
          description: r.description,
          source: "project" as const,
          path: resolve(polpoDir, "skills", r.name),
          allowedTools: r.allowedTools,
          tags: r.tags,
          category: r.category,
          assignedTo: agentNames.filter(
            (n) => configSkills.get(n)?.includes(r.name),
          ),
        }));
        return c.json({ ok: true, data });
      }

      // Fallback: walk the filesystem (back-compat for deployments
      // that don't wire a skillStore).
      const core = await coreImport();
      const skills = await core.listSkillsWithAssignments(fs, polpoDir, agentNames, configSkills);
      return c.json({ ok: true, data: skills });
    },
  );

  // GET /:name/content — full skill content
  app.openapi(
    createRoute({
      method: "get", path: "/:name/content", tags: ["Skills"], summary: "Get skill content",
      request: { params: z.object({ name: z.string() }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Skill content" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Not found" },
      },
    }),
    async (c: any) => {
      const deps = getDeps();
      const name = c.req.param("name");
      if (deps.skillBundleStore) {
        const stored = await deps.skillBundleStore.get(name);
        if (!stored) return c.json({ ok: false, error: "Skill not found" }, 404);
        const skillFile = stored.bundle.files.find((file) => file.path === "SKILL.md");
        if (!skillFile) return c.json({ ok: false, error: "Could not load skill content" }, 404);
        const raw = new TextDecoder().decode(decodeBase64(skillFile.content));
        return c.json({ ok: true, data: {
          name,
          description: stored.manifest.description,
          allowedTools: stored.manifest.allowedTools,
          source: "project",
          path: stored.root ?? resolve(deps.polpoDir, "skills", name),
          digest: stored.digest,
          content: (await coreImport()).extractSkillBody(raw),
        } });
      }
      const { fs, polpoDir } = deps;
      const core = await coreImport();
      const pool = await core.discoverSkills(fs, polpoDir) as SkillInfo[];
      const info = pool.find((s) => s.name === name);
      if (!info) return c.json({ ok: false, error: "Skill not found" }, 404);
      const loaded = await loadSkillContent(fs, info);
      if (!loaded) return c.json({ ok: false, error: "Could not load skill content" }, 404);
      return c.json({ ok: true, data: loaded });
    },
  );

  // GET /:name/bundle — complete binary-safe skill directory
  app.openapi(
    createRoute({
      method: "get", path: "/:name/bundle", tags: ["Skills"], summary: "Get complete skill bundle",
      request: { params: z.object({ name: z.string() }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), data: z.any() }) } }, description: "Complete skill bundle" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Invalid bundle" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Not found" },
      },
    }),
    async (c: any) => {
      const deps = getDeps();
      const name = c.req.param("name");
      const nameError = validateSkillName(name);
      if (nameError) return c.json({ ok: false, error: nameError }, 400);
      try {
        const current = await currentBundle(deps, name);
        if (!current) return c.json({ ok: false, error: "Skill not found" }, 404);
        return c.json({ ok: true, data: current.bundle }, 200);
      } catch (error) {
        return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
      }
    },
  );

  // POST /import — import one portable .skill/.zip archive.
  app.post("/import", async (c: any) => {
    const deps = getDeps();
    const contentLength = Number(c.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > SKILL_ARCHIVE_MAX_COMPRESSED_BYTES + 1_048_576) {
      return c.json({ ok: false, error: "Skill archive request is too large", code: "archive_limit_exceeded" }, 413);
    }
    let form: Record<string, string | File>;
    try {
      form = await c.req.parseBody();
    } catch {
      return c.json({ ok: false, error: "Invalid multipart skill archive", code: "invalid_archive" }, 400);
    }
    const archive = form.archive;
    if (!(archive instanceof File)) {
      return c.json({ ok: false, error: "Multipart field archive must contain a .skill or .zip file", code: "invalid_archive" }, 400);
    }
    if (archive.size === 0 || archive.size > SKILL_ARCHIVE_MAX_COMPRESSED_BYTES) {
      return c.json({ ok: false, error: "Skill archive compressed size is outside the supported limit", code: "archive_limit_exceeded" }, 413);
    }
    const filename = archive.name.toLocaleLowerCase("en-US");
    if (!filename.endsWith(".skill") && !filename.endsWith(".zip")) {
      return c.json({ ok: false, error: "Skill archive filename must end in .skill or .zip", code: "invalid_archive" }, 400);
    }
    const conflict = form.conflict === undefined ? "error" : form.conflict;
    if (conflict !== "error" && conflict !== "replace") {
      return c.json({ ok: false, error: "conflict must be error or replace", code: "invalid_request" }, 400);
    }
    const assignTo = typeof form.assignTo === "string" && form.assignTo.trim() ? form.assignTo.trim() : undefined;
    const expectedDigest = typeof form.expectedDigest === "string" && form.expectedDigest.trim()
      ? form.expectedDigest.trim()
      : undefined;
    let assignment: { name: string; skills: string[] } | undefined;
    if (assignTo) {
      if (!deps.updateAgentSkills) {
        return c.json({ ok: false, error: "Skill assignment not supported", code: "assignment_unsupported" }, 400);
      }
      const agent = (await deps.getAgents()).find((candidate) => candidate.name === assignTo);
      if (!agent) return c.json({ ok: false, error: `Agent "${assignTo}" not found`, code: "agent_not_found" }, 400);
      assignment = { name: agent.name, skills: agent.skills ?? [] };
    }

    try {
      const imported = await unpackSkillArchive(new Uint8Array(await archive.arrayBuffer()));
      const validated = await validateBundle(imported.bundle.name, imported.bundle.files);
      const stored = await persistValidatedBundle(deps, validated, {
        conflict,
        source: "archive",
        ...(expectedDigest ? { expectedDigest } : {}),
      });
      if (stored.conflict) {
        return c.json({
          ok: false,
          error: expectedDigest
            ? `Skill "${imported.bundle.name}" changed since it was read`
            : `Skill "${imported.bundle.name}" already exists with different content`,
          code: expectedDigest ? "skill_digest_conflict" : "skill_conflict",
          data: stored.receipt,
        }, 409);
      }
      if (assignment && !assignment.skills.includes(imported.bundle.name)) {
        await deps.updateAgentSkills!(assignment.name, [...assignment.skills, imported.bundle.name]);
        stored.receipt.assignedTo = [assignment.name];
      }
      return c.json({ ok: true, data: stored.receipt }, stored.created ? 201 : 200);
    } catch (error) {
      const code = error instanceof SkillArchiveError ? error.code : "invalid_skill";
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), code }, 400);
    }
  });

  // GET /:name/archive — deterministic portable .skill archive.
  app.openapi(
    createRoute({
      method: "get", path: "/:name/archive", tags: ["Skills"], summary: "Download a portable .skill archive",
      request: { params: z.object({ name: z.string() }) },
      responses: {
        200: { content: { "application/zip": { schema: z.any() } }, description: "Portable skill archive" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Invalid skill" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Not found" },
      },
    }),
    async (c: any) => {
      const deps = getDeps();
      const name = c.req.param("name");
      const nameError = validateSkillName(name);
      if (nameError) return c.json({ ok: false, error: nameError, code: "invalid_skill_name" }, 400);
      try {
        const current = await currentBundle(deps, name);
        if (!current) return c.json({ ok: false, error: "Skill not found", code: "skill_not_found" }, 404);
        const archive = await packSkillArchive(current.bundle);
        const body = new ArrayBuffer(archive.byteLength);
        new Uint8Array(body).set(archive);
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${name}.skill"`,
            "cache-control": "private, no-store",
          },
        });
      } catch (error) {
        return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), code: "invalid_skill" }, 400);
      }
    },
  );

  // PUT /:name/bundle — atomically create or replace a complete skill directory
  app.openapi(
    createRoute({
      method: "put", path: "/:name/bundle", tags: ["Skills"], summary: "Create or replace complete skill bundle",
      request: {
        params: z.object({ name: z.string() }),
        body: { content: { "application/json": { schema: z.object({ files: z.array(skillBundleFileSchema) }) } } },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), data: z.any() }) } }, description: "Bundle stored" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Invalid bundle" },
        500: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Storage failure" },
      },
    }),
    async (c: any) => {
      const deps = getDeps();
      const name = c.req.param("name");
      const { files } = await c.req.json() as { files: SkillBundleFile[] };
      const ifMatch = c.req.header("if-match")?.replace(/^W\//, "").replace(/^"|"$/g, "");

      try {
        const validated = await validateBundle(name, files);
        const stored = await persistValidatedBundle(deps, validated, {
          conflict: "replace",
          source: "bundle",
          ...(ifMatch ? { expectedDigest: ifMatch } : {}),
        });
        if (stored.conflict) {
          return c.json({ ok: false, error: `Skill "${name}" changed since it was read`, code: "skill_digest_conflict", data: stored.receipt }, 409);
        }
        return c.json({ ok: true, data: stored.receipt }, 200);
      } catch (error) {
        const status = error instanceof TypeError ? 400 : 500;
        return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, status);
      }
    },
  );

  // GET /index — skills index (tags, categories)
  app.openapi(
    createRoute({
      method: "get", path: "/index", tags: ["Skills"], summary: "Get skills index",
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Skills index" } },
    }),
    async (c) => {
      const { fs, polpoDir } = getDeps();
      const index = await loadSkillIndex(fs, polpoDir);
      return c.json({ ok: true, data: index ?? {} });
    },
  );

  // PUT /:name/index — update skill index entry (tags, category)
  app.openapi(
    createRoute({
      method: "put", path: "/:name/index", tags: ["Skills"], summary: "Update skill index entry",
      request: {
        params: z.object({ name: z.string() }),
        body: { content: { "application/json": { schema: z.object({ tags: z.array(z.string()).optional(), category: z.string().optional() }) } } },
      },
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Updated" } },
    }),
    async (c: any) => {
      const { fs, polpoDir, skillStore } = getDeps();
      const name = c.req.param("name");
      const body = await c.req.json();

      // Mirror the update into skillStore if wired.
      if (skillStore) {
        const existing = await skillStore.get(name);
        if (existing) {
          const next = { ...existing };
          if ("tags" in body) next.tags = body.tags?.length ? body.tags : undefined;
          if ("category" in body) next.category = body.category || undefined;
          await skillStore.upsert(next);
        }
      }

      const index = (await loadSkillIndex(fs, polpoDir)) ?? {};
      index[name] = { ...index[name], ...body };
      if (index[name].tags?.length === 0) delete index[name].tags;
      if (!index[name].category) delete index[name].category;
      if (Object.keys(index[name]).length === 0) delete index[name];
      await saveSkillIndex(fs, polpoDir, index);
      return c.json({ ok: true, data: { skill: name, ...body } });
    },
  );

  // POST /create — create a new skill
  app.openapi(
    createRoute({
      method: "post", path: "/create", tags: ["Skills"], summary: "Create a new skill",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                name: z.string().min(1),
                description: z.string().min(1),
                content: z.string().min(1),
                allowedTools: z.array(z.string()).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Created" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Error" },
      },
    }),
    async (c: any) => {
      const deps = getDeps();
      const { name, description, content, allowedTools } = await c.req.json();
      const nameError = validateSkillName(name);
      if (nameError) return c.json({ ok: false, error: nameError, code: "invalid_skill_name" }, 400);
      const targetDir = join(deps.polpoDir, "skills", name);
      if (await currentBundle(deps, name)) {
        return c.json({ ok: false, error: `Skill "${name}" already exists` }, 400);
      }
      const skillContent = [
        "---",
        `name: ${name}`,
        `description: ${JSON.stringify(description)}`,
        ...(allowedTools?.length ? [`allowed-tools: ${JSON.stringify(allowedTools.join(" "))}`] : []),
        "---",
        "",
        content,
      ].join("\n");
      const files: SkillBundleFile[] = [{
        path: "SKILL.md",
        content: Buffer.from(skillContent).toString("base64"),
        encoding: "base64",
      }];
      try {
        const validated = await validateBundle(name, files);
        const stored = await persistValidatedBundle(deps, validated, { conflict: "error", source: "builder" });
        return c.json({ ok: true, data: { ...stored.receipt, path: targetDir } });
      } catch (error) {
        return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), code: "invalid_skill" }, 400);
      }
    },
  );

  // DELETE /:name — remove a skill
  app.openapi(
    createRoute({
      method: "delete", path: "/:name", tags: ["Skills"], summary: "Remove a skill",
      request: { params: z.object({ name: z.string() }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Removed" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Not found" },
      },
    }),
    async (c: any) => {
      const deps = getDeps();
      const { fs, polpoDir, skillStore, skillBundleStore, getAgents, updateAgentSkills, onSkillChanged } = deps;
      const name = c.req.param("name");
      const nameError = validateSkillName(name);
      if (nameError) return c.json({ ok: false, error: nameError, code: "invalid_skill_name" }, 400);
      const targetDir = join(polpoDir, "skills", name);
      if (!(await currentBundle(deps, name))) {
        return c.json({ ok: false, error: "Skill not found" }, 404);
      }
      const assigned = (await getAgents()).filter((agent) => agent.skills?.includes(name));
      if (assigned.length > 0 && !updateAgentSkills) {
        return c.json({ ok: false, error: "Skill is assigned and assignment updates are not supported", code: "assignment_unsupported" }, 400);
      }
      for (const agent of assigned) {
        await updateAgentSkills!(agent.name, (agent.skills ?? []).filter((skill) => skill !== name));
      }
      if (skillBundleStore) await skillBundleStore.delete(name);
      else await fs.remove(targetDir);
      await skillStore?.remove(name);
      await onSkillChanged?.(name, null);
      return c.json({ ok: true, data: { removed: true, name } });
    },
  );

  // POST /:name/assign — assign skill to agent
  app.openapi(
    createRoute({
      method: "post", path: "/:name/assign", tags: ["Skills"], summary: "Assign skill to agent",
      request: {
        params: z.object({ name: z.string() }),
        body: { content: { "application/json": { schema: z.object({ agent: z.string().min(1) }) } } },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Assigned" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Error" },
      },
    }),
    async (c: any) => {
      const deps = getDeps();
      const { getAgents, updateAgentSkills } = deps;
      const skillName = c.req.param("name");
      const { agent: agentName } = await c.req.json();

      if (!updateAgentSkills) {
        return c.json({ ok: false, error: "Skill assignment not supported" }, 400);
      }
      const nameError = validateSkillName(skillName);
      if (nameError) return c.json({ ok: false, error: nameError, code: "invalid_skill_name" }, 400);
      if (!(await currentBundle(deps, skillName))) {
        return c.json({ ok: false, error: `Skill "${skillName}" not found`, code: "skill_not_found" }, 404);
      }

      const agents = await getAgents();
      const agent = agents.find((a) => a.name === agentName);
      if (!agent) return c.json({ ok: false, error: `Agent "${agentName}" not found` }, 400);

      const current = agent.skills ?? [];
      if (!current.includes(skillName)) {
        await updateAgentSkills(agentName, [...current, skillName]);
      }

      return c.json({ ok: true, data: { skill: skillName, agent: agentName } });
    },
  );

  // POST /:name/unassign — unassign skill from agent
  app.openapi(
    createRoute({
      method: "post", path: "/:name/unassign", tags: ["Skills"], summary: "Unassign skill from agent",
      request: {
        params: z.object({ name: z.string() }),
        body: { content: { "application/json": { schema: z.object({ agent: z.string().min(1) }) } } },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Unassigned" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Error" },
      },
    }),
    async (c: any) => {
      const { getAgents, updateAgentSkills } = getDeps();
      const skillName = c.req.param("name");
      const { agent: agentName } = await c.req.json();

      if (!updateAgentSkills) {
        return c.json({ ok: false, error: "Skill assignment not supported" }, 400);
      }

      const agents = await getAgents();
      const agent = agents.find((a) => a.name === agentName);
      if (!agent) return c.json({ ok: false, error: `Agent "${agentName}" not found` }, 400);

      const current = agent.skills ?? [];
      await updateAgentSkills(agentName, current.filter((s) => s !== skillName));

      return c.json({ ok: true, data: { skill: skillName, agent: agentName } });
    },
  );

  // POST /add — install skills from a portable archive, Git repository, or local path
  app.openapi(
    createRoute({
      method: "post", path: "/add", tags: ["Skills"], summary: "Install skills from a source",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                source: z.string().min(1).describe(
                  "Portable .skill/.zip data URL, GitHub owner/repo, HTTP(S) Git URL, or local path",
                ),
                skillNames: z.array(z.string()).optional().describe("Only install specific skill names"),
                force: z.boolean().optional().describe("Overwrite existing skills"),
                assignTo: z.string().optional().describe("Agent name to assign the installed skills to. If provided, the agent's `skills` list is updated with the newly installed skill names."),
              }),
            },
          },
        },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Install result" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Error" },
        409: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Skill conflict" },
        413: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Archive too large" },
      },
    }),
    async (c: any) => {
      const deps = getDeps();
      const { fs, shell, polpoDir, getAgents, updateAgentSkills, installFs } = deps;
      const { source, skillNames, force, assignTo } = await c.req.json();

      // MCP clients may already hold a portable .skill as a data URL. Import
      // those bytes directly through the canonical archive validator rather
      // than treating the data URL as a Git clone target and acquiring a
      // sandbox/R2 mount unnecessarily.
      try {
        const archiveBytes = decodeSkillArchiveDataUrl(source);
        if (archiveBytes) {
          const imported = await unpackSkillArchive(archiveBytes);
          const validated = await validateBundle(imported.bundle.name, imported.bundle.files);
          const publicSource = "archive:data-url";
          if (skillNames && !skillNames.includes(validated.bundle.name)) {
            return c.json({
              ok: false,
              error: `Requested skills not found: ${skillNames.join(", ")}. Available: ${validated.bundle.name}`,
              code: "skill_not_found",
            }, 400);
          }

          const existing = await currentBundle(deps, validated.bundle.name);
          if (existing && !force) {
            return c.json({
              ok: true,
              data: {
                installed: [],
                skipped: [validated.bundle.name],
                errors: [],
                source: publicSource,
                assigned: [],
              },
            });
          }

          const stored = await persistValidatedBundle(deps, validated, {
            conflict: force ? "replace" : "error",
            source: publicSource,
          });
          if (stored.conflict) {
            return c.json({
              ok: false,
              error: `Skill "${validated.bundle.name}" already exists with different content`,
              code: "skill_conflict",
              data: stored.receipt,
            }, 409);
          }

          const installed = [validated.bundle.name];
          const skipped = stored.receipt.changed === false ? [validated.bundle.name] : [];
          const errors: string[] = [];
          let assigned: string[] = [];
          if (assignTo && updateAgentSkills) {
            const agents = await getAgents();
            const agent = agents.find((candidate) => candidate.name === assignTo);
            if (!agent) {
              errors.push(`assignTo: agent "${assignTo}" not found`);
            } else {
              const current = agent.skills ?? [];
              if (!current.includes(validated.bundle.name)) {
                await updateAgentSkills(assignTo, [...current, validated.bundle.name]);
                assigned = [validated.bundle.name];
              }
            }
          } else if (assignTo) {
            errors.push("assignTo: skill assignment is not supported");
          }

          return c.json({
            ok: true,
            data: { installed, skipped, errors, source: publicSource, assigned },
          });
        }
      } catch (error) {
        const code = error instanceof SkillArchiveError ? error.code : "invalid_skill";
        const status = code === "archive_limit_exceeded" ? 413 : 400;
        return c.json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code,
        }, status);
      }

      // Parse source
      let cloneUrl: string | null = null;
      let sourceDir: string;
      let scanFs: FileSystem;

      if (source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) {
        // Prefer the durable project filesystem. A host may also expose an
        // explicit scratch/install filesystem for sandbox-local paths.
        if (await fs.exists(source)) {
          scanFs = fs;
        } else if (installFs && await installFs.exists(source)) {
          scanFs = installFs;
        } else {
          return c.json({ ok: false, error: `Local path not found: ${source}` }, 400);
        }
        sourceDir = source;
      } else {
        if (!shell) {
          return c.json({ ok: false, error: "Skill installation not available (no shell)" }, 400);
        }
        scanFs = installFs ?? fs;
        // GitHub — clone to temp dir
        const ghMatch = source.match(/github\.com\/([^/]+\/[^/]+)/);
        const ownerRepo = ghMatch
          ? ghMatch[1].replace(/\.git$/, "")
          : /^[^/]+\/[^/]+$/.test(source) ? source : null;

        const resolvedCloneUrl = ownerRepo
          ? `https://github.com/${ownerRepo}.git`
          : source;
        cloneUrl = resolvedCloneUrl;

        const tmpDir = `/tmp/polpo-skills-${Date.now()}`;
        const cloneResult = await shell.execute(
          `git clone --depth 1 --quiet ${shellQuote(resolvedCloneUrl)} ${shellQuote(tmpDir)}`,
          { timeout: 60_000 },
        );
        if (cloneResult.exitCode !== 0) {
          return c.json({ ok: false, error: `Failed to clone: ${cloneResult.stderr}` }, 400);
        }
        sourceDir = tmpDir;
      }

      // Scan for SKILL.md files (up to 3 levels deep)
      const found: Array<{ name: string; description: string; path: string }> = [];

      async function scanDir(dir: string, depth: number): Promise<void> {
        if (depth > 3) return;
        const SKIP = new Set(["node_modules", ".git"]);
        try {
          const entries = (scanFs as any).readdirWithTypes
            ? await (scanFs as any).readdirWithTypes(dir)
            : (await scanFs.readdir(dir)).map((n: string) => ({ name: n, isDirectory: true, isFile: false }));

          for (const entry of entries) {
            if (SKIP.has(entry.name)) continue;
            if (!entry.isDirectory) continue;
            const entryPath = resolve(dir, entry.name);
            const skillMd = join(entryPath, "SKILL.md");
            if (await scanFs.exists(skillMd)) {
              try {
                const raw = await scanFs.readFile(skillMd);
                const core = await coreImport();
                const fm = core.parseSkillFrontmatter(raw);
                found.push({ name: fm?.name ?? entry.name, description: fm?.description ?? "", path: entryPath });
              } catch { /* skip */ }
            } else {
              await scanDir(entryPath, depth + 1);
            }
          }
        } catch { /* skip */ }
      }

      // Check root
      if (await scanFs.exists(join(sourceDir, "SKILL.md"))) {
        const raw = await scanFs.readFile(join(sourceDir, "SKILL.md"));
        const core = await coreImport();
        const fm = core.parseSkillFrontmatter(raw);
        found.push({ name: fm?.name ?? basename(sourceDir), description: fm?.description ?? "", path: sourceDir });
      }

      // Check standard locations
      for (const sub of ["skills", ".polpo/skills", ".agents/skills", ".claude/skills"]) {
        const subDir = join(sourceDir, sub);
        if (await scanFs.exists(subDir)) await scanDir(subDir, 0);
      }

      // Fallback: recursive scan
      if (found.length === 0) await scanDir(sourceDir, 0);

      if (found.length === 0) {
        // Cleanup
        if (cloneUrl && shell) await shell.execute(`rm -rf "${sourceDir}"`).catch(() => {});
        return c.json({ ok: false, error: `No skills found in ${source}` }, 400);
      }

      // Filter by requested names
      const toInstall = skillNames
        ? found.filter((s) => skillNames.includes(s.name))
        : found;

      if (skillNames && toInstall.length === 0) {
        if (cloneUrl && shell) await shell.execute(`rm -rf "${sourceDir}"`).catch(() => {});
        return c.json({
          ok: false,
          error: `Requested skills not found: ${skillNames.join(", ")}. Available: ${found.map((s) => s.name).join(", ")}`,
        }, 400);
      }

      // Install
      const targetBase = join(polpoDir, "skills");
      await fs.mkdir(targetBase).catch(() => {});

      const installed: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];

      for (const skill of toInstall) {
        if (await currentBundle(deps, skill.name) && !force) {
          skipped.push(skill.name);
          continue;
        }
        try {
          const bundle = await readSkillBundle(scanFs, skill.path, skill.name);
          const validated = await validateBundle(skill.name, bundle.files);
          const stored = await persistValidatedBundle(deps, validated, { conflict: "replace", source });
          skill.description = validated.manifest.description;
          (skill as any).allowedTools = validated.manifest.allowedTools;
          if (!stored.receipt.changed) skipped.push(skill.name);
        } catch (err) {
          errors.push(`${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        installed.push(skill.name);
      }

      // Cleanup cloned repo
      if (cloneUrl && shell) await shell.execute(`rm -rf "${sourceDir}"`).catch(() => {});

      // Optional: assign installed skills to an agent. Closes the onboarding
      // "install + assign" loop in a single call. Silent no-op if the agent
      // doesn't exist or the deps don't expose updateAgentSkills.
      let assigned: string[] = [];
      if (assignTo && installed.length > 0 && getAgents && updateAgentSkills) {
        try {
          const agents = await getAgents();
          const agent = agents.find((a: any) => a.name === assignTo);
          if (agent) {
            const current: string[] = (agent.skills as string[] | undefined) ?? [];
            const toAdd = installed.filter((name) => !current.includes(name));
            if (toAdd.length > 0) {
              await updateAgentSkills(assignTo, [...current, ...toAdd]);
              assigned = toAdd;
            }
          } else {
            errors.push(`assignTo: agent "${assignTo}" not found`);
          }
        } catch (err) {
          errors.push(`assignTo: ${(err as Error).message}`);
        }
      }

      return c.json({ ok: true, data: { installed, skipped, errors, source, assigned } });
    },
  );

  return app;
}
