import { execSync } from "node:child_process";
import type { Command } from "commander";
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
      try {
        const currentVersion = program.version();
        console.log(pc.dim(`  Current version: ${currentVersion}`));
        console.log(pc.dim("  Checking for updates..."));

        const latest = await getLatestVersion();

        if (latest === currentVersion) {
          console.log(pc.green(`\n  Already up to date (${currentVersion})`));
          return;
        }

        console.log(
          `\n  ${pc.yellow("Update available:")} ${pc.dim(currentVersion)} → ${pc.bold(pc.cyan(latest))}`,
        );

        if (opts.check) {
          console.log(pc.dim(`\n  Run ${pc.white("polpo update")} to install.`));
          return;
        }

        const pm = detectPackageManager();
        console.log(pc.dim(`\n  Updating via ${pm}...`));
        const result = runSelfUpdate(latest);

        if (!result.success) {
          const msg = result.error ?? "";
          if (/EACCES|permission denied/i.test(msg)) {
            console.error(pc.red("\n  Permission denied while installing."));
            console.error(pc.dim("  Try one of:"));
            console.error(pc.dim(`    sudo ${result.cmd}`));
            console.error(pc.dim(`    npm config set prefix ~/.npm-global  (one-time)`));
          } else {
            console.error(pc.red("\n  Update failed: ") + (msg || "unknown error"));
          }
          process.exit(1);
        }

        // Verify
        try {
          const newVer = execSync("polpo --version", { encoding: "utf-8" }).trim();
          console.log(pc.green(`\n  Updated to ${newVer}`));
        } catch {
          console.log(pc.green(`\n  Update complete. Restart your shell to use the new version.`));
        }

        if (isDesktopApp()) {
          console.log(
            pc.yellow(`\n  You're running inside the Polpo desktop app.`),
          );
          console.log(
            pc.yellow(`  Restart the app to apply the update to the desktop binary.`),
          );
        }
      } catch (err: any) {
        console.error(pc.red(`\n  Update failed: ${err.message}`));
        console.log(pc.dim("  Try manually: npm install -g polpo-ai@latest"));
        process.exit(1);
      }
    });
}
