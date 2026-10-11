import type { AgentConfig } from "./types.js";

/**
 * Persistent store for agents.
 *
 * Agents are first-class entities with their own lifecycle, independent of
 * project configuration.  Each agent belongs to exactly one team (by teamName).
 *
 * Every backend (file, SQLite, PostgreSQL) must implement this interface.
 */
export interface AgentStore {
  // ── Read ────────────────────────────────────────────────────────────

  /** Return all agents, optionally filtered by team. */
  getAgents(teamName?: string): Promise<AgentConfig[]>;

  /** Return a single agent by name (globally unique), or undefined. */
  getAgent(name: string): Promise<AgentConfig | undefined>;

  /** Return the team name an agent belongs to, or undefined. */
  getAgentTeam(name: string): Promise<string | undefined>;

  // ── Write ───────────────────────────────────────────────────────────

  /** Add a new agent to the given team. Throws if name already exists. */
  createAgent(agent: AgentConfig, teamName: string): Promise<AgentConfig>;

  /** Merge supplied fields against the current configuration. For changes
   * derived from an earlier read, use VersionedAgentStore and its precondition. */
  updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig>;

  /** Move an agent to a different team. */
  moveAgent(name: string, newTeamName: string): Promise<AgentConfig>;

  /** Remove an agent by name. Returns true if it existed. */
  deleteAgent(name: string): Promise<boolean>;

  // ── Volatile lifecycle ──────────────────────────────────────────────

  /** Remove all volatile agents belonging to a mission group. Returns count removed. */
  cleanupVolatileAgents(missionGroup: string): Promise<number>;

  /** Seed initial agents from project configuration. Skips agents that already exist. */
  seed(agents: Array<AgentConfig & { teamName: string }>): Promise<void>;
}

/** A creation identity plus monotonically increasing generation. Recreating an
 * agent with the same name MUST allocate a different incarnation. */
export interface AgentRevision {
  incarnation: string;
  version: number;
}

export interface AgentSnapshot {
  agent: AgentConfig;
  teamName: string;
  revision: AgentRevision;
}

/** Host-owned creation identity captured WITH the execution configuration.
 * Configuration edits preserve it; deleting and recreating the agent does not.
 * Never derive this from a model argument, request metadata or a late name lookup. */
export interface AgentIdentity {
  readonly name: string;
  readonly incarnation: string;
}

export function normalizeAgentIdentity(value: unknown): AgentIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => key !== "name" && key !== "incarnation")) {
    throw new TypeError("Invalid agent identity");
  }
  const { name, incarnation } = value as Record<string, unknown>;
  if (typeof name !== "string" || !name || name !== name.trim() || name.length > 512
    || typeof incarnation !== "string" || !/^[\w.:-]{1,160}$/.test(incarnation)) {
    throw new TypeError("Invalid agent identity");
  }
  return Object.freeze({ name, incarnation });
}

export function agentIdentityFromSnapshot(snapshot: AgentSnapshot): AgentIdentity {
  return normalizeAgentIdentity({ name: snapshot.agent.name, incarnation: snapshot.revision.incarnation });
}

export class AgentIdentityError extends Error {
  readonly code = "agent_identity_changed";
  constructor() {
    super("Agent identity is missing or no longer matches this execution");
    this.name = "AgentIdentityError";
  }
}

/** Check creation identity, not mutable configuration version. A host must
 * repeat this check at protected dispatch, including after refresh/other waits. */
export function assertAgentIdentity(identity: AgentIdentity | undefined, current: AgentSnapshot | undefined): void {
  if (!identity || !current || identity.name !== current.agent.name
    || identity.incarnation !== current.revision.incarnation) throw new AgentIdentityError();
}

type AgentField = Exclude<keyof AgentConfig, "name" | "loops" | "pipeline">;

/** Top-level replacement patch. Omission preserves a field; null is JSON null;
 * unset removes it. Nested objects are replaced, never implicitly deep-merged. */
export interface AgentConfigPatch {
  set?: { [K in AgentField]?: AgentConfig[K] | null };
  unset?: AgentField[];
  teamName?: string;
}

export interface AgentMutation {
  expected: AgentRevision;
  mutationId: string;
  patch: AgentConfigPatch;
}

export interface AgentMutationReceipt {
  mutationId: string;
  previousRevision: AgentRevision;
  snapshot: AgentSnapshot;
}

/** Explicit capability for concurrency-sensitive hosts. Never emulate it with
 * getAgent + updateAgent or fall back to an unconditional write. */
export interface VersionedAgentStore extends AgentStore {
  getAgentSnapshot(name: string): Promise<AgentSnapshot | undefined>;
  /** Commit once, including no-op patches. Retrying an identical mutation may
   * recover its receipt ONLY while that exact generation is still current. */
  compareAndSwapAgent(name: string, mutation: AgentMutation): Promise<AgentMutationReceipt>;
  /** Delete only this exact generation. Missing is false; an existing agent
   * with another revision/incarnation is a conflict, never a retry target. */
  deleteAgentIfRevision(name: string, expected: AgentRevision): Promise<boolean>;
}

export class AgentMutationError extends Error {
  constructor(
    readonly code: "invalid_agent_mutation" | "agent_revision_conflict" | "agent_not_found",
    message: string,
  ) {
    super(message);
    this.name = "AgentMutationError";
  }
}

export function isVersionedAgentStore(store: AgentStore): store is VersionedAgentStore {
  const candidate = store as Partial<VersionedAgentStore>;
  return typeof candidate.getAgentSnapshot === "function" && typeof candidate.compareAndSwapAgent === "function"
    && typeof candidate.deleteAgentIfRevision === "function";
}

const forbiddenFields = new Set(["name", "team", "teamName", "loops", "pipeline", "__proto__", "constructor", "prototype"]);
const invalid = (): never => { throw new AgentMutationError("invalid_agent_mutation", "Invalid agent mutation; use explicit JSON set/unset fields and a valid revision"); };

/** Validates and copies the request before an asynchronous write. Its stable
 * serialization can be hashed by adapters for lost-acknowledgement recovery. */
export function normalizeAgentMutation(input: AgentMutation): AgentMutation {
  const request = jsonCopy(input) as AgentMutation;
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).some(k => !["expected", "mutationId", "patch"].includes(k))) invalid();
  if (typeof request.mutationId !== "string" || !/^[\w.:-]{1,160}$/.test(request.mutationId)) invalid();
  const revision = request.expected;
  if (!revision || typeof revision !== "object" || Array.isArray(revision)
    || Object.keys(revision).some(k => !["incarnation", "version"].includes(k))
    || typeof revision.incarnation !== "string" || !/^[\w.:-]{1,160}$/.test(revision.incarnation)
    || !Number.isInteger(revision.version) || revision.version < 0 || revision.version >= 2_147_483_647) invalid();
  const patch = request.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)
    || Object.keys(patch).some(k => !["set", "unset", "teamName"].includes(k))) invalid();
  if (Object.hasOwn(patch, "teamName") && (typeof patch.teamName !== "string"
    || !patch.teamName.trim() || patch.teamName !== patch.teamName.trim())) invalid();
  const set = patch.set ?? {};
  if (Object.hasOwn(patch, "set") && (!patch.set || typeof patch.set !== "object" || Array.isArray(patch.set))) invalid();
  if (Object.keys(set).some(k => forbiddenFields.has(k))) invalid();
  const unset = patch.unset ?? [];
  if (!Array.isArray(unset) || (Object.hasOwn(patch, "unset") && patch.unset === null)
    || unset.some(k => typeof k !== "string" || forbiddenFields.has(k) || Object.hasOwn(set, k))
    || new Set(unset).size !== unset.length) invalid();
  // Canonicalize equivalent key order without weakening the mutation identity.
  if (patch.unset) patch.unset.sort();
  return request;
}

function jsonCopy(value: unknown, depth = 0): unknown {
  if (depth > 64) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, child => jsonCopy(child, depth + 1));
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonCopy((value as Record<string, unknown>)[key], depth + 1)]));
  }
  return invalid();
}

export function applyAgentConfigPatch(snapshot: AgentSnapshot, patch: AgentConfigPatch): Pick<AgentSnapshot, "agent" | "teamName"> {
  const { loops: _loops, pipeline: _pipeline, ...clean } = snapshot.agent;
  const agent = { ...clean, ...patch.set, name: snapshot.agent.name } as AgentConfig;
  for (const field of patch.unset ?? []) delete agent[field];
  return { agent, teamName: patch.teamName ?? snapshot.teamName };
}
