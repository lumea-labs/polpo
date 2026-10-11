import { join } from "node:path";
import type { AgentConfig, Team } from "@polpo-ai/core/types";
import {
  AGENT_CONFIG_FILENAME, AGENT_INSTRUCTIONS_FILENAME, DEFAULT_TEAM_NAME,
  assertProjectResourceId, materializeAgentDefinition, materializeTeamDefinition,
  serializeAgentDefinition, serializeTeamDefinition,
} from "@polpo-ai/core/project-layout";
import { ProjectFileTransactionError, withProjectFileTransaction, type ProjectFileTransaction } from "./project-file-transaction.js";
import { advanceAgentState, fingerprint, loadAgentState, type AgentFileState } from "./project-agent-state.js";

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

function readJson(tx: ProjectFileTransaction, path: string, label: string): unknown {
  try { return JSON.parse(tx.read(path)!); }
  catch (error) { throw new ProjectLayoutFilesystemError("invalid_json", `Could not parse ${label} at ${join(tx.root, path)}: ${(error as Error).message}`); }
}
function writeJson(tx: ProjectFileTransaction, path: string, value: unknown): void {
  tx.write(path, `${JSON.stringify(value, null, 2)}\n`);
}
function assertNoCaseCollisions(kind: "agent" | "team", ids: string[]): void {
  const seen = new Map<string, string>();
  for (const id of ids) {
    const folded = id.normalize("NFKC").toLocaleLowerCase("en-US");
    const previous = seen.get(folded);
    if (previous && previous !== id) throw new ProjectLayoutFilesystemError("case_collision", `${kind === "agent" ? "Agent" : "Team"} ids "${previous}" and "${id}" collide on case-insensitive filesystems`);
    seen.set(folded, id);
  }
}
function agentIds(tx: ProjectFileTransaction): string[] {
  return tx.list("agents").filter(id => tx.isDirectory(`agents/${id}`) && tx.exists(`agents/${id}/${AGENT_CONFIG_FILENAME}`));
}
function teamIds(tx: ProjectFileTransaction): string[] {
  return tx.list("teams").filter(id => id.endsWith(".json") && !tx.isDirectory(`teams/${id}`)).map(id => id.slice(0, -5));
}
function layout(tx: ProjectFileTransaction, kind: "agent" | "team"): ProjectResourceLayout {
  const plural = `${kind}s`;
  const hasLegacy = tx.exists(`${plural}.json`);
  const ids = kind === "agent" ? agentIds(tx) : teamIds(tx);
  if (hasLegacy && ids.length > 0) throw new ProjectLayoutFilesystemError("ambiguous_layout", `Both .polpo/${plural}.json and directory-based ${kind} definitions exist. Remove one authoritative format before continuing.`);
  return ids.length > 0 || (!hasLegacy && tx.exists(plural)) ? "directory" : "legacy";
}
export function detectAgentLayout(polpoDir: string): ProjectResourceLayout {
  return withProjectFileTransaction(polpoDir, tx => layout(tx, "agent"));
}
export function detectTeamLayout(polpoDir: string): ProjectResourceLayout {
  return withProjectFileTransaction(polpoDir, tx => layout(tx, "team"));
}
export function readAgentFiles(tx: ProjectFileTransaction): ProjectAgentEntry[] {
  if (layout(tx, "agent") === "legacy") {
    if (!tx.exists("agents.json")) return [];
    const raw = readJson(tx, "agents.json", "legacy agents.json");
    if (!Array.isArray(raw)) throw new ProjectLayoutFilesystemError("invalid_legacy_layout", ".polpo/agents.json must contain an array");
    return raw.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ProjectLayoutFilesystemError("invalid_legacy_layout", `.polpo/agents.json entry ${index} must be an object`);
      const wrapped = entry.agent !== undefined;
      const agent = wrapped ? entry.agent : entry;
      if (!agent || typeof agent !== "object" || typeof agent.name !== "string") throw new ProjectLayoutFilesystemError("invalid_legacy_layout", `.polpo/agents.json entry ${index} must contain an agent name`);
      const teamName = wrapped ? entry.teamName ?? DEFAULT_TEAM_NAME : DEFAULT_TEAM_NAME;
      if (typeof teamName !== "string") throw new ProjectLayoutFilesystemError("invalid_legacy_layout", `.polpo/agents.json entry ${index} teamName must be a string`);
      return { agent, teamName };
    });
  }
  const ids = agentIds(tx);
  assertNoCaseCollisions("agent", ids);
  return ids.map(id => {
    const instructions = tx.read(`agents/${id}/${AGENT_INSTRUCTIONS_FILENAME}`);
    if (instructions === null) throw new ProjectLayoutFilesystemError("missing_agent_file", `Agent "${id}" is missing ${AGENT_INSTRUCTIONS_FILENAME}`);
    return materializeAgentDefinition(id, readJson(tx, `agents/${id}/${AGENT_CONFIG_FILENAME}`, `agent "${id}"`), instructions);
  });
}
export function readProjectAgents(polpoDir: string): ProjectAgentEntry[] {
  return withProjectFileTransaction(polpoDir, readAgentFiles);
}
function writeDirectoryAgent(tx: ProjectFileTransaction, { agent, teamName }: ProjectAgentEntry): void {
  const serialized = serializeAgentDefinition(agent, teamName);
  writeJson(tx, `agents/${agent.name}/${AGENT_CONFIG_FILENAME}`, serialized.definition);
  tx.write(`agents/${agent.name}/${AGENT_INSTRUCTIONS_FILENAME}`, serialized.instructions);
}
/** Internal store primitive. State and authored files are staged in the same journal. */
export function persistProjectAgents(tx: ProjectFileTransaction, entries: ProjectAgentEntry[], state: Map<string, AgentFileState>, force: Set<string> = new Set()): ProjectAgentEntry[] {
  for (const { agent, teamName } of entries) {
    assertProjectResourceId("agent", agent.name);
    assertProjectResourceId("team", teamName);
  }
  assertNoCaseCollisions("agent", entries.map(e => e.agent.name));
  if (layout(tx, "agent") === "legacy") writeJson(tx, "agents.json", entries);
  else {
    const retained = new Set(entries.map(e => e.agent.name));
    for (const id of agentIds(tx)) if (!retained.has(id)) {
      tx.write(`agents/${id}/${AGENT_CONFIG_FILENAME}`, null);
      tx.write(`agents/${id}/${AGENT_INSTRUCTIONS_FILENAME}`, null);
    }
    for (const entry of entries) writeDirectoryAgent(tx, entry);
  }
  const persisted = readAgentFiles(tx);
  advanceAgentState(tx, state, persisted, force);
  return persisted;
}
export function writeProjectAgent(polpoDir: string, agent: AgentConfig, teamName: string): void {
  withProjectFileTransaction(polpoDir, tx => {
    const entries = readAgentFiles(tx);
    const state = loadAgentState(tx, entries);
    if (tx.exists("agents.json")) throw new ProjectLayoutFilesystemError("ambiguous_layout", "Migrate the legacy agent layout before writing a directory definition");
    assertNoCaseCollisions("agent", [...entries.filter(e => e.agent.name !== agent.name).map(e => e.agent.name), agent.name]);
    writeDirectoryAgent(tx, { agent, teamName });
    advanceAgentState(tx, state, readAgentFiles(tx), new Set([agent.name]));
  });
}
export function deleteProjectAgent(polpoDir: string, agentName: string): boolean {
  assertProjectResourceId("agent", agentName);
  return withProjectFileTransaction(polpoDir, tx => {
    const entries = readAgentFiles(tx);
    const state = loadAgentState(tx, entries);
    if (!entries.some(e => e.agent.name === agentName)) return false;
    persistProjectAgents(tx, entries.filter(e => e.agent.name !== agentName), state);
    return true;
  });
}
export function readTeamFiles(tx: ProjectFileTransaction): Team[] {
  if (layout(tx, "team") === "legacy") {
    if (!tx.exists("teams.json")) return [];
    const raw = readJson(tx, "teams.json", "legacy teams.json");
    if (!Array.isArray(raw)) throw new ProjectLayoutFilesystemError("invalid_legacy_layout", ".polpo/teams.json must contain an array");
    return raw as Team[];
  }
  const ids = teamIds(tx);
  assertNoCaseCollisions("team", ids);
  return ids.map(id => materializeTeamDefinition(id, readJson(tx, `teams/${id}.json`, `team "${id}"`)));
}
export function readProjectTeams(polpoDir: string): Team[] {
  return withProjectFileTransaction(polpoDir, readTeamFiles);
}
export function persistProjectTeams(tx: ProjectFileTransaction, teams: Team[]): void {
  for (const team of teams) assertProjectResourceId("team", team.name);
  assertNoCaseCollisions("team", teams.map(t => t.name));
  if (layout(tx, "team") === "legacy") writeJson(tx, "teams.json", teams);
  else {
    const retained = new Set(teams.map(t => t.name));
    for (const id of teamIds(tx)) if (!retained.has(id)) tx.write(`teams/${id}.json`, null);
    for (const team of teams) writeJson(tx, `teams/${team.name}.json`, serializeTeamDefinition(team));
  }
}
export function writeProjectTeam(polpoDir: string, team: Team): void {
  withProjectFileTransaction(polpoDir, tx => {
    if (tx.exists("teams.json")) throw new ProjectLayoutFilesystemError("ambiguous_layout", "Migrate the legacy team layout before writing a directory definition");
    assertNoCaseCollisions("team", [...teamIds(tx).filter(id => id !== team.name), team.name]);
    writeJson(tx, `teams/${assertProjectResourceId("team", team.name)}.json`, serializeTeamDefinition(team));
  });
}
export function deleteProjectTeam(polpoDir: string, teamName: string): boolean {
  assertProjectResourceId("team", teamName);
  return withProjectFileTransaction(polpoDir, tx => {
    const teams = readTeamFiles(tx);
    if (!teams.some(t => t.name === teamName)) return false;
    const entries = readAgentFiles(tx);
    const state = loadAgentState(tx, entries);
    persistProjectAgents(tx, entries.filter(e => e.teamName !== teamName), state);
    persistProjectTeams(tx, teams.filter(t => t.name !== teamName));
    return true;
  });
}
export function renameProjectTeam(polpoDir: string, oldName: string, newName: string): boolean {
  assertProjectResourceId("team", oldName);
  assertProjectResourceId("team", newName);
  return withProjectFileTransaction(polpoDir, tx => {
    const teams = readTeamFiles(tx);
    const team = teams.find(t => t.name === oldName);
    if (!team) return false;
    if (oldName === newName) return true;
    if (teams.some(t => t.name === newName)) throw new Error(`Team "${newName}" already exists`);
    const entries = readAgentFiles(tx);
    const state = loadAgentState(tx, entries);
    team.name = newName;
    persistProjectTeams(tx, teams);
    persistProjectAgents(tx, entries.map(e => e.teamName === oldName ? { ...e, teamName: newName } : e), state);
    return true;
  });
}
/** Explicit offline reconciliation rotates all local agent identities.
 * Stop runtimes before editing; direct editor writes do not participate in locks.
 * Connections for changed identities must be assigned again. */
export function reconcileProjectAgentFiles(polpoDir: string): void {
  withProjectFileTransaction(polpoDir, tx => { loadAgentState(tx, readAgentFiles(tx), true); });
}

export interface ProjectDefinitionSnapshot {
  files: Array<{ path: string; contents: string | null }>;
  agentStateFingerprint: string;
}
function assertDefinitionPath(path: string): void {
  if (path === "agents.json" || path === "teams.json") return;
  const parts = path.split("/");
  if (parts[0] === "agents" && parts.length === 3 && [AGENT_CONFIG_FILENAME, AGENT_INSTRUCTIONS_FILENAME].includes(parts[2])) {
    assertProjectResourceId("agent", parts[1]); return;
  }
  if (parts[0] === "teams" && parts.length === 2 && parts[1].endsWith(".json")) {
    assertProjectResourceId("team", parts[1].slice(0, -5)); return;
  }
  throw new ProjectFileTransactionError("invalid_file_transaction", "Invalid project definition path");
}
/** Capture before prompting/network waits. The opaque state fingerprint also
 * fences delete/recreate and same-content CAS updates during that wait. */
export function captureProjectDefinitionFiles(polpoDir: string, paths: string[]): ProjectDefinitionSnapshot {
  return withProjectFileTransaction(polpoDir, tx => {
    loadAgentState(tx, readAgentFiles(tx));
    return { files: paths.map(path => { assertDefinitionPath(path); return { path, contents: tx.read(path) }; }),
      agentStateFingerprint: fingerprint(tx.read(".runtime/agent-store/state.json")) };
  });
}
export function commitProjectDefinitionFiles(polpoDir: string, snapshot: ProjectDefinitionSnapshot, updates: Array<{ path: string; contents: string | null }>): void {
  withProjectFileTransaction(polpoDir, tx => {
    const before = readAgentFiles(tx);
    const state = loadAgentState(tx, before);
    if (fingerprint(tx.read(".runtime/agent-store/state.json")) !== snapshot.agentStateFingerprint
      || snapshot.files.some(file => tx.read(file.path) !== file.contents)) {
      throw new ProjectFileTransactionError("file_transaction_conflict", "Project definitions changed while awaiting the pull decision; run pull again");
    }
    const expected = new Set(snapshot.files.map(f => f.path));
    for (const update of updates) {
      assertDefinitionPath(update.path);
      if (!expected.has(update.path)) throw new ProjectFileTransactionError("invalid_file_transaction", "Project definition was not captured before editing");
      tx.write(update.path, update.contents);
    }
    // Both parsers run before journal commit, preventing partial prompts/config
    // and invalid mixed legacy/directory layouts even in a --force pull.
    const after = readAgentFiles(tx);
    readTeamFiles(tx);
    advanceAgentState(tx, state, after);
  });
}
export function migrateProjectLayoutV2(polpoDir: string, options: { dryRun?: boolean } = {}): ProjectLayoutMigrationResult {
  return withProjectFileTransaction(polpoDir, tx => {
    const hasAgents = tx.exists("agents.json"), hasTeams = tx.exists("teams.json"), hasProject = tx.exists("polpo.json");
    const agents = hasAgents ? readAgentFiles(tx) : [];
    const teams = hasTeams ? readTeamFiles(tx) : [];
    const project = hasProject ? readJson(tx, "polpo.json", "legacy project config") : undefined;
    if (project !== undefined && (!project || typeof project !== "object" || Array.isArray(project))) throw new ProjectLayoutFilesystemError("invalid_legacy_layout", ".polpo/polpo.json must contain a JSON object");
    const backups = [hasAgents ? "agents" : "", hasTeams ? "teams" : "", hasProject ? "polpo" : ""].filter(Boolean);
    for (const name of backups) if (tx.exists(`${name}.v1.json`)) throw new ProjectLayoutFilesystemError("ambiguous_layout", `Cannot migrate while backup ${join(polpoDir, `${name}.v1.json`)} already exists`);
    const result = { dryRun: options.dryRun === true, changed: backups.length > 0, agents: agents.length, teams: teams.length, projectConfig: hasProject, backups: backups.map(n => join(polpoDir, `${n}.v1.json`)) };
    if (options.dryRun || !result.changed) return result;
    const state = loadAgentState(tx, readAgentFiles(tx));
    for (const entry of agents) writeDirectoryAgent(tx, entry);
    for (const team of teams) writeJson(tx, `teams/${assertProjectResourceId("team", team.name)}.json`, serializeTeamDefinition(team));
    if (hasProject && !tx.exists("project.json")) writeJson(tx, "project.json", { ...project as object, schemaVersion: 2 });
    for (const name of backups) { tx.write(`${name}.v1.json`, tx.read(`${name}.json`)); tx.write(`${name}.json`, null); }
    advanceAgentState(tx, state, readAgentFiles(tx));
    return result;
  });
}
