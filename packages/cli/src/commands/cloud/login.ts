/**
 * polpo login — authenticate with the Polpo Cloud API.
 *
 * Default: browser-based device-code flow (user approves in the dashboard,
 * CLI polls for the issued token).
 * Fallback: --api-key for CI/CD and headless environments.
 */
import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { loadCredentials, saveCredentials } from "./config.js";
import { createApiClient } from "./api.js";
import { isTTY } from "./prompt.js";
import { performDeviceCodeLogin, DeviceCodeError } from "../../util/device-code.js";

const DEFAULT_API_URL = "https://api.polpo.sh";
const DEFAULT_DASHBOARD_URL = "https://polpo.sh";

/** After login, try to auto-resolve the project if user has exactly one. */
async function autoResolveProject(apiKey: string, baseUrl: string): Promise<void> {
  try {
    const client = createApiClient({ apiKey, baseUrl });
    const orgsRes = await client.get<any[]>("/v1/orgs");
    const orgs = Array.isArray(orgsRes.data) ? orgsRes.data : [];
    if (orgs.length === 0) return;

    const projRes = await client.get<any[]>(`/v1/projects?orgId=${orgs[0].id}`);
    const projects = Array.isArray(projRes.data) ? projRes.data : [];

    if (projects.length === 1) {
      clack.log.info(`Project: ${pc.bold(projects[0].name)}`);
    } else if (projects.length > 1) {
      clack.log.info(`${projects.length} projects found. Deploy will auto-link.`);
    }
  } catch { /* best effort */ }
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with the Polpo Cloud API")
    .option("--api-key <key>", "API key (skip browser flow)")
    .option("--url <base-url>", "API base URL")
    .option("--dashboard-url <url>", "Dashboard URL")
    .option("--no-browser", "Print URL instead of opening browser")
    .action(async (opts) => {
      clack.intro(pc.bold("Polpo — Login"));

      const baseUrl: string = opts.url ?? DEFAULT_API_URL;
      const dashboardUrl: string = opts.dashboardUrl ?? DEFAULT_DASHBOARD_URL;

      // Check if already logged in
      const existing = loadCredentials();
      if (existing && isTTY() && !opts.apiKey) {
        const reauth = await clack.confirm({
          message: "Already logged in. Re-authenticate?",
          initialValue: false,
        });
        if (clack.isCancel(reauth) || !reauth) {
          clack.outro("Keeping existing credentials.");
          return;
        }
      }

      // --- Direct API key flow ---
      if (opts.apiKey) {
        // Validate the key before saving
        const s = clack.spinner();
        s.start("Validating API key...");
        try {
          const client = createApiClient({ apiKey: opts.apiKey, baseUrl });
          const res = await client.get<any>("/v1/orgs");
          if (res.status === 401 || res.status === 403) {
            s.stop("Validation failed.");
            clack.outro(pc.red("Invalid API key. Check the key and try again."));
            process.exit(1);
          }
          if (res.status >= 500) {
            s.stop("Validation failed.");
            clack.outro(pc.red(`Polpo Cloud is having issues (HTTP ${res.status}). Try again shortly.`));
            process.exit(1);
          }
          if (res.status >= 400) {
            s.stop("Validation failed.");
            clack.outro(pc.red(`Could not validate the API key (HTTP ${res.status}).`));
            process.exit(1);
          }
        } catch (err: any) {
          s.stop("Validation failed.");
          clack.log.error(`Could not reach the API at ${baseUrl}`);
          clack.outro(pc.red(err.message));
          process.exit(1);
        }

        s.stop("API key validated.");
        saveCredentials(opts.apiKey, baseUrl);
        clack.log.success("Credentials saved.");
        await autoResolveProject(opts.apiKey, baseUrl);
        clack.outro(pc.green("Logged in."));
        return;
      }

      // --- Non-TTY: require --api-key ---
      if (!isTTY()) {
        const key = await clack.password({
          message: "API key:",
        });
        if (clack.isCancel(key)) {
          clack.cancel("Cancelled.");
          process.exit(1);
        }
        if (key) {
          saveCredentials(key, baseUrl);
          clack.log.success("Credentials saved.");
          clack.outro(pc.green("Logged in."));
          return;
        }
        clack.log.error("--api-key is required in non-interactive mode.");
        clack.outro(pc.red("Usage: polpo login --api-key <key>"));
        process.exit(1);
      }

      // --- Browser-based device-code flow ---
      clack.log.info("Logging in to Polpo Cloud...");
      try {
        const creds = await performDeviceCodeLogin({
          apiUrl: baseUrl,
          dashboardUrl,
          noBrowser: opts.browser === false,
        });
        await autoResolveProject(creds.apiKey, creds.baseUrl);
        clack.outro(pc.green("Logged in."));
      } catch (err) {
        if (err instanceof DeviceCodeError) {
          clack.log.error(err.message);
          clack.outro(pc.red("Run `polpo login` again when ready."));
          process.exit(1);
        }
        throw err;
      }
    });
}
