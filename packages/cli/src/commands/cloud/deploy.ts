/**
 * polpo deploy — sync local .polpo/ project to cloud.
 *
 * Core (always deployed):
 *   - agents/<id>/agent.json + instructions.md (agent definitions)
 *   - teams/<id>.json (team structure)
 *   - memory.md + memory/<agent>.md (knowledge base)
 *   - playbooks/ (mission templates)
 *   - missions/ (mission definitions)
 *   - skills/ (complete Agent Skills bundles)
 *   - vault.enc (encrypted credentials)
 *
 * Opt-in (with flags):
 *   --include-tasks     Deploy tasks
 *   --include-sessions  Deploy chat sessions
 *   --all               Deploy everything (seamless local→cloud migration)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import * as clack from "@clack/prompts";
import { createApiClient, type ApiClient } from "./api.js";
import { resolveKey, decrypt } from "@polpo-ai/vault-crypto";
import { AddAgentSchema } from "@polpo-ai/server";
import { readProjectAgents, readProjectTeams } from "@polpo-ai/file-stores";
import { friendlyError } from "../../util/errors.js";
import { pickOrg } from "../../util/org.js";
import { resolveOrCreateProject } from "../../util/project.js";
import { requireAuth } from "../../util/auth.js";
import { isTTY } from "./prompt.js";
import { resolveDeployConflict, type ConflictOptions } from "../../util/conflicts.js";
import { listLoopSourceFiles, loadLoopDeployPayload } from "../../util/loops.js";
import { prepareScheduleDeployments } from "../../util/schedules.js";
import { readPolpoConfig, writePolpoConfig } from "../../util/polpo-config.js";
import {
  collectCustomToolSourceArtifact,
  extractCustomToolName,
} from "../../util/custom-tool-source.js";
import { collectLocalSkillBundle } from "../../util/runtime-skill-bundle.js";
import type { SkillBundle } from "@polpo-ai/core/skill-bundle";

// ── Deploy result tracking ──────────────────────────────

export interface DeployResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
  details: string[];
}

function emptyResult(): DeployResult {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    details: [],
  };
}

function mergeResult(target: DeployResult, source: DeployResult): void {
  target.created += source.created;
  target.updated += source.updated;
  target.skipped += source.skipped;
  target.failed += source.failed;
  target.errors.push(...source.errors);
  target.details.push(...source.details);
}

/** A deploy is unsuccessful if either failure counter or error detail says so. */
export function hasDeployFailures(result: DeployResult): boolean {
  return result.failed > 0 || result.errors.length > 0;
}

export function deployExitCode(result: DeployResult): 0 | 1 {
  return hasDeployFailures(result) ? 1 : 0;
}

// ── Helpers ──────────────────────────────────────────────

function resolvePolpoDir(dir: string): string {
  const polpoDir = path.resolve(dir, ".polpo");
  if (!fs.existsSync(polpoDir)) {
    console.error(pc.red(`No .polpo/ found in ${path.resolve(dir)}`));
    console.error(pc.dim("\n  This directory isn't a Polpo project yet. To get started:\n"));
    console.error(pc.dim("    polpo create               ") + pc.bold("scaffold a new project here"));
    console.error(pc.dim("    polpo link --project-id X  ") + pc.bold("attach this dir to an existing cloud project"));
    process.exit(1);
  }
  return polpoDir;
}

function loadJson(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    console.error(`Warning: Could not parse ${filePath}`);
    return null;
  }
}

function loadText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => path.join(dir, f));
}

/**
 * Returns a spinner-shaped object whose start/stop/message are no-ops.
 * Used when `runDeploy` is invoked under a caller that already drives a
 * spinner (e.g. `polpo create`'s "Deploying agents to cloud...") so we
 * don't get two animations fighting for the same TTY row.
 */
function createNullSpinner() {
  return {
    start: (_msg?: string) => undefined,
    stop:  (_msg?: string) => undefined,
    message: (_msg?: string) => undefined,
  } as ReturnType<typeof clack.spinner>;
}

/**
 * Extract the most useful error string from an API response body, regardless
 * of whether the server returned `{ error: "string" }`, `{ error: { ... } }`,
 * `{ error: [issue, …] }`, or nothing. Falls back to "HTTP <status>" so
 * downstream consumers (friendlyError) always get a non-empty input.
 */
function readErrorBody(body: unknown, status: number): unknown {
  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err === "string" && err.length > 0) return err;
  if (err && typeof err === "object") return err;
  return `HTTP ${status}`;
}

// ── Core deployers ──────────────────────────────────────

async function deployTeams(client: ApiClient, polpoDir: string, opts: ConflictOptions): Promise<DeployResult> {
  const result = emptyResult();
  const teams = readProjectTeams(polpoDir);
  if (teams.length === 0) return result;

  // Fetch existing teams for conflict detection
  let existingTeams: Record<string, any> = {};
  try {
    const res = await client.get<any>("/v1/agents/teams");
    if (res.status === 200) {
      const data = res.data?.data ?? res.data ?? [];
      if (Array.isArray(data)) {
        for (const t of data) existingTeams[t.name] = t;
      }
    }
  } catch { /* proceed without comparison */ }

  for (const team of teams) {
    if (!team.name || typeof team.name !== "string") {
      result.errors.push(`team missing "name" field`);
      result.failed++;
      continue;
    }

    const remote = existingTeams[team.name];
    const local = { name: team.name, description: team.description };
    const action = await resolveDeployConflict(local, remote, `team "${team.name}"`, opts);

    if (action === "skip") {
      result.skipped++;
      continue;
    }

    if (remote) {
      const res = await client.patch(
        `/v1/agents/teams/${encodeURIComponent(team.name)}`,
        { description: team.description },
      );
      if (res.status >= 200 && res.status < 300) { result.updated++; }
      else {
        const msg = readErrorBody(res.data, res.status);
        result.errors.push(`team "${team.name}": ${friendlyError(msg)}`);
        result.failed++;
      }
    } else {
      const res = await client.post("/v1/agents/teams", local);
      if (res.status >= 200 && res.status < 300) { result.created++; }
      else {
        const msg = readErrorBody(res.data, res.status);
        result.errors.push(`team "${team.name}": ${friendlyError(msg)}`);
        result.failed++;
      }
    }
  }
  return result;
}

async function deployAgents(client: ApiClient, polpoDir: string, opts: ConflictOptions): Promise<DeployResult> {
  const result = emptyResult();
  const entries = readProjectAgents(polpoDir);
  if (entries.length === 0) return result;

  // Fetch existing agents for conflict detection
  let existingAgents: Record<string, any> = {};
  try {
    const res = await client.get<any>("/v1/agents");
    if (res.status === 200) {
      const data = res.data?.data ?? res.data ?? [];
      if (Array.isArray(data)) {
        for (const a of data) existingAgents[a.name] = a;
      }
    }
  } catch { /* proceed without comparison */ }

  for (const entry of entries) {
    const { agent, teamName } = entry;

    const parsed = AddAgentSchema.safeParse(agent);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join(", ");
      result.errors.push(`agent "${agent.name ?? "unknown"}": ${issues}`);
      result.failed++;
      continue;
    }

    const remote = existingAgents[agent.name];
    const action = await resolveDeployConflict(agent, remote, `agent "${agent.name}"`, opts);

    if (action === "skip") {
      result.skipped++;
      continue;
    }

    if (remote) {
      // Update existing — server exposes PATCH /v1/agents/{name}, not PUT.
      // Using PUT here would 404 ("Resource not found") on the server side.
      const res = await client.patch(`/v1/agents/${encodeURIComponent(agent.name)}`, { ...agent, team: teamName });
      if (res.status >= 200 && res.status < 300) { result.updated++; }
      else {
        const msg = readErrorBody(res.data, res.status);
        result.errors.push(`agent "${agent.name}": update failed — ${friendlyError(msg)}`);
        result.failed++;
      }
    } else {
      const res = await client.post("/v1/agents", { ...agent, team: teamName });
      if (res.status >= 200 && res.status < 300) { result.created++; }
      else {
        const msg = readErrorBody(res.data, res.status);
        result.errors.push(`agent "${agent.name}": create failed — ${friendlyError(msg)}`);
        result.failed++;
      }
    }
  }
  return result;
}

async function deployLoops(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const files = listLoopSourceFiles(polpoDir);
  for (const file of files) {
    let loop: Awaited<ReturnType<typeof loadLoopDeployPayload>>;
    try {
      loop = await loadLoopDeployPayload(file);
    } catch (err) {
      result.errors.push(`loop "${path.basename(file)}": validation failed — ${friendlyError(err)}`);
      result.failed++;
      continue;
    }
    if (!loop.name) {
      result.errors.push(`loop "${path.basename(file)}": missing name`);
      result.failed++;
      continue;
    }
    const res = await client.post("/v1/loops", loop.body);
    if (res.status >= 200 && res.status < 300) result.updated++;
    else {
      const msg = readErrorBody(res.data, res.status);
      result.errors.push(`loop "${loop.name}": deploy failed — ${friendlyError(msg)}`);
      result.failed++;
    }
  }
  return result;
}

async function deployMemory(client: ApiClient, polpoDir: string, opts: ConflictOptions): Promise<DeployResult> {
  const result = emptyResult();
  const shared = loadText(path.join(polpoDir, "memory.md"));
  if (shared) {
    // Fetch existing shared memory for comparison
    let remoteShared: string | null = null;
    try {
      const r = await client.get<any>("/v1/memory");
      // Server returns { ok, data: { exists, content } } — unwrap both layers.
      if (r.status === 200) remoteShared = r.data?.data?.content ?? r.data?.content ?? null;
    } catch {}

    const action = await resolveDeployConflict(shared, remoteShared, "shared memory", opts);
    if (action === "write") {
      const res = await client.put("/v1/memory", { content: shared });
      if (res.status >= 200 && res.status < 300) { result.updated++; }
      else { result.errors.push(`memory: ${friendlyError(readErrorBody(res.data, res.status))}`); result.failed++; }
    } else {
      result.skipped++;
    }
  }

  const memDir = path.join(polpoDir, "memory");
  if (fs.existsSync(memDir)) {
    for (const file of fs.readdirSync(memDir).filter(f => f.endsWith(".md"))) {
      const agentName = file.replace(".md", "");
      const content = loadText(path.join(memDir, file));
      if (content) {
        let remoteAgent: string | null = null;
        try {
          const r = await client.get<any>(`/v1/memory/agent/${agentName}`);
          if (r.status === 200) remoteAgent = r.data?.data?.content ?? r.data?.content ?? null;
        } catch {}

        const action = await resolveDeployConflict(content, remoteAgent, `memory "${agentName}"`, opts);
        if (action === "write") {
          const res = await client.put(`/v1/memory/agent/${agentName}`, { content });
          if (res.status >= 200 && res.status < 300) { result.updated++; }
          else { result.errors.push(`memory "${agentName}": ${friendlyError(readErrorBody(res.data, res.status))}`); result.failed++; }
        } else {
          result.skipped++;
        }
      }
    }
  }
  return result;
}

async function deployMissions(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const files = listJsonFiles(path.join(polpoDir, "missions"));
  for (const file of files) {
    const mission = loadJson(file);
    if (!mission) continue;
    const res = await client.post("/v1/missions", {
      name: mission.name,
      data: typeof mission.data === "string" ? mission.data : JSON.stringify(mission.data),
      prompt: mission.prompt,
      status: mission.status ?? "draft",
      schedule: mission.schedule,
      deadline: mission.deadline,
      notifications: mission.notifications,
    });
    if (res.status >= 200 && res.status < 300) { result.created++; }
    else {
      const msg = readErrorBody(res.data, res.status);
      result.errors.push(`mission "${mission.name ?? path.basename(file)}": ${friendlyError(msg)}`);
      result.failed++;
    }
  }
  return result;
}

async function deployPlaybooks(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const playbooksDir = path.join(polpoDir, "playbooks");
  if (!fs.existsSync(playbooksDir)) return result;
  for (const entry of fs.readdirSync(playbooksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pbFile = path.join(playbooksDir, entry.name, "playbook.json");
    const playbook = loadJson(pbFile);
    if (!playbook) continue;
    const res = await client.post("/v1/playbooks", {
      name: playbook.name ?? entry.name,
      description: playbook.description,
      mission: typeof playbook.mission === "string" ? playbook.mission : JSON.stringify(playbook.mission),
      parameters: playbook.parameters,
    });
    if (res.status >= 200 && res.status < 300) { result.created++; }
    else {
      const msg = readErrorBody(res.data, res.status);
      result.errors.push(`playbook "${entry.name}": ${friendlyError(msg)}`);
      result.failed++;
    }
  }
  return result;
}

/** Push custom tool entrypoints and their local dependency graphs. [beta] */
async function deployTools(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const toolsDir = path.join(polpoDir, "tools");
  if (!fs.existsSync(toolsDir)) return result;

  const existing = new Set<string>();
  try {
    const res = await client.get<any>("/v1/tools");
    if (res.status >= 200 && res.status < 300) {
      for (const t of (res.data?.data ?? [])) existing.add(t.name);
    }
  } catch { /* listing is best-effort for create/update counting */ }

  for (const file of fs.readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(toolsDir, file), "utf-8");
    const name = extractCustomToolName(source);
    if (!name) continue;
    try {
      const artifact = await collectCustomToolSourceArtifact(
        path.join(toolsDir, file),
        toolsDir,
      );
      const res = await client.post<any>("/v1/tools", { name, artifact });
      if (res.status >= 200 && res.status < 300) {
        if (existing.has(name)) result.updated++; else result.created++;
      } else {
        const d = res.data as { error?: string; details?: string[] };
        result.errors.push(`tool "${name}": ${friendlyError(d?.details?.join("; ") ?? d?.error ?? `HTTP ${res.status}`)}`);
        result.failed++;
      }
    } catch (err) {
      result.errors.push(`tool "${name}": ${(err as Error).message}`);
      result.failed++;
    }
  }
  return result;
}

async function deploySkills(client: ApiClient, polpoDir: string, opts: ConflictOptions): Promise<DeployResult> {
  const result = emptyResult();
  const skillsDir = path.join(polpoDir, "skills");
  if (!fs.existsSync(skillsDir)) return result;

  // Fetch existing skills for conflict detection
  let existingSkills: Record<string, any> = {};
  try {
    const res = await client.get<any>("/v1/skills");
    if (res.status === 200) {
      const data = res.data?.data ?? res.data ?? [];
      if (Array.isArray(data)) {
        for (const s of data) existingSkills[s.name] = s;
      }
    }
  } catch {}

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    let localBundle: SkillBundle;
    try {
      localBundle = collectLocalSkillBundle(path.join(skillsDir, entry.name), entry.name);
    } catch (error) {
      result.errors.push(`skill "${entry.name}": ${error instanceof Error ? error.message : String(error)}`);
      result.failed++;
      continue;
    }

    const name = localBundle.name;
    const remote = existingSkills[name];
    let remoteBundle: SkillBundle | null = null;
    if (remote) {
      const bundleRes = await client.get<any>(`/v1/skills/${encodeURIComponent(name)}/bundle`);
      if (bundleRes.status === 200) remoteBundle = bundleRes.data?.data ?? bundleRes.data;
    }
    const action = await resolveDeployConflict(localBundle, remoteBundle, `skill "${name}"`, opts);

    if (action === "skip") {
      result.skipped++;
      continue;
    }

    const res = await client.put(`/v1/skills/${encodeURIComponent(name)}/bundle`, {
      files: localBundle.files,
    });
    if (res.status >= 200 && res.status < 300) {
      if (remote) result.updated++; else result.created++;
    } else {
      const msg = readErrorBody(res.data, res.status);
      result.errors.push(`skill "${name}": bundle deploy failed — ${friendlyError(msg)}`);
      result.failed++;
    }
  }
  return result;
}

async function deployVault(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const vaultPath = path.join(polpoDir, "vault.enc");
  if (!fs.existsSync(vaultPath)) return result;

  let key: Buffer;
  try { key = resolveKey(); }
  catch (err: any) {
    result.errors.push(`vault: cannot resolve key — ${err.message}. Set POLPO_VAULT_KEY or ensure ~/.polpo/vault.key exists.`);
    result.failed++;
    return result;
  }

  let vaultData: Record<string, Record<string, any>>;
  try {
    const plaintext = decrypt(fs.readFileSync(vaultPath), key);
    vaultData = JSON.parse(plaintext.toString("utf-8"));
  } catch (err: any) {
    result.errors.push(`vault: cannot decrypt — ${err.message}`);
    result.failed++;
    return result;
  }

  for (const [agent, services] of Object.entries(vaultData)) {
    for (const [service, entry] of Object.entries(services)) {
      const res = await client.post("/v1/vault/entries", {
        agent, service,
        type: entry.type ?? "custom",
        label: entry.label,
        credentials: entry.credentials,
      });
      if (res.status >= 200 && res.status < 300) { result.created++; }
      else {
        const msg = readErrorBody(res.data, res.status);
        result.errors.push(`vault "${agent}/${service}": ${friendlyError(msg)}`);
        result.failed++;
      }
    }
  }
  return result;
}

async function deployAvatars(client: ApiClient, polpoDir: string, baseUrl: string, apiKey: string): Promise<DeployResult> {
  const result = emptyResult();
  const avatarsDir = path.join(polpoDir, "avatars");
  if (!fs.existsSync(avatarsDir)) return result;
  const files = fs.readdirSync(avatarsDir).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(ext);
  });
  if (files.length === 0) return result;

  try {
    await fetch(`${baseUrl}/v1/files/mkdir`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: ".polpo/avatars" }),
    });
  } catch { /* may already exist */ }

  for (const file of files) {
    const formData = new FormData();
    formData.append("path", ".polpo/avatars");
    formData.append("file", new Blob([fs.readFileSync(path.join(avatarsDir, file))]), file);
    try {
      const res = await fetch(`${baseUrl}/v1/files/upload`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: formData,
      });
      if (res.ok) { result.created++; }
      else { result.errors.push(`avatar "${file}": HTTP ${res.status}`); result.failed++; }
    } catch (err: any) {
      result.errors.push(`avatar "${file}": ${err.message}`);
      result.failed++;
    }
  }
  return result;
}

// ── Opt-in deployers ──────────────────────────────────────

export async function deploySchedules(
  client: ApiClient,
  polpoDir: string,
): Promise<DeployResult> {
  const result = emptyResult();
  const schedules = prepareScheduleDeployments(polpoDir);
  for (const schedule of schedules) {
    result.details.push(...schedule.warnings);
    result.details.push(
      `${schedule.name}: next ${schedule.nextOccurrenceAt ?? "none"} (${schedule.timezone})`,
    );
    const res = await client.post("/v1/schedules", schedule.payload);
    if (res.status >= 200 && res.status < 300) { result.created++; }
    else {
      const msg = readErrorBody(res.data, res.status);
      result.errors.push(`schedule "${schedule.name}": ${friendlyError(msg)}`);
      result.failed++;
      continue;
    }
    const response = (res.data as { data?: unknown } | null)?.data ?? res.data;
    const driver = response && typeof response === "object"
      ? (response as { driver?: { status?: unknown } }).driver
      : undefined;
    if (typeof driver?.status === "string") {
      result.details.push(`${schedule.name}: driver ${driver.status}`);
    }
  }
  return result;
}

async function deployTasks(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const files = listJsonFiles(path.join(polpoDir, "tasks"));
  for (const file of files) {
    const task = loadJson(file);
    if (!task) continue;
    const res = await client.post("/v1/tasks", {
      title: task.title, description: task.description,
      assignTo: task.assignTo, group: task.group,
      missionId: task.missionId, dependsOn: task.dependsOn,
      expectations: task.expectations, metrics: task.metrics,
      maxRetries: task.maxRetries, maxDuration: task.maxDuration,
      deadline: task.deadline, priority: task.priority,
      draft: task.draft,
    });
    if (res.status >= 200 && res.status < 300) { result.created++; }
    else {
      const msg = readErrorBody(res.data, res.status);
      result.errors.push(`task "${task.title ?? path.basename(file)}": ${friendlyError(msg)}`);
      result.failed++;
    }
  }
  return result;
}

async function deploySessions(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const sessionsDir = path.join(polpoDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return result;
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));

  for (const file of files) {
    const raw = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());
    if (lines.length === 0) continue;

    let title: string | undefined;
    let agent: string | undefined;
    const messages: Array<{ role: "user" | "assistant"; content: string; toolCalls?: unknown[] }> = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._session) { title = obj.title; agent = obj.agent; }
        else if (obj.role && obj.content) {
          messages.push({ role: obj.role, content: obj.content, ...(obj.toolCalls ? { toolCalls: obj.toolCalls } : {}) });
        }
      } catch { /* skip malformed lines */ }
    }

    if (messages.length === 0) continue;

    const res = await client.post("/v1/chat/sessions/import", { title, agent, messages });
    if (res.status >= 200 && res.status < 300) { result.created++; }
    else {
      const msg = readErrorBody(res.data, res.status);
      result.errors.push(`session "${title ?? file}": ${friendlyError(msg)}`);
      result.failed++;
    }
  }
  return result;
}

// ── Reusable deploy runner ──────────────────────────────
//
// Extracted so both the `polpo deploy` command and `polpo create`
// (auto-deploy after scaffold) can share the same logic. This function
// does NOT call clack.intro/outro or process.exit — callers own the
// framing UI. It throws on fatal errors (no project resolved, etc.).

export interface DeployOptions {
  dir: string;
  yes?: boolean;
  force?: boolean;
  includeTasks?: boolean;
  includeSessions?: boolean;
  all?: boolean;
  /** Suppress the "Push LLM keys?" prompt + resource summary + confirmation. */
  silent?: boolean;
}

export interface DeployReport {
  total: DeployResult;
  endpoint?: string;
  projectName: string;
  nothingToDeploy?: boolean;
}

export async function runDeploy(opts: DeployOptions): Promise<DeployReport> {
  const creds = await requireAuth({
    context: "Deploying requires an authenticated session.",
  });

  const polpoDir = resolvePolpoDir(opts.dir);
  const polpoConfig = readPolpoConfig(opts.dir);
  const projectName = polpoConfig?.project ?? path.basename(path.resolve(opts.dir));
  const force = opts.force || opts.yes || false;
  const interactive = !opts.silent && !force && isTTY();

  const cpClient = createApiClient(creds);
  // When called by an outer flow (e.g. `polpo create`) with `silent: true`,
  // that flow already owns a spinner — opening another here causes terminal
  // flicker (two spinners writing to the same row at the same time). The
  // null-spinner is a tiny shim that no-ops start/stop so all the existing
  // `s.start(...)` / `s.stop(...)` call sites keep working unchanged.
  const s = opts.silent ? createNullSpinner() : clack.spinner();

  // ── Step 1: Resolve project ────────────────────────
  let projectId: string | undefined = polpoConfig?.projectId;
  let projectSlug: string | undefined = polpoConfig?.projectSlug;

  if (!projectId) {
    const org = await pickOrg(cpClient);
    const project = await resolveOrCreateProject({
      client: cpClient,
      orgId: org.id,
      name: projectName,
      force,
      interactive: isTTY(),
    });
    projectId = project.id;
    projectSlug = project.slug;
    if (!opts.silent) clack.log.success(`Project: ${pc.bold(project.name)}`);
  }

  if (!projectId) {
    throw new Error("No project resolved. Deploy from a directory with .polpo/project.json");
  }

      // Backfill `projectSlug` for users with legacy polpo.json (id only).
      if (!projectSlug && projectId) {
        try {
          const fresh = await import("../../util/project.js").then((m) =>
            m.getProject(cpClient, projectId!),
          );
          if (fresh?.slug) projectSlug = fresh.slug;
        } catch {}
      }

      const client = createApiClient(creds, projectId);

      // Persist whichever fields we resolved/discovered for next time.
      if (polpoConfig && (!polpoConfig.projectId || (projectSlug && !polpoConfig.projectSlug))) {
        polpoConfig.projectId = projectId;
        if (projectSlug) polpoConfig.projectSlug = projectSlug;
        writePolpoConfig(opts.dir, {
          projectId,
          ...(projectSlug ? { projectSlug } : {}),
        });
      }

      // ── Step 2: Detect LLM keys ────────────────────────
      const LLM_KEYS: Record<string, string> = {
        ANTHROPIC_API_KEY: "anthropic",
        OPENAI_API_KEY: "openai",
        GEMINI_API_KEY: "google",
        XAI_API_KEY: "xai",
        GROQ_API_KEY: "groq",
        OPENROUTER_API_KEY: "openrouter",
        MISTRAL_API_KEY: "mistral",
        CEREBRAS_API_KEY: "cerebras",
        MINIMAX_API_KEY: "minimax",
        HF_TOKEN: "huggingface",
        AZURE_OPENAI_API_KEY: "azure-openai-responses",
      };

      const detected: { envVar: string; provider: string; value: string }[] = [];

      for (const [envVar, provider] of Object.entries(LLM_KEYS)) {
        if (process.env[envVar]) {
          detected.push({ envVar, provider, value: process.env[envVar]! });
        }
      }

      const envFile = path.join(polpoDir, ".env");
      if (fs.existsSync(envFile)) {
        for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
          const t = line.trim();
          if (!t || t.startsWith("#")) continue;
          const eq = t.indexOf("=");
          if (eq === -1) continue;
          const k = t.slice(0, eq).trim();
          const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
          if (LLM_KEYS[k] && v && !detected.find(d => d.envVar === k)) {
            detected.push({ envVar: k, provider: LLM_KEYS[k], value: v });
          }
        }
      }

      if (detected.length > 0 && !opts.silent) {
        clack.log.info(
          `Detected LLM keys:\n` +
          detected.map(({ envVar, value }) =>
            `  ${pc.dim(envVar.padEnd(25))} ${pc.bold(value.slice(0, 8))}...${value.slice(-4)}`
          ).join("\n"),
        );

        let pushKeys = force;
        if (!pushKeys && interactive) {
          const answer = await clack.confirm({
            message: "Push LLM keys to cloud?",
            initialValue: true,
          });
          pushKeys = !clack.isCancel(answer) && !!answer;
        }

        if (pushKeys) {
          s.start("Pushing LLM keys...");
          let n = 0;
          for (const { provider, value } of detected) {
            try { await cpClient.post("/v1/byok", { provider, key: value }); n++; } catch {}
          }
          s.stop(n > 0 ? `Pushed ${n} LLM key(s)` : "No keys pushed");
        }
      }

      // ── Step 3: Scan & show resources ────────────────────
      const hasTeams = readProjectTeams(polpoDir).length > 0;
      const hasAgents = readProjectAgents(polpoDir).length > 0;
      const loopSources = listLoopSourceFiles(polpoDir);
      const hasLoops = loopSources.length > 0;
      const hasMemory = fs.existsSync(path.join(polpoDir, "memory.md")) ||
        fs.existsSync(path.join(polpoDir, "memory"));
      const hasMissions = fs.existsSync(path.join(polpoDir, "missions")) &&
        fs.readdirSync(path.join(polpoDir, "missions")).length > 0;
      const hasPlaybooks = fs.existsSync(path.join(polpoDir, "playbooks"));
      const hasSkills = fs.existsSync(path.join(polpoDir, "skills")) &&
        fs.readdirSync(path.join(polpoDir, "skills")).some(
          (d) => fs.statSync(path.join(polpoDir, "skills", d)).isDirectory()
        );
      const hasSchedules = fs.existsSync(path.join(polpoDir, "schedules")) &&
        fs.readdirSync(path.join(polpoDir, "schedules")).length > 0;
      const hasVault = fs.existsSync(path.join(polpoDir, "vault.enc"));
      const hasTools = fs.existsSync(path.join(polpoDir, "tools")) &&
        fs.readdirSync(path.join(polpoDir, "tools")).some((f) => f.endsWith(".ts"));
      const hasAvatars = fs.existsSync(path.join(polpoDir, "avatars")) &&
        fs.readdirSync(path.join(polpoDir, "avatars")).length > 0;
      const hasTasks = fs.existsSync(path.join(polpoDir, "tasks")) &&
        fs.readdirSync(path.join(polpoDir, "tasks")).length > 0;
      const hasSessions = fs.existsSync(path.join(polpoDir, "sessions")) &&
        fs.readdirSync(path.join(polpoDir, "sessions")).length > 0;

      const includeTasks = opts.all || opts.includeTasks;
      const includeSessions = opts.all || opts.includeSessions;

      // Build resource summary lines
      const resourceLines: string[] = [];
      if (hasAgents) {
        const names = readProjectAgents(polpoDir).map(({ agent }) => agent.name);
        resourceLines.push(`  ${pc.bold("Agents")}       ${names.length} ${pc.dim(`(${names.join(", ")})`)}`)
      }
      if (hasTeams) {
        const teamsData = readProjectTeams(polpoDir);
        resourceLines.push(`  ${pc.bold("Teams")}        ${teamsData.length} ${pc.dim(`(${teamsData.map((team) => team.name).join(", ")})`)}`);
      }
      if (hasLoops) {
        resourceLines.push(`  ${pc.bold("Loops")}        ${loopSources.length} ${pc.dim("(beta)")}`);
      }
      if (hasMemory) resourceLines.push(`  ${pc.bold("Memory")}       ${pc.dim("shared + agent")}`);
      if (hasMissions) {
        const n = fs.readdirSync(path.join(polpoDir, "missions")).filter(f => f.endsWith(".json")).length;
        resourceLines.push(`  ${pc.bold("Missions")}     ${n}`);
      }
      if (hasPlaybooks) resourceLines.push(`  ${pc.bold("Playbooks")}    yes`);
      if (hasSkills) {
        const n = fs.readdirSync(path.join(polpoDir, "skills")).filter(
          (d) => fs.statSync(path.join(polpoDir, "skills", d)).isDirectory()
        ).length;
        resourceLines.push(`  ${pc.bold("Skills")}       ${n}`);
      }
      if (hasTools) {
        const n = fs.readdirSync(path.join(polpoDir, "tools")).filter((f) => f.endsWith(".ts")).length;
        resourceLines.push(`  ${pc.bold("Tools")}        ${n} ${pc.dim("(beta)")}`);
      }
      if (hasSchedules) {
        const n = fs.readdirSync(path.join(polpoDir, "schedules")).filter(f => f.endsWith(".json")).length;
        resourceLines.push(`  ${pc.bold("Schedules")}    ${n}`);
      }
      if (hasVault) resourceLines.push(`  ${pc.bold("Vault")}        ${pc.dim("encrypted credentials")}`);
      if (hasAvatars) resourceLines.push(`  ${pc.bold("Avatars")}      yes`);
      if (includeTasks && hasTasks) resourceLines.push(`  ${pc.bold("Tasks")}        yes`);
      if (includeSessions && hasSessions) resourceLines.push(`  ${pc.bold("Sessions")}     yes`);

      if (resourceLines.length === 0) {
        return { total: emptyResult(), projectName, nothingToDeploy: true };
      }

      if (!opts.silent) {
        clack.log.info(`Resources to deploy:\n${resourceLines.join("\n")}`);
      }

      if (interactive) {
        const ok = await clack.confirm({
          message: "Deploy these resources to cloud?",
          initialValue: true,
        });
        if (clack.isCancel(ok) || !ok) {
          throw new Error("cancelled");
        }
      }

      // ── Step 4: Deploy each resource ────────────────────
      const total = emptyResult();

      // Track the current spinner label so the conflict-resolver can pause
      // the spinner before a `clack.confirm` (otherwise the spinner keeps
      // animating on top of the prompt → flicker + invisible question)
      // and resume it after the user answers.
      let activeSpinnerLabel: string | null = null;
      const conflictOpts: ConflictOptions = {
        force,
        interactive,
        beforePrompt: () => { if (activeSpinnerLabel) s.stop(""); },
        afterPrompt:  () => { if (activeSpinnerLabel) s.start(activeSpinnerLabel); },
      };

      const startSpinner = (label: string) => {
        activeSpinnerLabel = label;
        s.start(label);
      };
      const stopSpinner = (final: string) => {
        activeSpinnerLabel = null;
        s.stop(final);
      };

      if (hasTeams) {
        startSpinner("Deploying teams...");
        const r = await deployTeams(client, polpoDir, conflictOpts);
        mergeResult(total, r);
        stopSpinner(`Teams: ${r.created} created, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      // Skills and custom tools are dependencies of loops and agents. Deploy
      // them first so a clean project succeeds in one pass instead of relying
      // on a second reconciliation after "unknown tool" validation errors.
      if (hasSkills) {
        startSpinner("Deploying skills...");
        const r = await deploySkills(client, polpoDir, conflictOpts);
        mergeResult(total, r);
        stopSpinner(`Skills: ${r.created} created, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasTools) {
        s.start("Deploying custom tools...");
        const r = await deployTools(client, polpoDir);
        mergeResult(total, r);
        s.stop(`Tools: ${r.created} created${r.updated ? `, ${r.updated} updated` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasLoops) {
        s.start("Deploying loops...");
        const r = await deployLoops(client, polpoDir);
        mergeResult(total, r);
        s.stop(`Loops: ${r.updated} updated${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasAgents) {
        startSpinner("Deploying agents...");
        const r = await deployAgents(client, polpoDir, conflictOpts);
        mergeResult(total, r);
        stopSpinner(`Agents: ${r.created} created, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasMemory) {
        startSpinner("Deploying memory...");
        const r = await deployMemory(client, polpoDir, conflictOpts);
        mergeResult(total, r);
        stopSpinner(`Memory: ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasMissions) {
        s.start("Deploying missions...");
        const r = await deployMissions(client, polpoDir);
        mergeResult(total, r);
        s.stop(`Missions: ${r.created} created${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasPlaybooks) {
        s.start("Deploying playbooks...");
        const r = await deployPlaybooks(client, polpoDir);
        mergeResult(total, r);
        s.stop(`Playbooks: ${r.created} created${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasSchedules) {
        s.start("Deploying schedules...");
        const r = await deploySchedules(client, polpoDir);
        mergeResult(total, r);
        s.stop(`Schedules: ${r.created} created${r.failed ? `, ${r.failed} failed` : ""}`);
        if (!opts.silent && r.details.length > 0) {
          clack.log.info(r.details.map((detail) => `  ${detail}`).join("\n"));
        }
      }

      if (hasVault) {
        s.start("Deploying vault...");
        const r = await deployVault(client, polpoDir);
        mergeResult(total, r);
        s.stop(`Vault: ${r.created} created${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasAvatars) {
        s.start("Deploying avatars...");
        const r = await deployAvatars(client, polpoDir, creds.baseUrl, creds.apiKey);
        mergeResult(total, r);
        s.stop(`Avatars: ${r.created} uploaded${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (includeTasks && hasTasks) {
        s.start("Deploying tasks...");
        const r = await deployTasks(client, polpoDir);
        mergeResult(total, r);
        s.stop(`Tasks: ${r.created} created${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (includeSessions && hasSessions) {
        s.start("Deploying sessions...");
        const r = await deploySessions(client, polpoDir);
        mergeResult(total, r);
        s.stop(`Sessions: ${r.created} imported${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      // ── Summary ────────────────────────
      if (total.errors.length > 0 && !opts.silent) {
        clack.log.warn(
          `Errors:\n` +
          total.errors.map(e => `  ${pc.red("x")} ${e}`).join("\n"),
        );
      }

      const endpoint = projectSlug ? `https://${projectSlug}.polpo.cloud` : undefined;
      return { total, endpoint, projectName };
}

// ── Main command ──────────────────────────────────────

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy")
    .description("Deploy local .polpo/ project to cloud")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("-y, --yes", "Skip all confirmation prompts")
    .option("-f, --force", "Force override existing resources without asking")
    .option("--include-tasks", "Also deploy tasks")
    .option("--include-sessions", "Also deploy chat sessions")
    .option("--all", "Deploy everything (full local→cloud migration)")
    .action(async (opts) => {
      clack.intro(pc.bold("Polpo — Deploy"));

      let report: DeployReport;
      try {
        report = await runDeploy({
          dir: opts.dir,
          yes: opts.yes,
          force: opts.force,
          includeTasks: opts.includeTasks,
          includeSessions: opts.includeSessions,
          all: opts.all,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "cancelled") {
          clack.outro(pc.dim("Deploy cancelled."));
          process.exit(0);
        }
        clack.outro(pc.red(friendlyError(msg)));
        process.exit(1);
      }

      if (report.nothingToDeploy) {
        clack.outro(pc.yellow("Nothing to deploy — .polpo/ has no resources."));
        process.exit(0);
      }

      const { total, endpoint } = report;
      const summaryParts: string[] = [];
      if (total.created > 0) summaryParts.push(`${total.created} created`);
      if (total.updated > 0) summaryParts.push(`${total.updated} updated`);
      if (total.skipped > 0) summaryParts.push(`${total.skipped} skipped`);
      if (total.failed > 0) summaryParts.push(pc.red(`${total.failed} failed`));

      const outroLines: string[] = [];
      if (!hasDeployFailures(total)) {
        outroLines.push(pc.green(`✓ Deployed: ${summaryParts.join(", ")}`));
      } else {
        outroLines.push(pc.yellow(`Deployed with errors: ${summaryParts.join(", ")}`));
      }
      if (endpoint) {
        outroLines.push(pc.dim(`  Endpoint: ${pc.bold(endpoint)}`));
      }

      clack.outro(outroLines.join("\n"));
      process.exit(deployExitCode(total));
    });
}
