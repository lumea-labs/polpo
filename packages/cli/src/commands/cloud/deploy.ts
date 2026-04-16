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
import { createApiClient, type ApiClient } from "./api.js";
import { isTTY, confirm } from "./prompt.js";
import { resolveKey, decrypt } from "@polpo-ai/vault-crypto";
import { AddAgentSchema } from "@polpo-ai/server";
import { friendlyError } from "../../util/errors.js";
import { pickOrg } from "../../util/org.js";
import { resolveOrCreateProject } from "../../util/project.js";
import { requireAuth } from "../../util/auth.js";

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

async function deployTeams(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const teams = loadJson(path.join(polpoDir, "teams.json"));
  if (!teams || !Array.isArray(teams)) return result;

  for (const team of teams) {
    if (!team.name || typeof team.name !== "string") {
      result.errors.push(`team missing "name" field`);
      result.failed++;
      continue;
    }
    const res = await client.post("/v1/agents/teams", { name: team.name, description: team.description });
    if (res.status >= 200 && res.status < 300) {
      result.created++;
    } else if (res.status === 409 || (res.data as any)?.error?.includes("already exists")) {
      result.skipped++;
    } else {
      const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
      result.errors.push(`team "${team.name}": ${friendlyError(msg)}`);
      result.failed++;
    }
  }
  return result;
}

async function deployAgents(client: ApiClient, polpoDir: string, force: boolean): Promise<DeployResult> {
  const result = emptyResult();
  const raw = loadJson(path.join(polpoDir, "agents.json"));
  if (!raw || !Array.isArray(raw)) {
    if (raw && !Array.isArray(raw)) {
      result.errors.push("agents.json must be a JSON array, e.g. [{ \"agent\": { \"name\": \"...\", ... }, \"teamName\": \"default\" }]");
      result.failed++;
    }
    return result;
  }

  // Fetch existing agents for upsert detection
  let existingNames = new Set<string>();
  try {
    const res = await client.get<any>("/v1/agents");
    if (res.status === 200) {
      const data = res.data?.data ?? res.data ?? [];
      if (Array.isArray(data)) existingNames = new Set(data.map((a: any) => a.name));
    }
  } catch { /* can't check — will try create */ }

  for (const entry of raw) {
    const agent = entry.agent ?? entry;
    const teamName = entry.teamName ?? "default";

    // Validate agent schema
    const parsed = AddAgentSchema.safeParse(agent);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join(", ");
      result.errors.push(`agent "${agent.name ?? "unknown"}": ${issues}`);
      result.failed++;
      continue;
    }

    const exists = existingNames.has(agent.name);

    if (exists) {
      if (!force && isTTY()) {
        const ok = await confirm(`  Agent "${agent.name}" already exists. Override?`);
        if (!ok) { result.skipped++; continue; }
      }
      const res = await client.put(`/v1/agents/${encodeURIComponent(agent.name)}`, { ...agent, team: teamName });
      if (res.status >= 200 && res.status < 300) {
        result.updated++;
      } else {
        const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
        result.errors.push(`agent "${agent.name}": update failed — ${friendlyError(msg)}`);
        result.failed++;
      }
    } else {
      const res = await client.post("/v1/agents", { ...agent, team: teamName });
      if (res.status >= 200 && res.status < 300) {
        result.created++;
      } else {
        const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
        result.errors.push(`agent "${agent.name}": create failed — ${friendlyError(msg)}`);
        result.failed++;
      }
    }
  }
  return result;
}

async function deployMemory(client: ApiClient, polpoDir: string): Promise<DeployResult> {
  const result = emptyResult();
  const shared = loadText(path.join(polpoDir, "memory.md"));
  if (shared) {
    const res = await client.put("/v1/memory", { content: shared });
    if (res.status >= 200 && res.status < 300) { result.updated++; }
    else { result.errors.push(`memory: ${friendlyError((res.data as any)?.error ?? `HTTP ${res.status}`)}`); result.failed++; }
  }
  const memDir = path.join(polpoDir, "memory");
  if (fs.existsSync(memDir)) {
    for (const file of fs.readdirSync(memDir).filter(f => f.endsWith(".md"))) {
      const agentName = file.replace(".md", "");
      const content = loadText(path.join(memDir, file));
      if (content) {
        const res = await client.put(`/v1/memory/agent/${agentName}`, { content });
        if (res.status >= 200 && res.status < 300) { result.updated++; }
        else { result.errors.push(`memory "${agentName}": ${friendlyError((res.data as any)?.error ?? `HTTP ${res.status}`)}`); result.failed++; }
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

async function deploySkills(client: ApiClient, polpoDir: string, force: boolean): Promise<DeployResult> {
  const result = emptyResult();
  const skillsDir = path.join(polpoDir, "skills");
  if (!fs.existsSync(skillsDir)) return result;
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

    // Try create first
    const res = await client.post("/v1/skills/create", {
      name, description, content,
      ...(allowedTools?.length ? { allowedTools } : {}),
    });

    if (res.status >= 200 && res.status < 300) {
      result.created++;
    } else if (res.status === 409 || (res.data as any)?.error?.includes("already exists")) {
      if (force) {
        // Update existing skill
        const updateRes = await client.put(`/v1/skills/${encodeURIComponent(name)}`, {
          description, content,
          ...(allowedTools?.length ? { allowedTools } : {}),
        });
        if (updateRes.status >= 200 && updateRes.status < 300) { result.updated++; }
        else { result.skipped++; }
      } else {
        result.skipped++;
      }
    } else {
      const msg = (res.data as any)?.error ?? `HTTP ${res.status}`;
      result.errors.push(`skill "${name}": ${friendlyError(msg)}`);
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
      // requireAuth auto-triggers device-code login if creds are missing/expired,
      // so a fresh user typing `polpo deploy` first goes through browser auth
      // instead of getting a "Not logged in" wall.
      const creds = await requireAuth({
        context: "Deploying requires an authenticated session.",
      });

      const polpoDir = resolvePolpoDir(opts.dir);
      const polpoConfig = loadJson(path.join(polpoDir, "polpo.json"));
      const projectName = polpoConfig?.project ?? path.basename(path.resolve(opts.dir));
      const force = opts.force || opts.yes || false;

      // Control plane client (no project context needed for orgs/projects)
      const cpClient = createApiClient(creds);

      console.log("\n  Polpo Deploy\n");

      // ── Step 1: Resolve project ────────────────────────
      let projectId: string | undefined = polpoConfig?.projectId;
      let projectSlug: string | undefined = polpoConfig?.projectSlug;

      if (!projectId) {
        try {
          // pickOrg handles the 0-org case inline (prompts to create one),
          // so a fresh user running `polpo deploy` against an empty account
          // gets a single graceful prompt instead of an exit.
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
          console.log(`  Project: ${project.name}\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ${friendlyError(msg)}`);
          process.exit(1);
        }
      }

      if (!projectId) {
        console.error("  No project resolved. Deploy from a project directory with .polpo/polpo.json");
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
        console.log("  Detected LLM keys:");
        for (const { envVar, value } of detected) {
          console.log(`    ${envVar.padEnd(25)} ${value.slice(0, 8)}...${value.slice(-4)}`);
        }
        console.log();

        if (isTTY() && !force) {
          const push = await confirm("  Push LLM keys to cloud?");
          if (push) {
            let n = 0;
            for (const { provider, value } of detected) {
              try { await cpClient.post("/v1/byok", { provider, key: value }); n++; } catch {}
            }
            if (n > 0) console.log(`  Pushed ${n} LLM key(s)\n`);
          } else {
            console.log();
          }
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

      console.log("  Resources to deploy:");
      if (hasAgents) {
        const agentsData = loadJson(path.join(polpoDir, "agents.json"));
        if (Array.isArray(agentsData)) {
          const names = agentsData.map((e: any) => (e.agent ?? e).name).filter(Boolean);
          console.log(`    Agents .......... ${names.length} (${names.join(", ")})`);
        }
      }
      if (hasTeams) {
        const teamsData = loadJson(path.join(polpoDir, "teams.json"));
        if (Array.isArray(teamsData)) {
          console.log(`    Teams ........... ${teamsData.length} (${teamsData.map((t: any) => t.name).join(", ")})`);
        }
      }
      if (hasMemory) console.log("    Memory .......... yes");
      if (hasMissions) {
        const n = fs.readdirSync(path.join(polpoDir, "missions")).filter(f => f.endsWith(".json")).length;
        console.log(`    Missions ........ ${n}`);
      }
      if (hasPlaybooks) console.log("    Playbooks ....... yes");
      if (hasSkills) {
        const n = fs.readdirSync(path.join(polpoDir, "skills")).filter(
          (d) => fs.statSync(path.join(polpoDir, "skills", d)).isDirectory()
        ).length;
        console.log(`    Skills .......... ${n}`);
      }
      if (hasSchedules) {
        const n = fs.readdirSync(path.join(polpoDir, "schedules")).filter(f => f.endsWith(".json")).length;
        console.log(`    Schedules ....... ${n}`);
      }
      if (hasVault) console.log("    Vault ........... yes");
      if (hasAvatars) console.log("    Avatars ......... yes");
      if (includeTasks && hasTasks) console.log("    Tasks ........... yes");
      if (includeSessions && hasSessions) console.log("    Sessions ........ yes");
      console.log("");

      if (!force && isTTY()) {
        const ok = await confirm("  Deploy?");
        if (!ok) {
          console.log("  Aborted.");
          process.exit(0);
        }
        console.log();
      }

      // ── Step 4: Deploy ────────────────────────
      console.log("  Deploying...");
      const total = emptyResult();

      if (hasTeams) { mergeResult(total, await deployTeams(client, polpoDir)); }
      if (hasAgents) { mergeResult(total, await deployAgents(client, polpoDir, force)); }
      if (hasMemory) { mergeResult(total, await deployMemory(client, polpoDir)); }
      if (hasMissions) { mergeResult(total, await deployMissions(client, polpoDir)); }
      if (hasPlaybooks) { mergeResult(total, await deployPlaybooks(client, polpoDir)); }
      if (hasSkills) { mergeResult(total, await deploySkills(client, polpoDir, force)); }
      if (hasSchedules) { mergeResult(total, await deploySchedules(client, polpoDir)); }
      if (hasVault) { mergeResult(total, await deployVault(client, polpoDir)); }
      if (hasAvatars) { mergeResult(total, await deployAvatars(client, polpoDir, creds.baseUrl, creds.apiKey)); }
      if (includeTasks && hasTasks) { mergeResult(total, await deployTasks(client, polpoDir)); }
      if (includeSessions && hasSessions) { mergeResult(total, await deploySessions(client, polpoDir)); }

      // ── Summary ────────────────────────
      const parts: string[] = [];
      if (total.created > 0) parts.push(`${total.created} created`);
      if (total.updated > 0) parts.push(`${total.updated} updated`);
      if (total.skipped > 0) parts.push(`${total.skipped} skipped`);
      if (total.failed > 0) parts.push(`${total.failed} failed`);

      if (total.errors.length > 0) {
        console.log("\n  Errors:");
        for (const err of total.errors) console.log(`    - ${err}`);
      }

      console.log(`\n  Result: ${parts.join(", ") || "nothing to deploy"}\n`);

      process.exit(total.failed > 0 ? 1 : 0);
    });
}
