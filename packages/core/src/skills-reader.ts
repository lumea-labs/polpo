/**
 * Skills reader — pure functions for discovering and loading skills.
 *
 * Uses FileSystem abstraction so it works on any backend:
 *   - NodeFileSystem (self-hosted)
 *   - SandboxProxyFS (remote, lazy)
 *
 * Write operations (install, remove, create, assign) stay in the shell
 * because they use git clone, symlinks, and other Node-specific ops.
 */

import { resolve, join, sep } from "node:path";
import type { FileSystem } from "./filesystem.js";

// ── Types ──

export interface SkillInfo {
  name: string;
  description: string;
  allowedTools?: string[];
  source: "project" | "global";
  path: string;
  tags?: string[];
  category?: string;
}

export interface LoadedSkill extends SkillInfo {
  content: string;
}

export interface SkillResource {
  /** POSIX path relative to the skill bundle root. */
  path: string;
  /** UTF-8 text safe to return to the model. */
  content: string;
}

export const DEFAULT_SKILL_AUTO_REFERENCE_MAX_BYTES = 64 * 1024;
export const SKILL_AUTO_REFERENCE_MAX_FILES = 512;

export type SkillReferenceOmissionReason =
  | "binary"
  | "budget_exceeded"
  | "read_failed"
  | "unsupported_entry";

export interface LoadedSkillReference extends SkillResource {
  bytes: number;
}

export interface OmittedSkillReference {
  path: string;
  reason: SkillReferenceOmissionReason;
}

export interface AssembledSkillRead {
  entrypoint: SkillResource;
  references: LoadedSkillReference[];
  omitted: OmittedSkillReference[];
  totalReferenceBytes: number;
}

export interface AssembleSkillReadOptions {
  maxReferenceBytes?: number;
}

export type SkillResourceErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_a_file"
  | "read_failed";

export class SkillResourceError extends Error {
  constructor(
    readonly code: SkillResourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillResourceError";
  }
}

export interface SkillIndexEntry {
  tags?: string[];
  category?: string;
}

export type SkillIndex = Record<string, SkillIndexEntry>;

export interface SkillWithAssignment extends SkillInfo {
  assignedTo: string[];
}

// ── Parsing (pure, no FS) ──

/**
 * Parse SKILL.md YAML frontmatter.
 * Inlined minimal YAML parser for the simple key:value frontmatter format.
 */
export function parseSkillFrontmatter(content: string): { name?: string; description: string; allowedTools?: string[] } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    // Simple YAML-like parsing for flat frontmatter (no nested objects)
    const lines = match[1].split("\n");
    const fm: Record<string, unknown> = {};
    let currentArray: string[] | null = null;
    let currentKey: string | null = null;

    for (const line of lines) {
      const arrayItemMatch = line.match(/^\s+-\s+(.+)/);
      if (arrayItemMatch && currentKey) {
        if (!currentArray) currentArray = [];
        currentArray.push(arrayItemMatch[1].trim());
        fm[currentKey] = currentArray;
        continue;
      }

      if (currentArray) {
        currentArray = null;
        currentKey = null;
      }

      const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.+)?/);
      if (kvMatch) {
        currentKey = kvMatch[1] === "allowed-tools" ? "allowedTools" : kvMatch[1];
        const val = kvMatch[2]?.trim();
        if (val) {
          fm[currentKey] = val;
        }
      }
    }

    if (!fm.name && !fm.description) return null;
    return {
      name: fm.name as string | undefined,
      description: (fm.description as string) ?? "",
      allowedTools: fm.allowedTools as string[] | undefined,
    };
  } catch { return null; }
}

/** Extract the markdown body (everything after the frontmatter block). */
export function extractSkillBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

/**
 * Validate the public, bundle-relative path accepted by skill_read.
 * Skill bundles always use POSIX paths, regardless of the runtime host.
 */
export function normalizeSkillResourcePath(path?: string): string {
  if (path === undefined) return "SKILL.md";

  const value = path.trim();
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new SkillResourceError("invalid_path", "Skill resource path must be relative to the skill bundle");
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SkillResourceError("invalid_path", "Skill resource path contains an invalid segment");
  }

  return segments.join("/");
}

/**
 * Read a text resource from one loaded skill without exposing its physical root.
 * Omitting path reads the main SKILL.md body; all other paths are relative to
 * the same skill directory.
 */
export async function readSkillResource(
  fs: FileSystem,
  skill: LoadedSkill,
  path?: string,
): Promise<SkillResource> {
  const resourcePath = normalizeSkillResourcePath(path);
  const root = resolve(skill.path);
  const target = resolve(root, ...resourcePath.split("/"));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new SkillResourceError("invalid_path", "Skill resource path escapes the skill bundle");
  }

  let exists: boolean;
  try {
    exists = await fs.exists(target);
  } catch {
    throw new SkillResourceError("read_failed", `Skill resource "${resourcePath}" could not be inspected`);
  }
  if (!exists) {
    throw new SkillResourceError("not_found", `Skill resource "${resourcePath}" was not found`);
  }

  try {
    const stat = await fs.stat(target);
    if (!stat.isFile) {
      throw new SkillResourceError("not_a_file", `Skill resource "${resourcePath}" is not a file`);
    }
    const raw = await fs.readFile(target);
    return {
      path: resourcePath,
      content: resourcePath === "SKILL.md" ? extractSkillBody(raw) : raw,
    };
  } catch (error) {
    if (error instanceof SkillResourceError) throw error;
    throw new SkillResourceError("read_failed", `Skill resource "${resourcePath}" could not be read`);
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function looksBinary(value: string): boolean {
  if (value.includes("\0")) return true;
  if (value.length === 0) return false;

  let controls = 0;
  const sampled = value.slice(0, 8_192);
  for (const char of sampled) {
    const code = char.charCodeAt(0);
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      controls += 1;
    }
  }
  return controls / sampled.length > 0.05;
}

function explicitReferencePaths(content: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const pattern = /references\/[A-Za-z0-9][A-Za-z0-9._/-]*/g;
  for (const match of content.matchAll(pattern)) {
    const path = match[0].replace(/[.,;:!?]+$/, "");
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

async function listBundledReferences(
  fs: FileSystem,
  skill: LoadedSkill,
): Promise<{ paths: string[]; omitted: OmittedSkillReference[] }> {
  const root = resolve(skill.path, "references");
  try {
    if (!(await fs.exists(root))) return { paths: [], omitted: [] };
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory) {
      return {
        paths: [],
        omitted: [{ path: "references", reason: "unsupported_entry" }],
      };
    }
  } catch {
    return {
      paths: [],
      omitted: [{ path: "references", reason: "read_failed" }],
    };
  }

  const paths: string[] = [];
  const omitted: OmittedSkillReference[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    if (paths.length + omitted.length >= SKILL_AUTO_REFERENCE_MAX_FILES) return;

    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    try {
      if (fs.readdirWithTypes) {
        entries = await fs.readdirWithTypes(directory);
      } else {
        const names = await fs.readdir(directory);
        entries = await Promise.all(names.map(async (name) => {
          const stat = await fs.stat(resolve(directory, name));
          return { name, isDirectory: stat.isDirectory, isFile: stat.isFile };
        }));
      }
    } catch {
      omitted.push({ path: relativeDirectory, reason: "read_failed" });
      return;
    }

    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      if (paths.length + omitted.length >= SKILL_AUTO_REFERENCE_MAX_FILES) break;
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile) {
        paths.push(relativePath);
      } else {
        omitted.push({ path: relativePath, reason: "unsupported_entry" });
      }
    }
  };

  await visit(root, "references");
  return { paths, omitted };
}

/**
 * Build the model-facing view of one assigned skill. The entrypoint is always
 * loaded first; textual references are included deterministically so skill
 * authors do not need Polpo-specific instructions in SKILL.md.
 */
export async function assembleSkillRead(
  fs: FileSystem,
  skill: LoadedSkill,
  options: AssembleSkillReadOptions = {},
): Promise<AssembledSkillRead> {
  const entrypoint = await readSkillResource(fs, skill);
  const configuredBudget = options.maxReferenceBytes;
  const maxReferenceBytes = typeof configuredBudget === "number" && Number.isFinite(configuredBudget)
    ? Math.max(0, Math.floor(configuredBudget))
    : DEFAULT_SKILL_AUTO_REFERENCE_MAX_BYTES;
  const listed = await listBundledReferences(fs, skill);
  const explicit = explicitReferencePaths(entrypoint.content);
  const available = new Set(listed.paths);
  const orderedPaths = [
    ...explicit.filter((path) => available.has(path)),
    ...listed.paths.filter((path) => !explicit.includes(path)).sort(comparePaths),
  ];

  const references: LoadedSkillReference[] = [];
  const omitted = [...listed.omitted];
  let totalReferenceBytes = 0;
  for (const path of orderedPaths) {
    let resource: SkillResource;
    try {
      resource = await readSkillResource(fs, skill, path);
    } catch {
      omitted.push({ path, reason: "read_failed" });
      continue;
    }

    if (looksBinary(resource.content)) {
      omitted.push({ path, reason: "binary" });
      continue;
    }
    const bytes = utf8Bytes(resource.content);
    if (totalReferenceBytes + bytes > maxReferenceBytes) {
      omitted.push({ path, reason: "budget_exceeded" });
      continue;
    }
    references.push({ ...resource, bytes });
    totalReferenceBytes += bytes;
  }

  return {
    entrypoint,
    references,
    omitted: omitted.sort((left, right) => comparePaths(left.path, right.path)),
    totalReferenceBytes,
  };
}

// ── Build prompt (pure, no FS) ──

/**
 * Build the skill injection block for an agent's system prompt.
 */
export interface SkillPromptOptions {
  /** Assigned skills that the caller explicitly selected for this execution. */
  activatedSkills?: readonly string[];
}

export interface ProgressiveSkillPromptEntry {
  name?: unknown;
  description?: unknown;
  content?: unknown;
}

/** Build the prompt contract for runtimes that expose skills progressively. */
export function buildProgressiveSkillPrompt(
  skills: ProgressiveSkillPromptEntry[],
  activatedSkills: readonly string[] = [],
): string {
  const available = skills
    .filter(
      (skill): skill is ProgressiveSkillPromptEntry & { name: string } =>
        typeof skill.name === "string" && skill.name.trim().length > 0,
    )
    .map((skill) => ({
      name: skill.name,
      description: typeof skill.description === "string" ? skill.description : "",
      content: typeof skill.content === "string" ? skill.content : "",
    }));
  if (available.length === 0) return "";

  const skillsByName = new Map(available.map((skill) => [skill.name, skill]));
  const activated = [...new Set(activatedSkills)].flatMap((name) => {
    const skill = skillsByName.get(name);
    return skill ? [skill] : [];
  });
  const parts = [
    "## Assigned Skills",
    "",
    `You have ${available.length} assigned skill${available.length === 1 ? "" : "s"}.`,
    `Assigned skill names: ${available.map((skill) => `\`${skill.name}\``).join(", ")}.`,
    "Always use `skill_read` for assigned skill instructions and resources.",
    "Calling `skill_read` with only `name` loads SKILL.md and automatically includes the textual files bundled under `references/`.",
    "Use its optional bundle-relative `path` only for a resource reported as omitted or when you need one exact bundle file.",
    "Do not use workspace file tools or shell commands to read SKILL.md, references, scripts, or assets from an assigned skill bundle.",
  ];

  if (activated.length === 0) {
    parts.push(
      "For non-trivial work, call `skill_list` first to inspect available skills, then call `skill_read` before applying a skill's detailed instructions.",
      "Do not infer detailed skill behavior from the name alone.",
    );
    return parts.join("\n");
  }

  parts.push(
    "Other assigned skills remain discoverable through `skill_list` and `skill_read`.",
    "",
    "## Skills Activated for This Execution",
    "",
    "Apply the following complete skill instructions to this request. This does not disable other assigned skills.",
  );
  for (const skill of activated) {
    parts.push("", `### ${skill.name}`);
    if (skill.description) parts.push(`> ${skill.description}`);
    if (skill.content) parts.push("", skill.content);
  }
  return parts.join("\n");
}

export function buildSkillPrompt(
  skills: LoadedSkill[],
  options: SkillPromptOptions = {},
): string {
  if (skills.length === 0) return "";

  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const activated = [...new Set(options.activatedSkills ?? [])]
    .map((name) => skillsByName.get(name))
    .filter((skill): skill is LoadedSkill => skill !== undefined);
  const activatedNames = new Set(activated.map((skill) => skill.name));
  const orderedSkills = [
    ...activated,
    ...skills.filter((skill) => !activatedNames.has(skill.name)),
  ];

  const parts = [
    `\n## Assigned Skills\n`,
    `You have ${skills.length} skill${skills.length > 1 ? "s" : ""} loaded. Use this knowledge when applicable:\n`,
  ];

  if (activated.length > 0) {
    const names = activated.map((skill) => `\`${skill.name}\``).join(", ");
    parts.push(
      `The following assigned skill${activated.length > 1 ? "s are" : " is"} explicitly activated for this execution: ${names}.`,
      "Apply the activated skill instructions to this request. Other assigned skills remain available when relevant.",
      "",
    );
  }

  for (const skill of orderedSkills) {
    parts.push(`### ${skill.name}`);
    if (skill.description) parts.push(`> ${skill.description}\n`);
    parts.push(skill.content);
    parts.push("");
  }

  return parts.join("\n");
}

// ── Discovery (async, uses FileSystem) ──

/** Scan a single skills directory and return discovered skills. */
async function scanSkillsDir(fs: FileSystem, dir: string, source: SkillInfo["source"]): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  if (!(await fs.exists(dir))) return skills;

  try {
    const entries = fs.readdirWithTypes
      ? await fs.readdirWithTypes(dir)
      : (await fs.readdir(dir)).map((n) => ({ name: n, isDirectory: true, isFile: false }));

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const entryPath = resolve(dir, entry.name);
      const skillPath = resolve(entryPath, "SKILL.md");
      if (!(await fs.exists(skillPath))) continue;

      try {
        const raw = await fs.readFile(skillPath);
        const fm = parseSkillFrontmatter(raw);
        const name = fm?.name ?? entry.name;
        skills.push({
          name,
          description: fm?.description ?? "",
          allowedTools: fm?.allowedTools,
          source,
          path: entryPath,
        });
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip unreadable dir */ }
  return skills;
}

/**
 * Discover ALL available skills from the project's .polpo/skills/ directory.
 * Remote version — no global ~/.polpo/ (not available in sandbox).
 */
export async function discoverSkills(
  fs: FileSystem,
  polpoDir: string,
  globalPolpoDir?: string,
): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  const all: SkillInfo[] = [];

  const dirs: Array<{ dir: string; source: SkillInfo["source"] }> = [
    { dir: resolve(polpoDir, "skills"), source: "project" },
  ];
  if (globalPolpoDir) {
    dirs.push({ dir: resolve(globalPolpoDir, "skills"), source: "global" });
  }

  for (const { dir, source } of dirs) {
    for (const skill of await scanSkillsDir(fs, dir, source)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        all.push(skill);
      }
    }
  }

  // Enrich with index metadata
  const index = await loadSkillIndex(fs, polpoDir);
  if (index) {
    for (const skill of all) {
      const entry = index[skill.name];
      if (entry) {
        if (entry.tags) skill.tags = entry.tags;
        if (entry.category) skill.category = entry.category;
      }
    }
  }

  return all;
}

/** Load skills-index.json from polpoDir. */
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

// ── Per-agent loading ──

/** Load a single skill's content. */
async function loadSkillContent(fs: FileSystem, info: SkillInfo): Promise<LoadedSkill | null> {
  const skillPath = resolve(info.path, "SKILL.md");
  try {
    const raw = await fs.readFile(skillPath);
    return { ...info, content: extractSkillBody(raw) };
  } catch { return null; }
}

/**
 * Load the skills assigned to a specific agent.
 *
 * Priority:
 *   1. .polpo/agents/<agentName>/skills/ directory
 *   2. AgentConfig.skills[] names resolved against the pool
 */
export async function loadAgentSkills(
  fs: FileSystem,
  polpoDir: string,
  agentName: string,
  configSkillNames?: string[],
  globalPolpoDir?: string,
): Promise<LoadedSkill[]> {
  const agentSkillsDir = resolve(polpoDir, "agents", agentName, "skills");

  // Strategy 1: agent has a skills dir
  if (await fs.exists(agentSkillsDir)) {
    const skills = await scanSkillsDir(fs, agentSkillsDir, "project");
    const loaded = await Promise.all(skills.map((s) => loadSkillContent(fs, s)));
    return loaded.filter((s): s is LoadedSkill => s !== null);
  }

  // Strategy 2: resolve config skill names against the pool
  if (configSkillNames && configSkillNames.length > 0) {
    const pool = await discoverSkills(fs, polpoDir, globalPolpoDir);
    const poolMap = new Map(pool.map((s) => [s.name, s]));
    const loaded: LoadedSkill[] = [];
    for (const name of configSkillNames) {
      const info = poolMap.get(name);
      if (info) {
        const skill = await loadSkillContent(fs, info);
        if (skill) loaded.push(skill);
      }
    }
    return loaded;
  }

  return [];
}

/**
 * List skills with their per-agent assignments.
 */
export async function listSkillsWithAssignments(
  fs: FileSystem,
  polpoDir: string,
  agentNames: string[],
  agentConfigSkills?: Map<string, string[]>,
  globalPolpoDir?: string,
): Promise<SkillWithAssignment[]> {
  const pool = await discoverSkills(fs, polpoDir, globalPolpoDir);
  const result: SkillWithAssignment[] = [];

  for (const skill of pool) {
    const assignedTo = new Set<string>();

    for (const agentName of agentNames) {
      // Strategy 1: check skills dir
      const linkPath = resolve(polpoDir, "agents", agentName, "skills", skill.name);
      if (await fs.exists(linkPath)) {
        assignedTo.add(agentName);
        continue;
      }

      // Strategy 2: check config
      const configSkills = agentConfigSkills?.get(agentName);
      if (configSkills?.includes(skill.name)) {
        assignedTo.add(agentName);
      }
    }

    result.push({ ...skill, assignedTo: [...assignedTo] });
  }

  return result;
}
