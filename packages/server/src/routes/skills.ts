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
  validateSkillBundleFiles,
  validateSkillName,
  type SkillBundle,
  type SkillBundleFile,
} from "@polpo-ai/core/skill-bundle";
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
      const { fs, polpoDir, getAgents, skillStore } = getDeps();
      const agents = await getAgents();
      const agentNames = agents.map((a) => a.name);
      const configSkills = new Map<string, string[]>();
      for (const a of agents) {
        if (a.skills?.length) configSkills.set(a.name, a.skills);
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
      const { fs, polpoDir } = getDeps();
      const name = c.req.param("name");
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
      const { fs, polpoDir } = getDeps();
      const name = c.req.param("name");
      const nameError = validateSkillName(name);
      if (nameError) return c.json({ ok: false, error: nameError }, 400);
      const target = join(polpoDir, "skills", name);
      if (!(await fs.exists(target))) return c.json({ ok: false, error: "Skill not found" }, 404);
      try {
        return c.json({ ok: true, data: await readSkillBundle(fs, target, name) }, 200);
      } catch (error) {
        return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
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
      const { fs, polpoDir, skillStore } = getDeps();
      const name = c.req.param("name");
      const nameError = validateSkillName(name);
      if (nameError) return c.json({ ok: false, error: nameError }, 400);

      const { files } = await c.req.json() as { files: SkillBundleFile[] };
      const validationError = validateSkillBundleFiles(files);
      if (validationError) return c.json({ ok: false, error: validationError }, 400);

      const skillFile = files.find((file) => file.path === "SKILL.md")!;
      const rawSkill = Buffer.from(skillFile.content, "base64").toString("utf8");
      const core = await coreImport();
      const frontmatter = core.parseSkillFrontmatter(rawSkill);
      if (!frontmatter?.name || frontmatter.name !== name) {
        return c.json({ ok: false, error: `SKILL.md name must match directory name "${name}"` }, 400);
      }
      if (!frontmatter.description) {
        return c.json({ ok: false, error: "SKILL.md must contain a description" }, 400);
      }

      try {
        await replaceSkillBundle(fs, polpoDir, name, files);
        await skillStore?.upsert({
          name,
          description: frontmatter.description,
          source: "local",
          installedAt: new Date().toISOString(),
          allowedTools: frontmatter.allowedTools,
        });
        return c.json({ ok: true, data: { name, files: files.length } }, 200);
      } catch (error) {
        return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
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
      const { fs, polpoDir, skillStore } = getDeps();
      const { name, description, content, allowedTools } = await c.req.json();

      const targetDir = join(polpoDir, "skills", name);
      if (await fs.exists(targetDir)) {
        return c.json({ ok: false, error: `Skill "${name}" already exists` }, 400);
      }

      await fs.mkdir(targetDir);

      const fmLines = [`---`, `name: ${name}`, `description: ${description}`];
      if (allowedTools?.length) {
        fmLines.push(`allowed-tools:`);
        for (const t of allowedTools) fmLines.push(`  - ${t}`);
      }
      fmLines.push(`---`, ``);

      await fs.writeFile(join(targetDir, "SKILL.md"), fmLines.join("\n") + content);

      // Mirror to skillStore if wired.
      await skillStore?.upsert({
        name,
        description,
        source: "local",
        installedAt: new Date().toISOString(),
        allowedTools,
      });

      return c.json({ ok: true, data: { name, path: targetDir } });
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
      const { fs, polpoDir, skillStore } = getDeps();
      const name = c.req.param("name");
      const targetDir = join(polpoDir, "skills", name);
      if (!(await fs.exists(targetDir))) {
        return c.json({ ok: false, error: "Skill not found" }, 404);
      }
      await fs.remove(targetDir);
      await skillStore?.remove(name);
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

  // POST /add — install skills from GitHub repo or local path
  app.openapi(
    createRoute({
      method: "post", path: "/add", tags: ["Skills"], summary: "Install skills from a source",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                source: z.string().min(1).describe("GitHub owner/repo, full URL, or local path"),
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
      },
    }),
    async (c: any) => {
      const { fs, shell, polpoDir, getAgents, updateAgentSkills, skillStore, installFs } = getDeps();
      if (!shell) {
        return c.json({ ok: false, error: "Skill installation not available (no shell)" }, 400);
      }
      const scanFs = installFs ?? fs;

      const { source, skillNames, force, assignTo } = await c.req.json();

      // Parse source
      let cloneUrl: string | null = null;
      let sourceDir: string;

      if (source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) {
        // Local path
        if (!(await scanFs.exists(source))) {
          return c.json({ ok: false, error: `Local path not found: ${source}` }, 400);
        }
        sourceDir = source;
      } else {
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
        if (cloneUrl) await shell.execute(`rm -rf "${sourceDir}"`).catch(() => {});
        return c.json({ ok: false, error: `No skills found in ${source}` }, 400);
      }

      // Filter by requested names
      const toInstall = skillNames
        ? found.filter((s) => skillNames.includes(s.name))
        : found;

      if (skillNames && toInstall.length === 0) {
        if (cloneUrl) await shell.execute(`rm -rf "${sourceDir}"`).catch(() => {});
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
        const targetDir = join(targetBase, skill.name);
        if (await fs.exists(targetDir) && !force) {
          skipped.push(skill.name);
          continue;
        }
        try {
          const bundle = await readSkillBundle(scanFs, skill.path, skill.name);
          const skillFile = bundle.files.find((file) => file.path === "SKILL.md")!;
          const raw = Buffer.from(skillFile.content, "base64").toString("utf8");
          const core = await coreImport();
          const metadata = core.parseSkillFrontmatter(raw);
          if (!metadata?.name || metadata.name !== skill.name || !metadata.description) {
            throw new Error(`SKILL.md must define name "${skill.name}" and a description`);
          }
          await replaceSkillBundle(fs, polpoDir, skill.name, bundle.files);
          skill.description = metadata.description;
          (skill as any).allowedTools = metadata.allowedTools;
        } catch (err) {
          errors.push(`${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        installed.push(skill.name);
        // Mirror to skillStore for fast-path list reads.
        await skillStore?.upsert({
          name: skill.name,
          description: skill.description,
          source,
          installedAt: new Date().toISOString(),
          allowedTools: (skill as any).allowedTools,
        }).catch(() => { /* best-effort — fs write already succeeded */ });
      }

      // Cleanup cloned repo
      if (cloneUrl) await shell.execute(`rm -rf "${sourceDir}"`).catch(() => {});

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
