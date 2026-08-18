import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseSkillFrontmatter,
  validateSkillName,
  type SkillBundle,
} from "@polpo-ai/core";
import {
  detectAgentLayout,
  readProjectAgents,
  writeProjectAgent,
} from "@polpo-ai/file-stores";
import {
  collectLocalSkillBundle,
  replaceLocalSkillBundle,
} from "./runtime-skill-bundle.js";

export const RUNTIME_SKILLS_LOCK_VERSION = 1 as const;

export interface DiscoveredRuntimeSkill {
  name: string;
  description: string;
  directory: string;
  bundle: SkillBundle;
}

export interface RuntimeSkillLockEntry {
  source: string;
  sourceSkill: string;
  revision?: string;
  digest: string;
  installedAt: string;
}

export interface RuntimeSkillsLock {
  version: typeof RUNTIME_SKILLS_LOCK_VERSION;
  skills: Record<string, RuntimeSkillLockEntry>;
}

export interface InstallRuntimeSkillsOptions {
  projectDir: string;
  skills: readonly DiscoveredRuntimeSkill[];
  source: string;
  revision?: string;
  agents?: readonly string[];
  force?: boolean;
  now?: () => Date;
}

export interface InstallRuntimeSkillsResult {
  installed: string[];
  updated: string[];
  unchanged: string[];
  skipped: string[];
  assigned: Array<{ agent: string; skill: string }>;
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const MAX_DISCOVERY_DEPTH = 8;

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function normalizeSkillMarkdown(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export function runtimeSkillsLockPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), ".polpo", "skills.lock.json");
}

export function readRuntimeSkillsLock(projectDir: string): RuntimeSkillsLock {
  const filePath = runtimeSkillsLockPath(projectDir);
  if (!fs.existsSync(filePath)) {
    return { version: RUNTIME_SKILLS_LOCK_VERSION, skills: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain an object`);
  }
  const record = parsed as Partial<RuntimeSkillsLock>;
  if (record.version !== RUNTIME_SKILLS_LOCK_VERSION || !record.skills || typeof record.skills !== "object") {
    throw new Error(`${filePath} uses an unsupported lock format`);
  }
  for (const [name, entry] of Object.entries(record.skills)) {
    if (
      validateSkillName(name)
      || !entry
      || typeof entry !== "object"
      || typeof entry.source !== "string"
      || typeof entry.sourceSkill !== "string"
      || typeof entry.digest !== "string"
      || typeof entry.installedAt !== "string"
      || (entry.revision !== undefined && typeof entry.revision !== "string")
    ) {
      throw new Error(`${filePath} contains an invalid entry for ${name}`);
    }
  }
  return record as RuntimeSkillsLock;
}

export function writeRuntimeSkillsLock(projectDir: string, lock: RuntimeSkillsLock): void {
  const filePath = runtimeSkillsLockPath(projectDir);
  if (Object.keys(lock.skills).length === 0) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  atomicWriteJson(filePath, lock);
}

export function skillBundleDigest(bundle: SkillBundle): string {
  const hash = createHash("sha256");
  for (const file of [...bundle.files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Discover valid Agent Skills bundles without following symlinks. */
export function discoverRuntimeSkills(sourceRoot: string): DiscoveredRuntimeSkill[] {
  const root = path.resolve(sourceRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Skill source directory not found: ${root}`);
  }

  const found = new Map<string, DiscoveredRuntimeSkill>();
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DISCOVERY_DEPTH) return;
    const skillFile = path.join(directory, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      const stat = fs.lstatSync(skillFile);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`SKILL.md must be a regular file: ${skillFile}`);
      }
      const raw = normalizeSkillMarkdown(fs.readFileSync(skillFile, "utf-8"));
      const metadata = parseSkillFrontmatter(raw);
      if (!metadata?.name || !metadata.description) {
        throw new Error(`SKILL.md must define name and description: ${skillFile}`);
      }
      const nameError = validateSkillName(metadata.name);
      if (nameError) throw new Error(`${nameError}: ${metadata.name}`);
      if (found.has(metadata.name)) {
        throw new Error(`Duplicate skill name "${metadata.name}" found in ${directory}`);
      }
      found.set(metadata.name, {
        name: metadata.name,
        description: metadata.description,
        directory,
        bundle: collectLocalSkillBundle(directory, metadata.name),
      });
      return;
    }

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (fs.lstatSync(child).isSymbolicLink()) continue;
      walk(child, depth + 1);
    }
  };

  walk(root, 0);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function projectPolpoDir(projectDir: string): string {
  const polpoDir = path.join(path.resolve(projectDir), ".polpo");
  if (!fs.existsSync(polpoDir)) {
    throw new Error(`No .polpo directory found in ${path.resolve(projectDir)}`);
  }
  return polpoDir;
}

function requireDirectoryAgents(polpoDir: string): void {
  if (detectAgentLayout(polpoDir) === "legacy") {
    throw new Error("Runtime skill assignment requires the directory-based agent layout. Run `polpo migrate` first.");
  }
}

function updateAgentSkillAssignments(
  polpoDir: string,
  agentNames: readonly string[],
  skillNames: readonly string[],
  operation: "assign" | "unassign",
): Array<{ agent: string; skill: string }> {
  if (agentNames.length === 0 || skillNames.length === 0) return [];
  requireDirectoryAgents(polpoDir);
  const entries = readProjectAgents(polpoDir);
  const byName = new Map(entries.map((entry) => [entry.agent.name, entry]));
  const missing = [...new Set(agentNames)].filter((name) => !byName.has(name));
  if (missing.length > 0) throw new Error(`Unknown agent${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);

  const changes: Array<{ agent: string; skill: string }> = [];
  for (const agentName of [...new Set(agentNames)]) {
    const entry = byName.get(agentName)!;
    const current = new Set(entry.agent.skills ?? []);
    for (const skillName of skillNames) {
      const had = current.has(skillName);
      if (operation === "assign") current.add(skillName);
      else current.delete(skillName);
      if (had !== current.has(skillName)) changes.push({ agent: agentName, skill: skillName });
    }
    writeProjectAgent(polpoDir, { ...entry.agent, skills: [...current].sort() }, entry.teamName);
  }
  return changes;
}

export function assignRuntimeSkills(
  projectDir: string,
  skillNames: readonly string[],
  agentNames: readonly string[],
): Array<{ agent: string; skill: string }> {
  const polpoDir = projectPolpoDir(projectDir);
  for (const skillName of skillNames) {
    if (!fs.existsSync(path.join(polpoDir, "skills", skillName, "SKILL.md"))) {
      throw new Error(`Unknown local runtime skill: ${skillName}`);
    }
  }
  return updateAgentSkillAssignments(polpoDir, agentNames, skillNames, "assign");
}

export function unassignRuntimeSkills(
  projectDir: string,
  skillNames: readonly string[],
  agentNames: readonly string[],
): Array<{ agent: string; skill: string }> {
  return updateAgentSkillAssignments(projectPolpoDir(projectDir), agentNames, skillNames, "unassign");
}

export function installRuntimeSkills(options: InstallRuntimeSkillsOptions): InstallRuntimeSkillsResult {
  const polpoDir = projectPolpoDir(options.projectDir);
  const selected = [...options.skills];
  if (selected.length === 0) throw new Error("No runtime skills selected");
  const duplicate = selected.find((skill, index) => selected.findIndex((candidate) => candidate.name === skill.name) !== index);
  if (duplicate) throw new Error(`Duplicate selected skill: ${duplicate.name}`);

  // Validate every requested mutation before writing the first bundle.
  if (options.agents?.length) {
    requireDirectoryAgents(polpoDir);
    const knownAgents = new Set(readProjectAgents(polpoDir).map(({ agent }) => agent.name));
    const missing = [...new Set(options.agents)].filter((name) => !knownAgents.has(name));
    if (missing.length > 0) throw new Error(`Unknown agent${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }

  const lock = readRuntimeSkillsLock(options.projectDir);
  const result: InstallRuntimeSkillsResult = {
    installed: [], updated: [], unchanged: [], skipped: [], assigned: [],
  };
  const now = (options.now ?? (() => new Date()))().toISOString();

  for (const skill of selected) {
    const target = path.join(polpoDir, "skills", skill.name);
    const digest = skillBundleDigest(skill.bundle);
    let write = true;
    if (fs.existsSync(target)) {
      const current = collectLocalSkillBundle(target, skill.name);
      if (skillBundleDigest(current) === digest) {
        result.unchanged.push(skill.name);
        write = false;
      } else if (!options.force) {
        result.skipped.push(skill.name);
        write = false;
      } else {
        result.updated.push(skill.name);
      }
    } else {
      result.installed.push(skill.name);
    }

    if (write) replaceLocalSkillBundle(target, skill.bundle);
    if (write || result.unchanged.includes(skill.name)) {
      lock.skills[skill.name] = {
        source: options.source,
        sourceSkill: skill.name,
        ...(options.revision ? { revision: options.revision } : {}),
        digest,
        installedAt: now,
      };
    }
  }

  if (options.agents?.length) {
    result.assigned = assignRuntimeSkills(options.projectDir, selected.map((skill) => skill.name), options.agents);
  }
  writeRuntimeSkillsLock(options.projectDir, lock);
  return result;
}

export function removeRuntimeSkill(projectDir: string, skillName: string): boolean {
  const polpoDir = projectPolpoDir(projectDir);
  const nameError = validateSkillName(skillName);
  if (nameError) throw new Error(nameError);
  const target = path.join(polpoDir, "skills", skillName);
  if (!fs.existsSync(target)) return false;

  requireDirectoryAgents(polpoDir);
  const assignedAgents = readProjectAgents(polpoDir)
    .filter(({ agent }) => agent.skills?.includes(skillName))
    .map(({ agent }) => agent.name);
  updateAgentSkillAssignments(polpoDir, assignedAgents, [skillName], "unassign");
  fs.rmSync(target, { recursive: true, force: true });
  const lock = readRuntimeSkillsLock(projectDir);
  delete lock.skills[skillName];
  writeRuntimeSkillsLock(projectDir, lock);
  return true;
}

export function listLocalRuntimeSkills(projectDir: string): Array<{
  name: string;
  description: string;
  assignedTo: string[];
  locked: boolean;
}> {
  const polpoDir = projectPolpoDir(projectDir);
  const skillsDir = path.join(polpoDir, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  const assignments = new Map<string, string[]>();
  for (const { agent } of readProjectAgents(polpoDir)) {
    for (const skill of agent.skills ?? []) {
      const names = assignments.get(skill) ?? [];
      names.push(agent.name);
      assignments.set(skill, names);
    }
  }
  const lock = readRuntimeSkillsLock(projectDir);
  return discoverRuntimeSkills(skillsDir).map((skill) => {
    if (path.dirname(skill.directory) !== skillsDir || path.basename(skill.directory) !== skill.name) {
      throw new Error(`Local runtime skill directory must match SKILL.md name: ${skill.name}`);
    }
    return {
    name: skill.name,
    description: skill.description,
    assignedTo: (assignments.get(skill.name) ?? []).sort(),
    locked: Boolean(lock.skills[skill.name]),
    };
  });
}
