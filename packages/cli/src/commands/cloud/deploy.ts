/**
 * polpo deploy — sync local .polpo/ project to cloud.
 *
 * Core (always deployed):
 *   - agents.json (agent definitions)
 *   - teams.json (team structure)
 *   - memory.md + memory/<agent>.md (knowledge base)
 *   - playbooks/ (mission templates)
 *   - missions/ (mission definitions)
 *   - skills/ (SKILL.md files)
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
import { friendlyError } from "../../util/errors.js";
import { pickOrg } from "../../util/org.js";
import { resolveOrCreateProject } from "../../util/project.js";
import { requireAuth } from "../../util/auth.js";
import { isTTY } from "./prompt.js";
import { resolveDeployConflict, type ConflictOptions } from "../../util/conflicts.js";

// ── Deploy result tracking ──────────────────────────────

interface DeployResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

function emptyResult(): DeployResult {
  return { created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };
}

function mergeResult(target: DeployResult, source: DeployResult): void {
  target.created += source.created;
  target.updated += source.updated;
  target.skipped += source.skipped;
  target.failed += source.failed;
  target.errors.push(...source.errors);
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

// ── Core deployers ──────────────────────────────────────

async function deployTeams(client: ApiClient, polpoDir: string, opts: ConflictOptions): Promise<DeployResult> {
  const result = emptyResult();
  const teams = loadJson(path.join(polpoDir, "teams.json"));
  if (!teams || !Array.isArray(teams)) return result;

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
      // Update existing
      const res = await client.put(`/v1/agents/team`, { name: team.name, description: team.description });
      if (res.status >= 200 && res.status < 300) { result.updated++; }
      else {
        const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
        result.errors.push(`team "${team.name}": ${friendlyError(msg)}`);
        result.failed++;
      }
    } else {
      const res = await client.post("/v1/agents/teams", local);
      if (res.status >= 200 && res.status < 300) { result.created++; }
      else {
        const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
        result.errors.push(`team "${team.name}": ${friendlyError(msg)}`);
        result.failed++;
      }
    }
  }
  return result;
}

async function deployAgents(client: ApiClient, polpoDir: string, opts: ConflictOptions): Promise<DeployResult> {
  const result = emptyResult();
  const raw = loadJson(path.join(polpoDir, "agents.json"));
  if (!raw || !Array.isArray(raw)) {
    if (raw && !Array.isArray(raw)) {
      result.errors.push("agents.json must be a JSON array, e.g. [{ \"agent\": { \"name\": \"...\", ... }, \"teamName\": \"default\" }]");
      result.failed++;
    }
    return result;
  }

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

  for (const entry of raw) {
    const agent = entry.agent ?? entry;
    const teamName = entry.teamName ?? "default";

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
      const res = await client.put(`/v1/agents/${encodeURIComponent(agent.name)}`, { ...agent, team: teamName });
      if (res.status >= 200 && res.status < 300) { result.updated++; }
      else {
        const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
        result.errors.push(`agent "${agent.name}": update failed — ${friendlyError(msg)}`);
        result.failed++;
      }
    } else {
      const res = await client.post("/v1/agents", { ...agent, team: teamName });
      if (res.status >= 200 && res.status < 300) { result.created++; }
      else {
        const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
        result.errors.push(`agent "${agent.name}": create failed — ${friendlyError(msg)}`);
        result.failed++;
      }
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
      if (r.status === 200) remoteShared = r.data?.content ?? null;
    } catch {}

    const action = await resolveDeployConflict(shared, remoteShared, "shared memory", opts);
    if (action === "write") {
      const res = await client.put("/v1/memory", { content: shared });
      if (res.status >= 200 && res.status < 300) { result.updated++; }
      else { result.errors.push(`memory: ${friendlyError((res.data as any)?.error ?? `HTTP ${res.status}`)}`); result.failed++; }
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
          if (r.status === 200) remoteAgent = r.data?.content ?? null;
        } catch {}

        const action = await resolveDeployConflict(content, remoteAgent, `memory "${agentName}"`, opts);
        if (action === "write") {
          const res = await client.put(`/v1/memory/agent/${agentName}`, { content });
          if (res.status >= 200 && res.status < 300) { result.updated++; }
          else { result.errors.push(`memory "${agentName}": ${friendlyError((res.data as any)?.error ?? `HTTP ${res.status}`)}`); result.failed++; }
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
      const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
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
      const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
      result.errors.push(`playbook "${entry.name}": ${friendlyError(msg)}`);
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

    const raw = fs.readFileSync(skillFile, "utf-8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    let name = entry.name;
    let description = "";
    let allowedTools: string[] | undefined;

    if (fmMatch) {
      const lines = fmMatch[1].split("\n");
      let currentArray: string[] | null = null;
      for (const line of lines) {
        const arrayItem = line.match(/^\s+-\s+(.+)/);
        if (arrayItem && currentArray) { currentArray.push(arrayItem[1].trim()); continue; }
        currentArray = null;
        const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)?/);
        if (kv) {
          const key = kv[1]; const val = kv[2]?.trim();
          if (key === "name" && val) name = val;
          if (key === "description" && val) description = val;
          if (key === "allowed-tools" || key === "allowedTools") { allowedTools = []; currentArray = allowedTools; }
        }
      }
    }

    const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    const content = bodyMatch ? bodyMatch[1].trim() : raw.trim();
    const localSkill = { name, description, content };
    const remote = existingSkills[name];
    const action = await resolveDeployConflict(localSkill, remote ? { name: remote.name, description: remote.description, content: remote.content } : null, `skill "${name}"`, opts);

    if (action === "skip") {
      result.skipped++;
      continue;
    }

    if (remote) {
      const updateRes = await client.put(`/v1/skills/${encodeURIComponent(name)}`, {
        description, content,
        ...(allowedTools?.length ? { allowedTools } : {}),
      });
      if (updateRes.status >= 200 && updateRes.status < 300) { result.updated++; }
      else {
        const msg = (updateRes.data as any)?.error ?? `HTTP ${updateRes.status}`;
        result.errors.push(`skill "${name}": ${friendlyError(msg)}`);
        result.failed++;
      }
    } else {
      const res = await client.post("/v1/skills/create", {
        name, description, content,
        ...(allowedTools?.length ? { allowedTools } : {}),
      });
      if (res.status >= 200 && res.status < 300) { result.created++; }
      else {
        const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
        result.errors.push(`skill "${name}": ${friendlyError(msg)}`);
        result.failed++;
      }
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
        const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
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

async function deploySchedules(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const files = listJsonFiles(path.join(polpoDir, "schedules"));
  for (const file of files) {
    const schedule = loadJson(file);
    if (!schedule) continue;
    const res = await client.post("/v1/schedules", schedule);
    if (res.status >= 200 && res.status < 300) { result.created++; }
    else {
      const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
      result.errors.push(`schedule "${schedule.name ?? path.basename(file)}": ${friendlyError(msg)}`);
      result.failed++;
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
    });
    if (res.status >= 200 && res.status < 300) { result.created++; }
    else {
      const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
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
      const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
      result.errors.push(`session "${title ?? file}": ${friendlyError(msg)}`);
      result.failed++;
    }
  }
  return result;
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

      const creds = await requireAuth({
        context: "Deploying requires an authenticated session.",
      });

      const polpoDir = resolvePolpoDir(opts.dir);
      const polpoConfig = loadJson(path.join(polpoDir, "polpo.json"));
      const projectName = polpoConfig?.project ?? path.basename(path.resolve(opts.dir));
      const force = opts.force || opts.yes || false;
      const interactive = !force && isTTY();

      const cpClient = createApiClient(creds);
      const s = clack.spinner();

      // ── Step 1: Resolve project ────────────────────────
      let projectId: string | undefined = polpoConfig?.projectId;
      let projectSlug: string | undefined = polpoConfig?.projectSlug;

      if (!projectId) {
        try {
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
          clack.log.success(`Project: ${pc.bold(project.name)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          clack.outro(pc.red(friendlyError(msg)));
          process.exit(1);
        }
      }

      if (!projectId) {
        clack.outro(pc.red("No project resolved. Deploy from a directory with .polpo/polpo.json"));
        process.exit(1);
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
        fs.writeFileSync(path.join(polpoDir, "polpo.json"), JSON.stringify(polpoConfig, null, 2), "utf-8");
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

      if (detected.length > 0) {
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
      const hasTeams = fs.existsSync(path.join(polpoDir, "teams.json"));
      const hasAgents = fs.existsSync(path.join(polpoDir, "agents.json"));
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
        const agentsData = loadJson(path.join(polpoDir, "agents.json"));
        if (Array.isArray(agentsData)) {
          const names = agentsData.map((e: any) => (e.agent ?? e).name).filter(Boolean);
          resourceLines.push(`  ${pc.bold("Agents")}       ${names.length} ${pc.dim(`(${names.join(", ")})`)}`)
        }
      }
      if (hasTeams) {
        const teamsData = loadJson(path.join(polpoDir, "teams.json"));
        if (Array.isArray(teamsData)) {
          resourceLines.push(`  ${pc.bold("Teams")}        ${teamsData.length} ${pc.dim(`(${teamsData.map((t: any) => t.name).join(", ")})`)}`);
        }
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
      if (hasSchedules) {
        const n = fs.readdirSync(path.join(polpoDir, "schedules")).filter(f => f.endsWith(".json")).length;
        resourceLines.push(`  ${pc.bold("Schedules")}    ${n}`);
      }
      if (hasVault) resourceLines.push(`  ${pc.bold("Vault")}        ${pc.dim("encrypted credentials")}`);
      if (hasAvatars) resourceLines.push(`  ${pc.bold("Avatars")}      yes`);
      if (includeTasks && hasTasks) resourceLines.push(`  ${pc.bold("Tasks")}        yes`);
      if (includeSessions && hasSessions) resourceLines.push(`  ${pc.bold("Sessions")}     yes`);

      if (resourceLines.length === 0) {
        clack.outro(pc.yellow("Nothing to deploy — .polpo/ has no resources."));
        process.exit(0);
      }

      clack.log.info(`Resources to deploy:\n${resourceLines.join("\n")}`);

      if (interactive) {
        const ok = await clack.confirm({
          message: "Deploy these resources to cloud?",
          initialValue: true,
        });
        if (clack.isCancel(ok) || !ok) {
          clack.outro(pc.dim("Deploy cancelled."));
          process.exit(0);
        }
      }

      // ── Step 4: Deploy each resource ────────────────────
      const total = emptyResult();
      const conflictOpts: ConflictOptions = { force, interactive };

      if (hasTeams) {
        s.start("Deploying teams...");
        const r = await deployTeams(client, polpoDir, conflictOpts);
        mergeResult(total, r);
        s.stop(`Teams: ${r.created} created, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasAgents) {
        s.start("Deploying agents...");
        const r = await deployAgents(client, polpoDir, conflictOpts);
        mergeResult(total, r);
        s.stop(`Agents: ${r.created} created, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasMemory) {
        s.start("Deploying memory...");
        const r = await deployMemory(client, polpoDir, conflictOpts);
        mergeResult(total, r);
        s.stop(`Memory: ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
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

      if (hasSkills) {
        s.start("Deploying skills...");
        const r = await deploySkills(client, polpoDir, conflictOpts);
        mergeResult(total, r);
        s.stop(`Skills: ${r.created} created, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
      }

      if (hasSchedules) {
        s.start("Deploying schedules...");
        const r = await deploySchedules(client, polpoDir);
        mergeResult(total, r);
        s.stop(`Schedules: ${r.created} created${r.failed ? `, ${r.failed} failed` : ""}`);
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
      if (total.errors.length > 0) {
        clack.log.warn(
          `Errors:\n` +
          total.errors.map(e => `  ${pc.red("x")} ${e}`).join("\n"),
        );
      }

      const summaryParts: string[] = [];
      if (total.created > 0) summaryParts.push(`${total.created} created`);
      if (total.updated > 0) summaryParts.push(`${total.updated} updated`);
      if (total.skipped > 0) summaryParts.push(`${total.skipped} skipped`);
      if (total.failed > 0) summaryParts.push(pc.red(`${total.failed} failed`));

      const endpoint = projectSlug ? `https://${projectSlug}.polpo.cloud` : "";
      const outroLines: string[] = [];
      if (total.failed === 0) {
        outroLines.push(pc.green(`✓ Deployed: ${summaryParts.join(", ")}`));
      } else {
        outroLines.push(pc.yellow(`Deployed with errors: ${summaryParts.join(", ")}`));
      }
      if (endpoint) {
        outroLines.push(pc.dim(`  Endpoint: ${pc.bold(endpoint)}`));
      }

      clack.outro(outroLines.join("\n"));
      process.exit(total.failed > 0 ? 1 : 0);
    });
}
