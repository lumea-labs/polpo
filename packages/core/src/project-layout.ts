import type { AgentConfig, Team } from "./types.js";

export const POLPO_PROJECT_LAYOUT_VERSION = 2 as const;
export const AGENT_CONFIG_FILENAME = "agent.json";
export const AGENT_INSTRUCTIONS_FILENAME = "instructions.md";
export const DEFAULT_TEAM_NAME = "default";

export type ProjectResourceKind = "agent" | "team";

/**
 * Authored agent fields stored in `.polpo/agents/<id>/agent.json`.
 * The directory supplies `name`; instructions live in `instructions.md`;
 * runtime timestamps are deliberately not authored.
 */
export type AgentDefinition = Omit<
  AgentConfig,
  "name" | "systemPrompt" | "createdAt"
> & {
  $schema?: string;
  team?: string;
};

export interface MaterializedAgentDefinition {
  agent: AgentConfig;
  teamName: string;
}

export interface SerializedAgentDefinition {
  definition: AgentDefinition;
  instructions: string;
}

/** Authored team fields stored in `.polpo/teams/<id>.json`. */
export type TeamDefinition = Omit<Team, "name" | "agents"> & {
  $schema?: string;
};

export class ProjectLayoutError extends Error {
  readonly code:
    | "invalid_resource_id"
    | "invalid_definition"
    | "reserved_agent_field";

  constructor(
    code: ProjectLayoutError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ProjectLayoutError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertProjectResourceId(
  kind: ProjectResourceKind,
  value: string,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ProjectLayoutError(
      "invalid_resource_id",
      `Invalid ${kind} id ${JSON.stringify(value)}: use one trimmed path segment without control characters`,
    );
  }
  return value;
}

export function materializeAgentDefinition(
  agentId: string,
  rawDefinition: unknown,
  instructions: unknown,
): MaterializedAgentDefinition {
  const name = assertProjectResourceId("agent", agentId);
  if (!isPlainObject(rawDefinition)) {
    throw new ProjectLayoutError(
      "invalid_definition",
      `Agent "${name}" agent.json must contain a JSON object`,
    );
  }
  for (const field of ["name", "systemPrompt", "createdAt"] as const) {
    if (Object.prototype.hasOwnProperty.call(rawDefinition, field)) {
      throw new ProjectLayoutError(
        "reserved_agent_field",
        `Agent "${name}" must not define "${field}" in agent.json`,
      );
    }
  }
  if (typeof instructions !== "string") {
    throw new ProjectLayoutError(
      "invalid_definition",
      `Agent "${name}" instructions.md must contain text`,
    );
  }

  const {
    $schema: _schema,
    team: rawTeam,
    ...authoredFields
  } = rawDefinition;
  if (rawTeam !== undefined && typeof rawTeam !== "string") {
    throw new ProjectLayoutError(
      "invalid_definition",
      `Agent "${name}" team must be a string`,
    );
  }
  const teamName = assertProjectResourceId(
    "team",
    rawTeam ?? DEFAULT_TEAM_NAME,
  );

  const agent = {
    ...authoredFields,
    name,
    ...(instructions.length > 0 ? { systemPrompt: instructions } : {}),
  } as AgentConfig;

  return { agent, teamName };
}

export function serializeAgentDefinition(
  agent: AgentConfig,
  teamName = DEFAULT_TEAM_NAME,
): SerializedAgentDefinition {
  assertProjectResourceId("agent", agent.name);
  assertProjectResourceId("team", teamName);
  const {
    name: _name,
    systemPrompt,
    createdAt: _createdAt,
    ...authoredFields
  } = agent;

  return {
    definition: {
      ...authoredFields,
      ...(teamName !== DEFAULT_TEAM_NAME ? { team: teamName } : {}),
    },
    instructions: systemPrompt ?? "",
  };
}

export function materializeTeamDefinition(
  teamId: string,
  rawDefinition: unknown,
): Team {
  const name = assertProjectResourceId("team", teamId);
  if (!isPlainObject(rawDefinition)) {
    throw new ProjectLayoutError(
      "invalid_definition",
      `Team "${name}" definition must contain a JSON object`,
    );
  }
  for (const field of ["name", "agents"] as const) {
    if (Object.prototype.hasOwnProperty.call(rawDefinition, field)) {
      throw new ProjectLayoutError(
        "invalid_definition",
        `Team "${name}" must not define "${field}" in its JSON file`,
      );
    }
  }
  const { $schema: _schema, ...authoredFields } = rawDefinition;
  return { ...authoredFields, name, agents: [] } as Team;
}

export function serializeTeamDefinition(team: Team): TeamDefinition {
  assertProjectResourceId("team", team.name);
  const { name: _name, agents: _agents, ...authoredFields } = team;
  return authoredFields;
}
