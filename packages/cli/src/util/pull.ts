/**
 * polpo pull — download cloud project state into the local .polpo/ directory.
 *
 * The inverse of `polpo deploy`. Fetches agents, teams, memory, skills,
 * missions, playbooks, and schedules from the data plane API and writes
 * them in the exact format that the CLI and FileStores expect on disk.
 *
 * Each resource is compared against the local version before writing.
 * In interactive mode, the user is prompted per-resource when they differ.
 * In force mode (--yes / --force), cloud always wins.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ApiClient } from "../commands/cloud/api.js";
import {
  resolveJsonConflict,
  resolveFileConflict,
  type ConflictOptions,
} from "./conflicts.js";

export interface PullOptions extends ConflictOptions {}

export interface PullResult {
  pulled: string[];
  unchanged: string[];
  skipped: string[];
  errors: string[];
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
}

export async function pullProject(
  client: ApiClient,
  polpoDir: string,
  opts: PullOptions = { force: true, interactive: false },
): Promise<PullResult> {
  ensureDir(polpoDir);

  const result: PullResult = { pulled: [], unchanged: [], skipped: [], errors: [] };

  // ── Agents ──────────────────────────────────
  try {
    const res = await client.get<any>("/v1/agents");
    if (res.status === 200) {
      const agents = res.data?.data ?? res.data ?? [];
      if (Array.isArray(agents) && agents.length > 0) {
        const entries = agents.map((a: any) => ({
          agent: {
            name: a.name,
            role: a.role,
            model: a.model,
            systemPrompt: a.systemPrompt,
            allowedTools: a.allowedTools,
            allowedPaths: a.allowedPaths,
            skills: a.skills,
            maxTurns: a.maxTurns,
            maxConcurrency: a.maxConcurrency,
            reasoning: a.reasoning,
            reportsTo: a.reportsTo,
            identity: a.identity,
            browserProfile: a.browserProfile,
            emailAllowedDomains: a.emailAllowedDomains,
          },
          teamName: a.teamName ?? a.team ?? "default",
        }));
        const clean = JSON.parse(JSON.stringify(entries));
        const filePath = path.join(polpoDir, "agents.json");
        const action = await resolveJsonConflict(filePath, clean, `agents.json (${agents.length} agents)`, opts);
        if (action === "write") {
          writeJson(filePath, clean);
          result.pulled.push(`agents (${agents.length})`);
        } else if (action === "skip") {
          if (fs.existsSync(filePath)) result.skipped.push("agents (local kept)");
          else result.unchanged.push("agents");
        }
      } else {
        result.unchanged.push("agents (none in cloud)");
      }
    }
  } catch (err) {
    result.errors.push(`agents: ${(err as Error).message}`);
  }

  // ── Teams ──────────────────────────────────
  try {
    const res = await client.get<any>("/v1/agents/teams");
    if (res.status === 200) {
      const teams = res.data?.data ?? res.data ?? [];
      if (Array.isArray(teams) && teams.length > 0) {
        const clean = JSON.parse(JSON.stringify(
          teams.map((t: any) => ({ name: t.name, description: t.description })),
        ));
        const filePath = path.join(polpoDir, "teams.json");
        const action = await resolveJsonConflict(filePath, clean, `teams.json (${teams.length} teams)`, opts);
        if (action === "write") {
          writeJson(filePath, clean);
          result.pulled.push(`teams (${teams.length})`);
        } else if (action === "skip") {
          result.skipped.push("teams (local kept)");
        }
      } else {
        result.unchanged.push("teams (none in cloud)");
      }
    }
  } catch (err) {
    result.errors.push(`teams: ${(err as Error).message}`);
  }

  // ── Memory (shared) ──────────────────────────────────
  try {
    const res = await client.get<any>("/v1/memory");
    if (res.status === 200) {
      const content = res.data?.content ?? res.data;
      if (typeof content === "string" && content.trim()) {
        const filePath = path.join(polpoDir, "memory.md");
        const action = await resolveFileConflict(filePath, content, "memory.md (shared)", opts);
        if (action === "write") {
          writeText(filePath, content);
          result.pulled.push("memory (shared)");
        } else {
          result.skipped.push("memory (local kept)");
        }
      } else {
        result.unchanged.push("memory (empty)");
      }
    }
  } catch (err) {
    result.errors.push(`memory: ${(err as Error).message}`);
  }

  // ── Memory (per-agent) ──────────────────────────────────
  try {
    const agentsRes = await client.get<any>("/v1/agents");
    const agents = agentsRes.data?.data ?? agentsRes.data ?? [];
    if (Array.isArray(agents)) {
      for (const a of agents) {
        try {
          const memRes = await client.get<any>(`/v1/memory/agent/${encodeURIComponent(a.name)}`);
          if (memRes.status === 200) {
            const content = memRes.data?.content ?? memRes.data;
            if (typeof content === "string" && content.trim()) {
              const filePath = path.join(polpoDir, "memory", `${a.name}.md`);
              const action = await resolveFileConflict(filePath, content, `memory/${a.name}.md`, opts);
              if (action === "write") {
                writeText(filePath, content);
                result.pulled.push(`memory (${a.name})`);
              } else {
                result.skipped.push(`memory/${a.name} (local kept)`);
              }
            }
          }
        } catch { /* agent has no memory — skip */ }
      }
    }
  } catch { /* agents list failed — skip agent memories */ }

  // ── Skills ──────────────────────────────────
  try {
    const res = await client.get<any>("/v1/skills");
    if (res.status === 200) {
      const skills = res.data?.data ?? res.data ?? [];
      if (Array.isArray(skills)) {
        for (const skill of skills) {
          try {
            const contentRes = await client.get<any>(
              `/v1/skills/${encodeURIComponent(skill.name)}/content`,
            );
            if (contentRes.status === 200) {
              const content = contentRes.data?.content ?? contentRes.data;
              if (typeof content === "string" && content.trim()) {
                const filePath = path.join(polpoDir, "skills", skill.name, "SKILL.md");
                const action = await resolveFileConflict(filePath, content, `skill "${skill.name}"`, opts);
                if (action === "write") {
                  writeText(filePath, content);
                  result.pulled.push(`skill (${skill.name})`);
                } else {
                  result.skipped.push(`skill/${skill.name} (local kept)`);
                }
              }
            }
          } catch {
            result.errors.push(`skill "${skill.name}": could not fetch content`);
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(`skills: ${(err as Error).message}`);
  }

  // ── Missions ──────────────────────────────────
  try {
    const res = await client.get<any>("/v1/missions");
    if (res.status === 200) {
      const missions = res.data?.data ?? res.data ?? [];
      if (Array.isArray(missions) && missions.length > 0) {
        for (const m of missions) {
          const filename = (m.name ?? m.id ?? "mission").replace(/[^a-zA-Z0-9._-]/g, "-");
          const data = {
            name: m.name,
            data: m.data,
            prompt: m.prompt,
            status: m.status,
            schedule: m.schedule,
            deadline: m.deadline,
          };
          const filePath = path.join(polpoDir, "missions", `${filename}.json`);
          const action = await resolveJsonConflict(filePath, data, `mission "${m.name ?? filename}"`, opts);
          if (action === "write") {
            writeJson(filePath, data);
            result.pulled.push(`mission (${m.name ?? filename})`);
          } else {
            result.skipped.push(`mission/${filename} (local kept)`);
          }
        }
      } else {
        result.unchanged.push("missions (none in cloud)");
      }
    }
  } catch (err) {
    result.errors.push(`missions: ${(err as Error).message}`);
  }

  // ── Playbooks ──────────────────────────────────
  try {
    const res = await client.get<any>("/v1/playbooks");
    if (res.status === 200) {
      const playbooks = res.data?.data ?? res.data ?? [];
      if (Array.isArray(playbooks) && playbooks.length > 0) {
        for (const pb of playbooks) {
          const dirname = (pb.name ?? "playbook").replace(/[^a-zA-Z0-9._-]/g, "-");
          const data = {
            name: pb.name,
            description: pb.description,
            mission: pb.mission,
            parameters: pb.parameters,
          };
          const filePath = path.join(polpoDir, "playbooks", dirname, "playbook.json");
          const action = await resolveJsonConflict(filePath, data, `playbook "${pb.name ?? dirname}"`, opts);
          if (action === "write") {
            writeJson(filePath, data);
            result.pulled.push(`playbook (${pb.name ?? dirname})`);
          } else {
            result.skipped.push(`playbook/${dirname} (local kept)`);
          }
        }
      } else {
        result.unchanged.push("playbooks (none in cloud)");
      }
    }
  } catch (err) {
    result.errors.push(`playbooks: ${(err as Error).message}`);
  }

  // ── Schedules ──────────────────────────────────
  try {
    const res = await client.get<any>("/v1/schedules");
    if (res.status === 200) {
      const schedules = res.data?.data ?? res.data ?? [];
      if (Array.isArray(schedules) && schedules.length > 0) {
        for (const sc of schedules) {
          const filename = (sc.name ?? sc.missionId ?? "schedule").replace(/[^a-zA-Z0-9._-]/g, "-");
          const filePath = path.join(polpoDir, "schedules", `${filename}.json`);
          const action = await resolveJsonConflict(filePath, sc, `schedule "${sc.name ?? filename}"`, opts);
          if (action === "write") {
            writeJson(filePath, sc);
            result.pulled.push(`schedule (${sc.name ?? filename})`);
          } else {
            result.skipped.push(`schedule/${filename} (local kept)`);
          }
        }
      } else {
        result.unchanged.push("schedules (none in cloud)");
      }
    }
  } catch (err) {
    result.errors.push(`schedules: ${(err as Error).message}`);
  }

  // Vault is NOT pulled — the API only returns metadata (keys, not values).

  return result;
}
