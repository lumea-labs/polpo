/**
 * Build the system prompt for an agent.
 *
 * Pure logic — no runtime dependencies (Node.js, pi-ai, filesystem).
 * Used by any runtime (self-hosted or managed).
 *
 * Includes: preamble, identity, responsibilities, tone, personality, hierarchy,
 * custom systemPrompt, and optionally skills (if provided).
 *
 * Does NOT include: tool descriptions, cwd, output dir, sandbox paths.
 * Those are shell-specific and appended by the caller.
 */
import type { AgentConfig } from "./types.js";
import type { LoadedSkill } from "./skills-reader.js";
import { buildSkillPrompt } from "./skills-reader.js";

export interface AgentPromptOptions {
  /** Pre-loaded skills to inject into the prompt. */
  skills?: LoadedSkill[];
}

export interface FilesystemWorkspacePromptOptions {
  /** Agent working directory used as cwd for runtime tools. */
  cwd: string;
  /** Agent filesystem sandbox paths. Relative entries are resolved against cwd. */
  allowedPaths?: string[];
}

function normalizePosixPath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  if (absolute) return `/${normalized}`.replace(/\/+$/, "") || "/";
  return normalized || ".";
}

function resolveWorkspacePath(cwd: string, path: string): string {
  return normalizePosixPath(path.startsWith("/") ? path : `${cwd}/${path}`);
}

export function resolveAgentAllowedPaths(cwd: string, allowedPaths?: string[]): string[] {
  const configured = Array.isArray(allowedPaths)
    ? allowedPaths.filter((path) => typeof path === "string" && path.trim().length > 0)
    : [];
  const paths = configured.length > 0 ? configured : [cwd];
  return [...new Set(paths.map((path) => resolveWorkspacePath(cwd, path)))];
}

/**
 * Build the runtime filesystem contract that callers should append to the
 * final system prompt whenever filesystem/shell tools are available.
 */
export function buildFilesystemWorkspacePrompt(options: FilesystemWorkspacePromptOptions): string {
  const cwd = resolveWorkspacePath("/", options.cwd);
  const allowedPaths = resolveAgentAllowedPaths(cwd, options.allowedPaths);
  return [
    "## Filesystem Workspace",
    "",
    `Your working directory is \`${cwd}\`.`,
    "",
    "File tools (`read`, `write`, `edit`, `ls`, `glob`, `grep`) can only access these directories:",
    ...allowedPaths.map((path) => `- \`${path}\``),
    "",
    "Use relative paths or paths inside the directories above. Do not create project files under `/tmp`, `/home`, or other locations unless that exact directory is listed above.",
    "Bash commands start in the working directory, but files created outside the allowed directories may not be readable or editable by later file tools.",
    "If a requested path is outside the allowed directories, adapt it to the working directory or explain that `allowedPaths` must be changed first.",
  ].join("\n");
}

/**
 * Build the system prompt for an agent.
 *
 * @param agent - Agent configuration (identity, role, systemPrompt, etc.)
 * @param options - Optional: skills to inject.
 */
export function buildAgentSystemPrompt(agent: AgentConfig, options?: AgentPromptOptions): string {
  const parts = [
    `You are ${agent.name}, a ${agent.role ?? "helpful assistant"}.`,
    "Complete your assigned task autonomously. Make reasonable decisions and proceed without asking questions.",
    "",
    "Your task description may include context tags:",
    "- <shared-memory> — persistent shared knowledge from previous sessions, visible to all agents",
    "- <agent-memory> — your private memory from previous sessions (specific to you)",
    "- <system-context> — standing instructions from the project owner",
    "- <plan-context> — the plan goal and other tasks being worked on in parallel",
    "Use this context to make better decisions, but focus on YOUR assigned task.",
  ];

  // Identity block
  if (agent.identity) {
    parts.push("", "## Your Identity");
    if (agent.identity.displayName) parts.push(`- Name: ${agent.identity.displayName}`);
    if (agent.identity.title) parts.push(`- Title: ${agent.identity.title}`);
    if (agent.identity.company) parts.push(`- Company: ${agent.identity.company}`);
    if (agent.identity.email) parts.push(`- Email: ${agent.identity.email}`);
    if (agent.identity.bio) parts.push(`- Bio: ${agent.identity.bio}`);
    if (agent.identity.timezone) parts.push(`- Timezone: ${agent.identity.timezone}`);
    if (agent.identity.socials && Object.keys(agent.identity.socials).length > 0) {
      const entries = Object.entries(agent.identity.socials).map(([k, v]) => `${k}: ${v}`).join(", ");
      parts.push(`- Socials: ${entries}`);
    }
    parts.push("Use this identity when communicating externally (emails, messages, etc.).");
  }

  // Responsibilities
  if (agent.identity?.responsibilities?.length) {
    parts.push("", "## Your Responsibilities");
    for (const r of agent.identity.responsibilities) {
      if (typeof r === "string") {
        parts.push(`- ${r}`);
      } else {
        const prio = r.priority ? ` [${r.priority}]` : "";
        parts.push(`- **${r.area}**${prio}: ${r.description}`);
      }
    }
    parts.push("Focus on these responsibilities. Escalate if something falls outside your scope.");
  }

  // Communication tone
  if (agent.identity?.tone) {
    parts.push("", "## Communication Style");
    parts.push(agent.identity.tone);
  }

  // Personality
  if (agent.identity?.personality) {
    parts.push("", "## Personality");
    parts.push(agent.identity.personality);
  }

  // Hierarchy
  if (agent.reportsTo) {
    parts.push("", "## Organization");
    parts.push(`You report to: ${agent.reportsTo}`);
    parts.push("If you encounter blockers or decisions outside your authority, escalate to your manager.");
  }

  // Custom system prompt
  if (agent.systemPrompt) parts.push("", agent.systemPrompt);

  // Skills
  if (options?.skills?.length) {
    const skillBlock = buildSkillPrompt(options.skills);
    if (skillBlock) parts.push("", skillBlock);
  }

  return parts.join("\n");
}
