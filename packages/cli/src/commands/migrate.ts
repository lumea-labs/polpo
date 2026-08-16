import * as path from "node:path";
import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { migrateProjectLayoutV2 } from "@polpo-ai/file-stores";

export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .description("Migrate the current .polpo project to the latest filesystem layout")
    .option("--dir <path>", "Project directory", ".")
    .option("--dry-run", "Validate and show the migration without writing files")
    .action((options: { dir: string; dryRun?: boolean }) => {
      const polpoDir = path.resolve(options.dir, ".polpo");
      const result = migrateProjectLayoutV2(polpoDir, { dryRun: options.dryRun });
      if (!result.changed) {
        clack.outro("Project already uses the current layout.");
        return;
      }
      const summary = [
        `${result.agents} agent${result.agents === 1 ? "" : "s"}`,
        `${result.teams} team${result.teams === 1 ? "" : "s"}`,
        result.projectConfig ? "project config" : undefined,
      ].filter(Boolean).join(", ");
      if (result.dryRun) {
        clack.outro(`${pc.green("Migration is valid")} (${summary}). No files changed.`);
      } else {
        clack.outro(`${pc.green("Migration complete")} (${summary}). Legacy manifests were retained as *.v1.json backups.`);
      }
    });
}
