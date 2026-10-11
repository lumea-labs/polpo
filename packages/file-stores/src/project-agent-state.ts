import { createHash, randomUUID } from "node:crypto";
import { normalizeAgentMutation, type AgentRevision, type AgentSnapshot } from "@polpo-ai/core/agent-store";
import type { AgentConfig } from "@polpo-ai/core/types";
import { ProjectFileTransactionError, type ProjectFileTransaction } from "./project-file-transaction.js";

type Entry = { agent: AgentConfig; teamName: string };
export interface AgentFileState {
  name: string;
  revision: AgentRevision;
  fingerprint: string;
  createdAt?: string | null;
  /** Text files cannot distinguish an absent prompt from JSON null/empty. */
  emptySystemPrompt?: "" | null;
  lastMutation?: { id: string; expected: AgentRevision; fingerprint: string };
}
const statePath = ".runtime/agent-store/state.json";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function configFingerprint(entry: Entry): string {
  const agent = { ...entry.agent };
  // Directory serialization omits empty instructions; layout migration must
  // preserve creation identity when the effective configuration is unchanged.
  if (!agent.systemPrompt) delete agent.systemPrompt;
  return fingerprint({ agent, teamName: entry.teamName });
}
function invalid(): never {
  throw new ProjectFileTransactionError("invalid_file_transaction", "Invalid agent identity state; restore the project runtime state or reconcile offline");
}
export function persistAgentState(tx: ProjectFileTransaction, state: Map<string, AgentFileState>): void {
  tx.write(statePath, JSON.stringify({ version: 1, agents: [...state.values()].sort((a, b) => a.name.localeCompare(b.name, "en")) }));
}
export function loadAgentState(tx: ProjectFileTransaction, entries: Entry[], reconcile = false): Map<string, AgentFileState> {
  const saved = tx.read(statePath);
  let records: AgentFileState[] = [];
  if (saved !== null && !reconcile) {
    try {
      const value = JSON.parse(saved);
      if (value?.version !== 1 || !Array.isArray(value.agents)) invalid();
      records = value.agents;
    } catch { invalid(); }
  }
  const state = new Map<string, AgentFileState>();
  for (const record of records) {
    if (!record || typeof record.name !== "string" || state.has(record.name)
      || typeof record.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.fingerprint)) invalid();
    try { normalizeAgentMutation({ mutationId: "validate", expected: record.revision, patch: {} }); }
    catch { invalid(); }
    state.set(record.name, record);
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.agent.name)) invalid();
    names.add(entry.agent.name);
    const prior = state.get(entry.agent.name);
    const current = configFingerprint(entry);
    if (prior && prior.fingerprint !== current && !reconcile) {
      throw new ProjectFileTransactionError("file_transaction_conflict",
        "Agent files changed outside the project transaction; stop writers and reconcile agent identities before retrying");
    }
    if (!prior || reconcile || prior.fingerprint !== current) {
      state.set(entry.agent.name, { name: entry.agent.name, fingerprint: current,
        revision: { incarnation: randomUUID(), version: 1 }, createdAt: entry.agent.createdAt ?? new Date().toISOString() });
    }
  }
  for (const name of state.keys()) if (!names.has(name)) state.delete(name);
  persistAgentState(tx, state);
  return state;
}
export function advanceAgentState(tx: ProjectFileTransaction, state: Map<string, AgentFileState>, entries: Entry[], force: Set<string> = new Set()): void {
  const names = new Set(entries.map(e => e.agent.name));
  for (const name of state.keys()) if (!names.has(name)) state.delete(name);
  for (const entry of entries) {
    const prior = state.get(entry.agent.name);
    const current = configFingerprint(entry);
    if (!prior || prior.fingerprint !== current || force.has(entry.agent.name)) {
      if (prior && prior.revision.version >= 2_147_483_646) invalid();
      state.set(entry.agent.name, {
        name: entry.agent.name, fingerprint: current,
        revision: prior ? { ...prior.revision, version: prior.revision.version + 1 } : { incarnation: randomUUID(), version: 1 },
        ...(prior
          ? Object.hasOwn(prior, "createdAt") ? { createdAt: prior.createdAt } : {}
          : { createdAt: entry.agent.createdAt ?? new Date().toISOString() }),
        ...(!entry.agent.systemPrompt && prior && Object.hasOwn(prior, "emptySystemPrompt") ? { emptySystemPrompt: prior.emptySystemPrompt } : {}),
      });
    }
  }
  persistAgentState(tx, state);
}
export function agentFileSnapshot(entry: Entry, state: Map<string, AgentFileState>): AgentSnapshot {
  const saved = state.get(entry.agent.name)!;
  return { agent: { ...entry.agent,
    ...(Object.hasOwn(saved, "createdAt") ? { createdAt: saved.createdAt } : {}),
    ...(!entry.agent.systemPrompt && Object.hasOwn(saved, "emptySystemPrompt") ? { systemPrompt: saved.emptySystemPrompt } : {}),
  } as AgentConfig,
    teamName: entry.teamName, revision: { ...saved.revision } };
}
