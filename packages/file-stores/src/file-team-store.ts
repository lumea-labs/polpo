import type { Team } from "@polpo-ai/core/types";
import type { TeamStore } from "@polpo-ai/core/team-store";
import { deleteProjectTeam, persistProjectTeams, readProjectTeams, readTeamFiles, renameProjectTeam } from "./project-layout-files.js";
import { withProjectFileTransaction } from "./project-file-transaction.js";

/** Shares the agent coordinator, including rename membership and delete cascade. */
export class FileTeamStore implements TeamStore {
  constructor(private readonly polpoDir: string) {}
  async getTeams(): Promise<Team[]> { return readProjectTeams(this.polpoDir); }
  async getTeam(name: string): Promise<Team | undefined> { return readProjectTeams(this.polpoDir).find(t => t.name === name); }
  async createTeam(team: Team): Promise<Team> {
    return withProjectFileTransaction(this.polpoDir, tx => {
      const teams = readTeamFiles(tx);
      if (teams.some(t => t.name === team.name)) throw new Error(`Team "${team.name}" already exists`);
      const copy = JSON.parse(JSON.stringify(team)) as Team;
      persistProjectTeams(tx, [...teams, copy]);
      return copy;
    });
  }
  async updateTeam(name: string, updates: Partial<Omit<Team, "name" | "agents">>): Promise<Team> {
    return withProjectFileTransaction(this.polpoDir, tx => {
      const teams = readTeamFiles(tx);
      const team = teams.find(t => t.name === name);
      if (!team) throw new Error(`Team "${name}" not found`);
      if (updates.description !== undefined) team.description = updates.description;
      persistProjectTeams(tx, teams);
      return team;
    });
  }
  async renameTeam(oldName: string, newName: string): Promise<Team> {
    return withProjectFileTransaction(this.polpoDir, tx => {
      if (!renameProjectTeam(this.polpoDir, oldName, newName)) throw new Error(`Team "${oldName}" not found`);
      return readTeamFiles(tx).find(t => t.name === newName)!;
    });
  }
  async deleteTeam(name: string): Promise<boolean> { return deleteProjectTeam(this.polpoDir, name); }
  async seed(teams: Team[]): Promise<void> {
    withProjectFileTransaction(this.polpoDir, tx => {
      const existing = readTeamFiles(tx);
      const names = new Set(existing.map(t => t.name));
      for (const team of teams) if (!names.has(team.name)) {
        existing.push({ name: team.name, description: team.description, agents: [] });
        names.add(team.name);
      }
      persistProjectTeams(tx, existing);
    });
  }
}
