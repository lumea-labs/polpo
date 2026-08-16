import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentConfig, Team } from "@polpo-ai/core/types";
import {
  AGENT_CONFIG_FILENAME,
  AGENT_INSTRUCTIONS_FILENAME,
  DEFAULT_TEAM_NAME,
  assertProjectResourceId,
  materializeAgentDefinition,
  materializeTeamDefinition,
  serializeAgentDefinition,
  serializeTeamDefinition,
} from "@polpo-ai/core/project-layout";

export type ProjectResourceLayout = "legacy" | "directory";

export interface ProjectAgentEntry {
  agent: AgentConfig;
  teamName: string;
}

export interface ProjectLayoutMigrationResult {
  dryRun: boolean;
  changed: boolean;
  agents: number;
  teams: number;
  projectConfig: boolean;
  backups: string[];
}

export class ProjectLayoutFilesystemError extends Error {
  readonly code:
    | "ambiguous_layout"
    | "case_collision"
    | "invalid_json"
    | "invalid_legacy_layout"
    | "missing_agent_file";

  constructor(
    code: ProjectLayoutFilesystemError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ProjectLayoutFilesystemError";
    this.code = code;
  }
}

function atomicWrite(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, contents, "utf-8");
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function writeJson(filePath: string, value: unknown): void {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new ProjectLayoutFilesystemError(
      "invalid_json",
      `Could not parse ${label} at ${filePath}: ${(error as Error).message}`,
    );
  }
}

function directoryNames(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => statSync(join(directory, entry)).isDirectory())
    .sort((a, b) => a.localeCompare(b, "en"));
}

function jsonFilenames(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json") && statSync(join(directory, entry)).isFile())
    .sort((a, b) => a.localeCompare(b, "en"));
}

function assertNoCaseCollisions(kind: "agent" | "team", ids: string[]): void {
  const seen = new Map<string, string>();
  for (const id of ids) {
    const folded = id.normalize("NFKC").toLocaleLowerCase("en-US");
    const previous = seen.get(folded);
    if (previous && previous !== id) {
      throw new ProjectLayoutFilesystemError(
        "case_collision",
        `${kind === "agent" ? "Agent" : "Team"} ids "${previous}" and "${id}" collide on case-insensitive filesystems`,
      );
    }
    seen.set(folded, id);
  }
}

function directoryAgentIds(polpoDir: string): string[] {
  const agentsDir = join(polpoDir, "agents");
  return directoryNames(agentsDir).filter((id) =>
    existsSync(join(agentsDir, id, AGENT_CONFIG_FILENAME))
  );
}

export function detectAgentLayout(polpoDir: string): ProjectResourceLayout {
  const hasLegacy = existsSync(join(polpoDir, "agents.json"));
  const agentIds = directoryAgentIds(polpoDir);
  if (hasLegacy && agentIds.length > 0) {
    throw new ProjectLayoutFilesystemError(
      "ambiguous_layout",
      "Both .polpo/agents.json and directory-based agent definitions exist. Remove one authoritative format before continuing.",
    );
  }
  if (agentIds.length > 0 || (!hasLegacy && existsSync(join(polpoDir, "agents")))) {
    return "directory";
  }
  return "legacy";
}

export function readProjectAgents(polpoDir: string): ProjectAgentEntry[] {
  if (detectAgentLayout(polpoDir) === "legacy") {
    const filePath = join(polpoDir, "agents.json");
    if (!existsSync(filePath)) return [];
    const raw = readJson(filePath, "legacy agents.json");
    if (!Array.isArray(raw)) {
      throw new ProjectLayoutFilesystemError(
        "invalid_legacy_layout",
        ".polpo/agents.json must contain an array",
      );
    }
    return raw.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new ProjectLayoutFilesystemError(
          "invalid_legacy_layout",
          `.polpo/agents.json entry ${index} must be an object`,
        );
      }
      const record = entry as Record<string, unknown>;
      const wrapped = record.agent !== undefined;
      const agent = (wrapped ? record.agent : record) as AgentConfig | undefined;
      if (!agent || typeof agent !== "object" || typeof agent.name !== "string") {
        throw new ProjectLayoutFilesystemError(
          "invalid_legacy_layout",
          `.polpo/agents.json entry ${index} must contain an agent name`,
        );
      }
      const teamName = wrapped ? record.teamName ?? DEFAULT_TEAM_NAME : DEFAULT_TEAM_NAME;
      if (typeof teamName !== "string") {
        throw new ProjectLayoutFilesystemError(
          "invalid_legacy_layout",
          `.polpo/agents.json entry ${index} teamName must be a string`,
        );
      }
      return { agent, teamName };
    });
  }

  const agentsDir = join(polpoDir, "agents");
  const agentIds = directoryAgentIds(polpoDir);
  assertNoCaseCollisions("agent", agentIds);
  return agentIds.map((agentId) => {
    const agentDir = join(agentsDir, agentId);
    const instructionsPath = join(agentDir, AGENT_INSTRUCTIONS_FILENAME);
    if (!existsSync(instructionsPath)) {
      throw new ProjectLayoutFilesystemError(
        "missing_agent_file",
        `Agent "${agentId}" is missing ${AGENT_INSTRUCTIONS_FILENAME}`,
      );
    }
    return materializeAgentDefinition(
      agentId,
      readJson(join(agentDir, AGENT_CONFIG_FILENAME), `agent "${agentId}"`),
      readFileSync(instructionsPath, "utf-8"),
    );
  });
}

export function writeProjectAgent(
  polpoDir: string,
  agent: AgentConfig,
  teamName: string,
): void {
  assertProjectResourceId("agent", agent.name);
  const agentsDir = join(polpoDir, "agents");
  const otherIds = directoryAgentIds(polpoDir).filter((id) => id !== agent.name);
  assertNoCaseCollisions("agent", [...otherIds, agent.name]);
  const agentDir = join(agentsDir, agent.name);
  const serialized = serializeAgentDefinition(agent, teamName);
  const configPath = join(agentDir, AGENT_CONFIG_FILENAME);
  const instructionsPath = join(agentDir, AGENT_INSTRUCTIONS_FILENAME);
  const previousConfig = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : undefined;
  const previousInstructions = existsSync(instructionsPath)
    ? readFileSync(instructionsPath, "utf-8")
    : undefined;

  try {
    writeJson(configPath, serialized.definition);
    atomicWrite(instructionsPath, serialized.instructions);
  } catch (error) {
    if (previousConfig === undefined) rmSync(configPath, { force: true });
    else atomicWrite(configPath, previousConfig);
    if (previousInstructions === undefined) rmSync(instructionsPath, { force: true });
    else atomicWrite(instructionsPath, previousInstructions);
    throw error;
  }
}

export function deleteProjectAgent(polpoDir: string, agentName: string): boolean {
  assertProjectResourceId("agent", agentName);
  const agentDir = join(polpoDir, "agents", agentName);
  const configPath = join(agentDir, AGENT_CONFIG_FILENAME);
  if (!existsSync(configPath)) return false;
  unlinkSync(configPath);
  const instructionsPath = join(agentDir, AGENT_INSTRUCTIONS_FILENAME);
  if (existsSync(instructionsPath)) unlinkSync(instructionsPath);
  if (existsSync(agentDir) && readdirSync(agentDir).length === 0) {
    rmSync(agentDir, { recursive: false });
  }
  return true;
}

function directoryTeamIds(polpoDir: string): string[] {
  return jsonFilenames(join(polpoDir, "teams")).map((filename) => filename.slice(0, -5));
}

export function detectTeamLayout(polpoDir: string): ProjectResourceLayout {
  const hasLegacy = existsSync(join(polpoDir, "teams.json"));
  const teamIds = directoryTeamIds(polpoDir);
  if (hasLegacy && teamIds.length > 0) {
    throw new ProjectLayoutFilesystemError(
      "ambiguous_layout",
      "Both .polpo/teams.json and directory-based team definitions exist. Remove one authoritative format before continuing.",
    );
  }
  if (teamIds.length > 0 || (!hasLegacy && existsSync(join(polpoDir, "teams")))) {
    return "directory";
  }
  return "legacy";
}

export function readProjectTeams(polpoDir: string): Team[] {
  if (detectTeamLayout(polpoDir) === "legacy") {
    const filePath = join(polpoDir, "teams.json");
    if (!existsSync(filePath)) return [];
    const raw = readJson(filePath, "legacy teams.json");
    if (!Array.isArray(raw)) {
      throw new ProjectLayoutFilesystemError(
        "invalid_legacy_layout",
        ".polpo/teams.json must contain an array",
      );
    }
    return raw as Team[];
  }
  const teamsDir = join(polpoDir, "teams");
  const teamIds = directoryTeamIds(polpoDir);
  assertNoCaseCollisions("team", teamIds);
  return teamIds.map((teamId) => materializeTeamDefinition(
    teamId,
    readJson(join(teamsDir, `${teamId}.json`), `team "${teamId}"`),
  ));
}

export function writeProjectTeam(polpoDir: string, team: Team): void {
  assertProjectResourceId("team", team.name);
  const otherIds = directoryTeamIds(polpoDir).filter((id) => id !== team.name);
  assertNoCaseCollisions("team", [...otherIds, team.name]);
  writeJson(
    join(polpoDir, "teams", `${team.name}.json`),
    serializeTeamDefinition(team),
  );
}

export function deleteProjectTeam(polpoDir: string, teamName: string): boolean {
  assertProjectResourceId("team", teamName);
  const filePath = join(polpoDir, "teams", `${teamName}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

export function renameProjectTeam(
  polpoDir: string,
  oldName: string,
  newName: string,
): boolean {
  assertProjectResourceId("team", oldName);
  assertProjectResourceId("team", newName);
  const teamsDir = join(polpoDir, "teams");
  const oldPath = join(teamsDir, `${oldName}.json`);
  const newPath = join(teamsDir, `${newName}.json`);
  if (!existsSync(oldPath)) return false;
  if (oldName === newName) return true;

  const otherIds = directoryTeamIds(polpoDir).filter((id) => id !== oldName);
  assertNoCaseCollisions("team", [...otherIds, newName]);
  if (existsSync(newPath)) {
    throw new Error(`Team "${newName}" already exists`);
  }

  const temporaryPath = join(
    teamsDir,
    `.${oldName}.${process.pid}.${Math.random().toString(36).slice(2)}.rename`,
  );
  renameSync(oldPath, temporaryPath);
  try {
    renameSync(temporaryPath, newPath);
  } catch (error) {
    renameSync(temporaryPath, oldPath);
    throw error;
  }
  return true;
}

/**
 * Convert legacy aggregate manifests to the directory layout. Validation and
 * backup preflight happen before the first authoritative legacy file is moved.
 */
export function migrateProjectLayoutV2(
  polpoDir: string,
  options: { dryRun?: boolean } = {},
): ProjectLayoutMigrationResult {
  const legacyAgentsPath = join(polpoDir, "agents.json");
  const legacyTeamsPath = join(polpoDir, "teams.json");
  const legacyProjectPath = join(polpoDir, "polpo.json");
  const projectPath = join(polpoDir, "project.json");
  const hasLegacyAgents = existsSync(legacyAgentsPath);
  const hasLegacyTeams = existsSync(legacyTeamsPath);
  const hasLegacyProject = existsSync(legacyProjectPath);
  const shouldCreateProject = hasLegacyProject && !existsSync(projectPath);

  const agents = hasLegacyAgents ? readProjectAgents(polpoDir) : [];
  const teams = hasLegacyTeams ? readProjectTeams(polpoDir) : [];
  const legacyProject = hasLegacyProject
    ? readJson(legacyProjectPath, "legacy project config")
    : undefined;
  if (legacyProject !== undefined && (
    legacyProject === null
    || typeof legacyProject !== "object"
    || Array.isArray(legacyProject)
  )) {
    throw new ProjectLayoutFilesystemError(
      "invalid_legacy_layout",
      ".polpo/polpo.json must contain a JSON object",
    );
  }

  const backupPairs = [
    hasLegacyAgents ? [legacyAgentsPath, join(polpoDir, "agents.v1.json")] : undefined,
    hasLegacyTeams ? [legacyTeamsPath, join(polpoDir, "teams.v1.json")] : undefined,
    hasLegacyProject ? [legacyProjectPath, join(polpoDir, "polpo.v1.json")] : undefined,
  ].filter((pair): pair is [string, string] => pair !== undefined);
  for (const [, backupPath] of backupPairs) {
    if (existsSync(backupPath)) {
      throw new ProjectLayoutFilesystemError(
        "ambiguous_layout",
        `Cannot migrate while backup ${backupPath} already exists`,
      );
    }
  }

  const result: ProjectLayoutMigrationResult = {
    dryRun: options.dryRun === true,
    changed: backupPairs.length > 0,
    agents: agents.length,
    teams: teams.length,
    projectConfig: hasLegacyProject,
    backups: backupPairs.map(([, backupPath]) => backupPath),
  };
  if (options.dryRun || !result.changed) return result;

  const snapshots = new Map<string, string | undefined>();
  const remember = (filePath: string) => {
    if (!snapshots.has(filePath)) {
      snapshots.set(filePath, existsSync(filePath) ? readFileSync(filePath, "utf-8") : undefined);
    }
  };
  for (const { agent } of agents) {
    remember(join(polpoDir, "agents", agent.name, AGENT_CONFIG_FILENAME));
    remember(join(polpoDir, "agents", agent.name, AGENT_INSTRUCTIONS_FILENAME));
  }
  for (const team of teams) remember(join(polpoDir, "teams", `${team.name}.json`));
  if (shouldCreateProject) remember(projectPath);

  const movedBackups: Array<[string, string]> = [];
  try {
    for (const { agent, teamName } of agents) writeProjectAgent(polpoDir, agent, teamName);
    for (const team of teams) writeProjectTeam(polpoDir, team);
    if (shouldCreateProject) {
      writeJson(projectPath, {
        ...(legacyProject as Record<string, unknown>),
        schemaVersion: 2,
      });
    }
    for (const [legacyPath, backupPath] of backupPairs) {
      renameSync(legacyPath, backupPath);
      movedBackups.push([legacyPath, backupPath]);
    }
    return result;
  } catch (error) {
    for (const [legacyPath, backupPath] of movedBackups.reverse()) {
      if (existsSync(backupPath) && !existsSync(legacyPath)) renameSync(backupPath, legacyPath);
    }
    for (const [filePath, previous] of snapshots) {
      if (previous === undefined) {
        rmSync(filePath, { force: true });
      } else {
        atomicWrite(filePath, previous);
      }
    }
    throw error;
  }
}
