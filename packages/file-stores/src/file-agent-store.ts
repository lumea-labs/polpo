import { randomUUID } from "node:crypto";
import type { AgentConfig } from "@polpo-ai/core/types";
import {
  AgentMutationError, applyAgentConfigPatch, normalizeAgentMutation,
  type AgentConfigPatch, type AgentMutation, type AgentMutationReceipt, type AgentRevision,
  type AgentSnapshot, type VersionedAgentStore,
} from "@polpo-ai/core/agent-store";
import { deleteProjectAgent, persistProjectAgents, readAgentFiles } from "./project-layout-files.js";
import { agentFileSnapshot, fingerprint, loadAgentState, persistAgentState, type AgentFileState } from "./project-agent-state.js";
import { withProjectFileTransaction } from "./project-file-transaction.js";

const conflict = () => new AgentMutationError("agent_revision_conflict", "The agent changed; reload its configuration before retrying");
function applyRuntimeFields(state: AgentFileState, patch: AgentConfigPatch): void {
  if (patch.set && Object.hasOwn(patch.set, "createdAt")) state.createdAt = patch.set.createdAt;
  if (patch.unset?.includes("createdAt")) delete state.createdAt;
  if (patch.set && Object.hasOwn(patch.set, "systemPrompt")) {
    const prompt = patch.set.systemPrompt;
    if (prompt === "" || prompt === null) state.emptySystemPrompt = prompt;
    else delete state.emptySystemPrompt;
  }
  if (patch.unset?.includes("systemPrompt")) delete state.emptySystemPrompt;
}

/** JSON/Markdown definitions with an OS-coordinated revision and recovery journal. */
export class FileAgentStore implements VersionedAgentStore {
  constructor(private readonly polpoDir: string) {}

  async getAgents(teamName?: string): Promise<AgentConfig[]> {
    return withProjectFileTransaction(this.polpoDir, tx => {
      const entries = readAgentFiles(tx);
      const state = loadAgentState(tx, entries);
      return entries.filter(e => !teamName || e.teamName === teamName).map(e => agentFileSnapshot(e, state).agent);
    });
  }
  async getAgent(name: string): Promise<AgentConfig | undefined> { return (await this.getAgentSnapshot(name))?.agent; }
  async getAgentTeam(name: string): Promise<string | undefined> { return (await this.getAgentSnapshot(name))?.teamName; }
  async getAgentSnapshot(name: string): Promise<AgentSnapshot | undefined> {
    return withProjectFileTransaction(this.polpoDir, tx => {
      const entries = readAgentFiles(tx);
      const state = loadAgentState(tx, entries);
      const entry = entries.find(e => e.agent.name === name);
      return entry && agentFileSnapshot(entry, state);
    });
  }
  async createAgent(agent: AgentConfig, teamName: string): Promise<AgentConfig> {
    return withProjectFileTransaction(this.polpoDir, tx => {
      const entries = readAgentFiles(tx);
      const state = loadAgentState(tx, entries);
      if (entries.some(e => e.agent.name === agent.name)) throw new Error(`Agent "${agent.name}" already exists`);
      const copy = JSON.parse(JSON.stringify({ ...agent, createdAt: agent.createdAt ?? new Date().toISOString() })) as AgentConfig;
      const saved = persistProjectAgents(tx, [...entries, { agent: copy, teamName }], state);
      // Directory definitions deliberately omit runtime-only creation time.
      state.get(copy.name)!.createdAt = copy.createdAt;
      persistAgentState(tx, state);
      return agentFileSnapshot(saved.find(e => e.agent.name === copy.name)!, state).agent;
    });
  }
  async compareAndSwapAgent(name: string, request: AgentMutation): Promise<AgentMutationReceipt> {
    const mutation = normalizeAgentMutation(request);
    return withProjectFileTransaction(this.polpoDir, tx => {
      const entries = readAgentFiles(tx);
      const state = loadAgentState(tx, entries);
      const index = entries.findIndex(e => e.agent.name === name);
      if (index < 0) throw new AgentMutationError("agent_not_found", `Agent "${name}" not found`);
      const current = state.get(name)!;
      const signature = fingerprint(mutation);
      const last = current.lastMutation;
      if (last?.id === mutation.mutationId) {
        if (last.fingerprint === signature && current.revision.incarnation === mutation.expected.incarnation
          && current.revision.version === mutation.expected.version + 1) {
          return { mutationId: mutation.mutationId, previousRevision: mutation.expected, snapshot: agentFileSnapshot(entries[index], state) };
        }
        throw conflict();
      }
      if (current.revision.incarnation !== mutation.expected.incarnation || current.revision.version !== mutation.expected.version) throw conflict();
      entries[index] = applyAgentConfigPatch(agentFileSnapshot(entries[index], state), mutation.patch);
      const saved = persistProjectAgents(tx, entries, state, new Set([name]));
      applyRuntimeFields(state.get(name)!, mutation.patch);
      state.get(name)!.lastMutation = { id: mutation.mutationId, expected: mutation.expected, fingerprint: signature };
      persistAgentState(tx, state);
      return { mutationId: mutation.mutationId, previousRevision: mutation.expected,
        snapshot: agentFileSnapshot(saved.find(e => e.agent.name === name)!, state) };
    });
  }
  async updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig> {
    const set: Record<string, unknown> = {}, unset: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === "loops" || key === "pipeline") continue;
      if (value === undefined) unset.push(key); else set[key] = value;
    }
    return this.mergeCurrent(name, { set: JSON.parse(JSON.stringify(set)), unset } as AgentConfigPatch);
  }
  async moveAgent(name: string, teamName: string): Promise<AgentConfig> { return this.mergeCurrent(name, { teamName }); }
  private mergeCurrent(name: string, patch: AgentConfigPatch): AgentConfig {
    return withProjectFileTransaction(this.polpoDir, tx => {
      const entries = readAgentFiles(tx);
      const state = loadAgentState(tx, entries);
      const index = entries.findIndex(e => e.agent.name === name);
      if (index < 0) throw new AgentMutationError("agent_not_found", `Agent "${name}" not found`);
      const current = agentFileSnapshot(entries[index], state);
      const mutation = normalizeAgentMutation({ expected: current.revision, mutationId: randomUUID(), patch });
      entries[index] = applyAgentConfigPatch(current, mutation.patch);
      const saved = persistProjectAgents(tx, entries, state, new Set([name]));
      applyRuntimeFields(state.get(name)!, mutation.patch);
      persistAgentState(tx, state);
      return agentFileSnapshot(saved.find(e => e.agent.name === name)!, state).agent;
    });
  }
  async deleteAgent(name: string): Promise<boolean> { return deleteProjectAgent(this.polpoDir, name); }
  async deleteAgentIfRevision(name: string, revision: AgentRevision): Promise<boolean> {
    const { expected } = normalizeAgentMutation({ expected: revision, mutationId: "delete", patch: {} });
    return withProjectFileTransaction(this.polpoDir, tx => {
      const entries = readAgentFiles(tx);
      const state = loadAgentState(tx, entries);
      const current = state.get(name);
      if (!current) return false;
      if (current.revision.incarnation !== expected.incarnation || current.revision.version !== expected.version) throw conflict();
      persistProjectAgents(tx, entries.filter(e => e.agent.name !== name), state);
      return true;
    });
  }
  async cleanupVolatileAgents(missionGroup: string): Promise<number> {
    return withProjectFileTransaction(this.polpoDir, tx => {
      const entries = readAgentFiles(tx);
      const state = loadAgentState(tx, entries);
      const retained = entries.filter(e => !(e.agent.volatile && e.agent.missionGroup === missionGroup));
      if (entries.length !== retained.length) persistProjectAgents(tx, retained, state);
      return entries.length - retained.length;
    });
  }
  async seed(agents: Array<AgentConfig & { teamName: string }>): Promise<void> {
    withProjectFileTransaction(this.polpoDir, tx => {
      const entries = readAgentFiles(tx);
      const state = loadAgentState(tx, entries);
      const names = new Set(entries.map(e => e.agent.name));
      for (const { teamName, ...agent } of agents) if (!names.has(agent.name)) {
        entries.push({ agent: JSON.parse(JSON.stringify(agent)), teamName });
        names.add(agent.name);
      }
      persistProjectAgents(tx, entries, state);
    });
  }
}
