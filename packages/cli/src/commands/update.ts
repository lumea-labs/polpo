import { execSync } from "node:child_process";
import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import {
  detectPackageManager,
  getLatestVersion,
  runSelfUpdate,
} from "../util/self-update.js";

/**
 * Check if running inside an Electron (desktop) app.
 */
function isDesktopApp(): boolean {
  if ((process.versions as any).electron) return true;
  const execPath = process.execPath || "";
  return (
    execPath.includes("Polpo.app") ||
    execPath.includes("polpo-server") ||
    !!process.env.ELECTRON_RUN_AS_NODE
  );
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .alias("upgrade")
    .description("Update Polpo to the latest version")
    .option("--check", "Only check for updates, don't install")
    .action(async (opts) => {
      clack.intro(pc.bold("Polpo — Update"));

      try {
        const currentVersion = program.version();
        clack.log.info(`Current version: ${pc.dim(currentVersion)}`);

        const s = clack.spinner();
        s.start("Checking for updates...");

        const latest = await getLatestVersion();

        if (latest === currentVersion) {
          s.stop("Version check complete");
          clack.outro(pc.green(`Already up to date (${currentVersion})`));
          return;
        }

        s.stop("Version check complete");
        clack.log.warn(
          `${pc.yellow("Update available:")} ${pc.dim(currentVersion)} → ${pc.bold(pc.cyan(latest))}`,
        );

        if (opts.check) {
          clack.outro(pc.dim(`Run ${pc.white("polpo update")} to install.`));
          return;
        }

        const pm = detectPackageManager();
        s.start(`Updating via ${pm}...`);
        const result = runSelfUpdate(latest);

        if (!result.success) {
          s.stop("Update failed");
          const msg = result.error ?? "";
          if (/EACCES|permission denied/i.test(msg)) {
            clack.log.error("Permission denied while installing.");
            clack.log.info(
              `Try one of:\n  ${pc.dim(`sudo ${result.cmd}`)}\n  ${pc.dim("npm config set prefix ~/.npm-global  (one-time)")}`,
            );
          } else {
            clack.log.error(`Update failed: ${msg || "unknown error"}`);
          }
          clack.outro(pc.red("Update failed."));
          process.exit(1);
        }

        s.stop("Update installed");

        // Verify
        try {
          const newVer = execSync("polpo --version", { encoding: "utf-8" }).trim();
          clack.log.success(`Updated to ${pc.bold(newVer)}`);
        } catch {
          clack.log.success("Update complete. Restart your shell to use the new version.");
        }

        if (isDesktopApp()) {
          clack.log.warn(
            "You're running inside the Polpo desktop app.\nRestart the app to apply the update to the desktop binary.",
          );
        }

        clack.outro(pc.green("Update complete."));
      } catch (err: any) {
        clack.log.error(`Update failed: ${err.message}`);
        clack.log.info(`Try manually: ${pc.bold("npm install -g polpo-ai@latest")}`);
        clack.outro(pc.red("Update failed."));
        process.exit(1);
      }
    });
}
