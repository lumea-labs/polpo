/**
 * polpo cloud-status — show project status summary.
 */
import type { Command } from "commander";
import pc from "picocolors";
import * as clack from "@clack/prompts";
import { createApiClient } from "./api.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("cloud-status")
    .description("Show project status summary")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (opts) => {
      clack.intro(pc.bold("Polpo — Project Status"));

      const creds = await requireAuth({
        context: "Showing project status requires an authenticated session.",
      });

      const projectId = loadProjectId(opts.dir);
      if (!projectId) {
        clack.log.error(pc.red("No project linked in this directory."));
        clack.outro(
          pc.dim("Run ") + pc.bold("polpo create") + pc.dim(" or ") + pc.bold("polpo link --project-id <id>") + pc.dim(" first.")
        );
        process.exit(1);
      }

      const client = createApiClient(creds, projectId);
      const s = clack.spinner();
      s.start("Fetching project status");

      let taskSummary = "";
      try {
        const res = await client.get<any>("/v1/tasks");
        if (res.status === 200) {
          const tasks = res.data?.data ?? res.data ?? [];
          const byStatus: Record<string, number> = {};
          for (const t of Array.isArray(tasks) ? tasks : []) {
            byStatus[t.status ?? "unknown"] = (byStatus[t.status ?? "unknown"] ?? 0) + 1;
          }
          const total = Array.isArray(tasks) ? tasks.length : 0;
          const parts = Object.entries(byStatus).map(([s, c]) => `${s}: ${c}`).join(", ");
          taskSummary = `Tasks: ${total}${parts ? " (" + parts + ")" : ""}`;
        } else if (res.status === 401) {
          taskSummary = "Tasks: session expired — run: polpo login";
        } else {
          taskSummary = `Tasks: error (HTTP ${res.status})`;
        }
      } catch { taskSummary = "Tasks: unavailable"; }

      let agentSummary = "";
      try {
        const res = await client.get<any>("/v1/agents");
        if (res.status === 200) {
          const agents = res.data?.data ?? res.data ?? [];
          const count = Array.isArray(agents) ? agents.length : 0;
          const names = Array.isArray(agents) ? agents.map((a: any) => a.name).join(", ") : "";
          agentSummary = count > 0 ? `Agents: ${count} (${names})` : "Agents: 0";
        } else if (res.status === 401) {
          agentSummary = "Agents: session expired — run: polpo login";
        } else {
          agentSummary = `Agents: error (HTTP ${res.status})`;
        }
      } catch { agentSummary = "Agents: unavailable"; }

      let missionSummary = "";
      try {
        const res = await client.get<any>("/v1/missions");
        if (res.status === 200) {
          const missions = res.data?.data ?? res.data ?? [];
          missionSummary = `Missions: ${Array.isArray(missions) ? missions.length : 0}`;
        } else if (res.status === 401) {
          missionSummary = "Missions: session expired — run: polpo login";
        } else {
          missionSummary = `Missions: error (HTTP ${res.status})`;
        }
      } catch { missionSummary = "Missions: unavailable"; }

      s.stop("Status retrieved");

      clack.log.info(`${taskSummary}\n${agentSummary}\n${missionSummary}`);
      clack.outro(pc.green("Done"));
    });
}
