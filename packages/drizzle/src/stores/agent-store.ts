import { createHash, randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import {
  AgentMutationError, applyAgentConfigPatch, normalizeAgentMutation,
  type VersionedAgentStore, type AgentSnapshot, type AgentMutation,
  type AgentMutationReceipt, type AgentConfigPatch, type AgentRevision,
} from "@polpo-ai/core/agent-store";
import type { AgentConfig } from "@polpo-ai/core/types";
import { type Dialect, serializeJson, deserializeJson, isUniqueViolation } from "../utils.js";

type AnyTable = any;
type StoredMutation = { id: string; fingerprint: string; expected: AgentMutation["expected"] };

function stripInlineLoopFields(agent: AgentConfig): AgentConfig {
  const { loops: _loops, pipeline: _pipeline, ...clean } = agent;
  return clean as AgentConfig;
}

export class DrizzleAgentStore implements VersionedAgentStore {
  constructor(private db: any, private agentsTable: AnyTable, private dialect: Dialect) {}

  async getAgents(teamName?: string): Promise<AgentConfig[]> {
    const rows: any[] = teamName
      ? await this.db.select().from(this.agentsTable).where(eq(this.agentsTable.teamName, teamName))
      : await this.db.select().from(this.agentsTable);
    return rows.map(r => this.rowToAgent(r));
  }

  async getAgent(name: string): Promise<AgentConfig | undefined> {
    const row = await this.getRow(name);
    return row ? this.rowToAgent(row) : undefined;
  }

  async getAgentTeam(name: string): Promise<string | undefined> {
    return (await this.getRow(name))?.teamName;
  }

  async getAgentSnapshot(name: string): Promise<AgentSnapshot | undefined> {
    const row = await this.getVersionedRow(name);
    return row ? this.rowToSnapshot(row) : undefined;
  }

  async createAgent(agent: AgentConfig, teamName: string): Promise<AgentConfig> {
    try {
      const [row] = await this.db.insert(this.agentsTable).values(this.newRow(agent, teamName)).returning();
      return this.rowToAgent(row);
    } catch (err: any) {
      if (isUniqueViolation(err)) throw new Error(`Agent "${agent.name}" already exists`);
      throw err;
    }
  }

  async compareAndSwapAgent(name: string, input: AgentMutation): Promise<AgentMutationReceipt> {
    const mutation = normalizeAgentMutation(input);
    const fingerprint = createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
    const row = await this.getVersionedRow(name);
    if (!row) throw new AgentMutationError("agent_not_found", `Agent "${name}" not found`);
    const recovered = this.recoverReceipt(row, mutation, fingerprint);
    if (recovered) return recovered;
    if (deserializeJson<StoredMutation | null>(row.lastMutation, null, this.dialect)?.id === mutation.mutationId) {
      throw this.conflict();
    }
    if (row.incarnation !== mutation.expected.incarnation || row.revision !== mutation.expected.version) {
      throw this.conflict();
    }
    const next = applyAgentConfigPatch(this.rowToSnapshot(row), mutation.patch);
    const { name: _name, ...config } = next.agent as AgentConfig & { teamName?: string; team?: string };
    // Team membership is authoritative in its column, never in caller JSON.
    delete config.teamName;
    delete config.team;
    const [committed] = await this.db.update(this.agentsTable).set({
      config: serializeJson(config, this.dialect), teamName: next.teamName,
      revision: mutation.expected.version + 1, updatedAt: new Date().toISOString(),
      lastMutation: serializeJson({ id: mutation.mutationId, fingerprint, expected: mutation.expected }, this.dialect),
    }).where(and(eq(this.agentsTable.name, name), eq(this.agentsTable.incarnation, mutation.expected.incarnation),
      eq(this.agentsTable.revision, mutation.expected.version))).returning();
    if (committed) return this.receipt(committed, mutation);
    // A simultaneous duplicate request can have committed this exact mutation.
    const current = await this.getRow(name);
    const duplicate = current && this.recoverReceipt(current, mutation, fingerprint);
    if (duplicate) return duplicate;
    throw this.conflict();
  }

  async updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig> {
    const set: Record<string, unknown> = {}, unset: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === "loops" || key === "pipeline") continue;
      if (value === undefined) unset.push(key);
      else set[key] = value;
    }
    // Ordinary updates historically passed through JSON persistence: nested
    // undefined removes object fields (e.g. identity.avatar). Preserve that
    // compatibility at this boundary; the explicit CAS contract stays strict.
    return this.mergeCurrent(name, { set: JSON.parse(JSON.stringify(set)), unset } as AgentConfigPatch);
  }

  async moveAgent(name: string, newTeamName: string): Promise<AgentConfig> {
    return this.mergeCurrent(name, { teamName: newTeamName });
  }

  async deleteAgent(name: string): Promise<boolean> {
    const rows = await this.db.delete(this.agentsTable).where(eq(this.agentsTable.name, name)).returning({ name: this.agentsTable.name });
    return rows.length > 0;
  }

  async deleteAgentIfRevision(name: string, revision: AgentRevision): Promise<boolean> {
    const { expected } = normalizeAgentMutation({ expected: revision, mutationId: "delete", patch: {} });
    const rows = await this.db.delete(this.agentsTable).where(and(
      eq(this.agentsTable.name, name), eq(this.agentsTable.incarnation, expected.incarnation),
      eq(this.agentsTable.revision, expected.version),
    )).returning({ name: this.agentsTable.name });
    if (rows.length > 0) return true;
    if (await this.getRow(name)) throw this.conflict();
    return false;
  }

  async cleanupVolatileAgents(missionGroup: string): Promise<number> {
    const rows: any[] = await this.db.select().from(this.agentsTable);
    let count = 0;
    for (const row of rows) {
      const cfg = deserializeJson<Record<string, unknown>>(row.config, {}, this.dialect);
      if (!cfg.volatile || cfg.missionGroup !== missionGroup) continue;
      // Do not delete a recreated agent or one whose lifecycle changed since read.
      const deleted = await this.db.delete(this.agentsTable).where(and(
        eq(this.agentsTable.name, row.name), eq(this.agentsTable.revision, row.revision),
        row.incarnation === null ? isNull(this.agentsTable.incarnation) : eq(this.agentsTable.incarnation, row.incarnation),
      )).returning({ name: this.agentsTable.name });
      count += deleted.length;
    }
    return count;
  }

  async seed(agents: Array<AgentConfig & { teamName: string }>): Promise<void> {
    for (const { teamName, ...agent } of agents) {
      await this.db.insert(this.agentsTable).values(this.newRow(agent, teamName))
        .onConflictDoNothing({ target: this.agentsTable.name });
    }
  }

  private async mergeCurrent(name: string, patch: AgentConfigPatch): Promise<AgentConfig> {
    let snapshot = await this.getAgentSnapshot(name);
    if (!snapshot) throw new AgentMutationError("agent_not_found", `Agent "${name}" not found`);
    // Ordinary patches merge again on conflict; a delete/recreate is never retried.
    const incarnation = snapshot.revision.incarnation;
    const mutationId = randomUUID();
    const normalized = normalizeAgentMutation({ expected: snapshot.revision, mutationId, patch });
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        return (await this.compareAndSwapAgent(name, { ...normalized, expected: snapshot.revision })).snapshot.agent;
      } catch (error) {
        if (!(error instanceof AgentMutationError) || error.code !== "agent_revision_conflict") throw error;
        const current = await this.getAgentSnapshot(name);
        if (!current || current.revision.incarnation !== incarnation) throw error;
        snapshot = current;
      }
    }
    throw this.conflict();
  }

  private async getRow(name: string): Promise<any | undefined> {
    const [row] = await this.db.select().from(this.agentsTable).where(eq(this.agentsTable.name, name));
    return row;
  }

  private async getVersionedRow(name: string): Promise<any | undefined> {
    const row = await this.getRow(name);
    if (!row || row.incarnation !== null) return row;
    // Lazy, atomic adoption of old rows. A second adapter sees the winning UUID.
    const [initialized] = await this.db.update(this.agentsTable).set({ incarnation: randomUUID() })
      .where(and(eq(this.agentsTable.name, name), isNull(this.agentsTable.incarnation))).returning();
    return initialized ?? this.getRow(name);
  }

  private newRow(agent: AgentConfig, teamName: string) {
    const now = new Date().toISOString();
    const { name, ...config } = stripInlineLoopFields({ ...agent, createdAt: agent.createdAt ?? now }) as AgentConfig & { teamName?: string; team?: string };
    delete config.teamName;
    delete config.team;
    return { name, teamName, config: serializeJson(config, this.dialect), incarnation: randomUUID(), revision: 1,
      createdAt: config.createdAt, updatedAt: now, lastMutation: null };
  }

  private rowToAgent(row: any): AgentConfig {
    const cfg = deserializeJson<Record<string, unknown>>(row.config, {}, this.dialect);
    return stripInlineLoopFields({ ...cfg, name: row.name, teamName: row.teamName } as AgentConfig);
  }

  private rowToSnapshot(row: any): AgentSnapshot {
    return { agent: this.rowToAgent(row), teamName: row.teamName,
      revision: { incarnation: row.incarnation, version: row.revision } };
  }

  private receipt(row: any, mutation: AgentMutation): AgentMutationReceipt {
    return { mutationId: mutation.mutationId, previousRevision: mutation.expected, snapshot: this.rowToSnapshot(row) };
  }

  private recoverReceipt(row: any, mutation: AgentMutation, fingerprint: string): AgentMutationReceipt | undefined {
    const last = deserializeJson<StoredMutation | null>(row.lastMutation, null, this.dialect);
    if (last?.id === mutation.mutationId && last.fingerprint === fingerprint
      && last.expected.incarnation === mutation.expected.incarnation && last.expected.version === mutation.expected.version
      && row.incarnation === mutation.expected.incarnation && row.revision === mutation.expected.version + 1) {
      return this.receipt(row, mutation);
    }
  }

  private conflict() {
    return new AgentMutationError("agent_revision_conflict", "The agent changed; reload its configuration before retrying");
  }
}
