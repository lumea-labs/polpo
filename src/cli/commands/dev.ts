/**
 * polpo dev — start the local API server + dashboard.
 *
 * Boots a Hono server on 127.0.0.1:3890 (default) that serves both the
 * API (`/api/v1/*`) and the static dashboard. When a `.polpo/polpo.json`
 * exists, the orchestrator auto-starts. Without it, the server still runs
 * but the orchestrator is deferred — useful for first-run setup.
 *
 * The browser opens automatically unless `--no-open` is passed.
 */
import type { Command } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import { DEFAULT_SERVER_PORT, DEFAULT_SERVER_HOST, getPolpoDir } from "../../core/constants.js";
import { openBrowser } from "../util/browser.js";

interface DevOptions {
  port: string;
  host: string;
  dir: string;
  apiKey?: string;
  corsOrigins?: string;
  open?: boolean; // commander: --no-open → open: false
}

export function registerDevCommand(program: Command): void {
  program
    .command("dev")
    .description("Start the local API server + dashboard")
    .option("-p, --port <port>", "Port to listen on", String(DEFAULT_SERVER_PORT))
    .option("-H, --host <host>", "Host to bind to", DEFAULT_SERVER_HOST)
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--api-key <key>", "API key for authentication (optional)")
    .option("--cors-origins <origins>", "Comma-separated allowed CORS origins (env: POLPO_CORS_ORIGINS)")
    .option("--no-open", "Do not auto-open the browser")
    .action(async (opts: DevOptions) => {
      const { PolpoServer } = await import("../../server/index.js");

      const workDir = resolve(opts.dir);
      const port = parseInt(opts.port, 10);

      const apiKeys = opts.apiKey ? [opts.apiKey] : [];

      const corsRaw = opts.corsOrigins ?? process.env.POLPO_CORS_ORIGINS;
      const corsOrigins = corsRaw
        ? corsRaw.split(",").map((o: string) => o.trim()).filter(Boolean)
        : undefined;

      const configPath = resolve(getPolpoDir(workDir), "polpo.json");
      const hasConfig = existsSync(configPath);

      if (!hasConfig) {
        console.log(
          chalk.yellow.bold("  No Polpo project found here.\n") +
          chalk.dim("  Run: polpo create   — to create a new project\n") +
          chalk.dim("       polpo link --project-id <id>   — to link an existing one\n"),
        );
      }

      // Security warning: no authentication configured
      if (hasConfig && apiKeys.length === 0) {
        const isExposed = opts.host === "0.0.0.0" || opts.host === "::";
        console.log(
          chalk.yellow.bold("\n  WARNING: No API key configured — server has no authentication.\n") +
          (isExposed
            ? chalk.yellow(`  The server is binding to ${opts.host} (all interfaces) and is accessible\n`) +
              chalk.yellow("  from the network. Anyone on your network can control your agents.\n\n") +
              chalk.yellow("  To secure it, use: ") + chalk.white("polpo dev --api-key <secret>\n")
            : chalk.dim("  Server is localhost-only. Use --api-key <secret> for network access.\n")),
        );
      }

      const server = new PolpoServer({
        port,
        host: opts.host,
        workDir,
        apiKeys,
        corsOrigins,
        autoStart: hasConfig,
      });

      await server.start();

      // Auto-open browser unless --no-open was passed. Skip on non-TTY / CI.
      const canOpen = opts.open !== false && process.stdin.isTTY && !process.env.CI;
      if (canOpen) {
        const host = opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : opts.host;
        const url = `http://${host}:${port}`;
        await openBrowser(url);
      }
    });
}
