/**
 * polpo login — authenticate with the Polpo Cloud API.
 *
 * Default: browser-based device-code flow (user approves in the dashboard,
 * CLI polls for the issued token).
 * Fallback: --api-key for CI/CD and headless environments.
 */
import type { Command } from "commander";
import { loadCredentials, saveCredentials } from "./config.js";
import { createApiClient } from "./api.js";
import { isTTY, promptMasked, confirm } from "./prompt.js";
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
      console.log(`  Project: ${projects[0].name}`);
    } else if (projects.length > 1) {
      console.log(`  ${projects.length} projects found. Deploy will auto-link.`);
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
      const baseUrl: string = opts.url ?? DEFAULT_API_URL;
      const dashboardUrl: string = opts.dashboardUrl ?? DEFAULT_DASHBOARD_URL;

      // Check if already logged in
      const existing = loadCredentials();
      if (existing && isTTY() && !opts.apiKey) {
        const ok = await confirm("  Already logged in. Re-authenticate?");
        if (!ok) return;
      }

      // --- Direct API key flow ---
      if (opts.apiKey) {
        // Validate the key before saving
        console.log("  Validating API key...");
        try {
          const client = createApiClient({ apiKey: opts.apiKey, baseUrl });
          const res = await client.get<any>("/v1/orgs");
          if (res.status === 401 || res.status === 403) {
            console.error("  Error: Invalid API key. Check the key and try again.");
            process.exit(1);
          }
          if (res.status >= 500) {
            console.error(`  Error: Polpo Cloud is having issues (HTTP ${res.status}). Try again shortly.`);
            process.exit(1);
          }
          if (res.status >= 400) {
            console.error(`  Error: Could not validate the API key (HTTP ${res.status}).`);
            process.exit(1);
          }
        } catch (err: any) {
          console.error(`  Error: Could not reach the API at ${baseUrl}`);
          console.error(`  ${err.message}`);
          process.exit(1);
        }

        saveCredentials(opts.apiKey, baseUrl);
        console.log("  Credentials saved.");
        await autoResolveProject(opts.apiKey, baseUrl);
        console.log();
        return;
      }

      // --- Non-TTY: require --api-key ---
      if (!isTTY()) {
        const key = await promptMasked("API key: ").catch(() => null);
        if (key) {
          saveCredentials(key, baseUrl);
          console.log("  Credentials saved.");
          return;
        }
        console.error("Error: --api-key is required in non-interactive mode.");
        console.error("Usage: polpo login --api-key <key>");
        process.exit(1);
      }

      // --- Browser-based device-code flow ---
      console.log("\n  Logging in to Polpo Cloud...");
      try {
        const creds = await performDeviceCodeLogin({
          apiUrl: baseUrl,
          dashboardUrl,
          noBrowser: opts.browser === false,
        });
        await autoResolveProject(creds.apiKey, creds.baseUrl);
      } catch (err) {
        if (err instanceof DeviceCodeError) {
          console.error(`\n\n  ${err.message}`);
          console.error("  Run `polpo login` again when ready.");
          process.exit(1);
        }
        throw err;
      }
    });
}
