import { execSync } from "node:child_process";
import type { Command } from "commander";
import pc from "picocolors";

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

/**
 * Detect which package manager installed polpo globally.
 */
function detectPackageManager(): "pnpm" | "npm" {
  try {
    const out = execSync("pnpm list -g polpo-ai --depth=0 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (out.includes("polpo-ai")) return "pnpm";
  } catch { /* not pnpm */ }
  return "npm";
}

/**
 * Get the latest version from the npm registry.
 */
async function getLatestVersion(): Promise<string> {
  const res = await fetch("https://registry.npmjs.org/polpo-ai/latest", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Registry returned ${res.status}`);
  const data = (await res.json()) as { version: string };
  return data.version;
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

        // Clear cache to avoid stale versions
        try {
          if (pm === "npm") execSync("npm cache clean --force", { stdio: "ignore", timeout: 30_000 });
        } catch { /* best effort */ }

        const cmd =
          pm === "pnpm"
            ? `pnpm add -g polpo-ai@${latest}`
            : `npm install -g polpo-ai@${latest}`;

        console.log(pc.dim(`\n  Updating via ${pm}...`));
        console.log(pc.dim(`  $ ${cmd}\n`));

        execSync(cmd, { stdio: "inherit", timeout: 120_000 });

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
