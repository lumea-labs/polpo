/**
 * polpo login — authenticate with the Polpo Cloud API.
 *
 * Default: browser-based flow (opens browser, user approves, CLI gets session token).
 * Fallback: --api-key for CI/CD and headless environments.
 */
import type { Command } from "commander";
import { loadCredentials, saveCredentials } from "./config.js";
import { createApiClient } from "./api.js";
import { isTTY, promptMasked, confirm } from "./prompt.js";
import { openBrowser } from "../../util/browser.js";

const DEFAULT_API_URL = "https://api.polpo.sh";
const DEFAULT_DASHBOARD_URL = "https://polpo.sh";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

      // --- Browser-based flow ---
      console.log("\n  Logging in to Polpo Cloud...\n");

      let code: string;
      let expiresAt: string;
      try {
        const res = await fetch(`${baseUrl}/v1/cli-auth/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          console.error(`  Error: Server returned ${res.status}. Is ${baseUrl} reachable?`);
          process.exit(1);
        }
        const data = (await res.json()) as { code: string; expiresAt: string };
        code = data.code;
        expiresAt = data.expiresAt;
      } catch (err: any) {
        console.error(`  Error: Could not reach the API at ${baseUrl}`);
        console.error(`  ${err.message}`);
        process.exit(1);
      }

      console.log(`  Your authorization code:\n`);
      console.log(`    ${code}\n`);

      const authUrl = `${dashboardUrl}/cli-auth?code=${code}`;

      if (opts.browser !== false) {
        console.log("  Opening browser...");
        console.log(`  If it doesn't open, visit: ${authUrl}\n`);
        await openBrowser(authUrl);
      } else {
        console.log(`  Open this URL to authorize:\n  ${authUrl}\n`);
      }

      process.stdout.write("  Waiting for authorization...");

      const expiry = new Date(expiresAt).getTime();
      const POLL_MS = 2000;

      while (Date.now() < expiry) {
        await sleep(POLL_MS);

        try {
          const res = await fetch(`${baseUrl}/v1/cli-auth/poll/${code}`);

          if (res.status === 404) {
            console.log("\n\n  Code expired. Run `polpo login` again.");
            process.exit(1);
          }

          const data = (await res.json()) as { status: string; token?: string };

          if (data.status === "approved" && data.token) {
            saveCredentials(data.token, baseUrl);
            console.log("\n\n  Logged in successfully.");
            console.log(`  Base URL: ${baseUrl}`);
            await autoResolveProject(data.token, baseUrl);
            console.log();
            return;
          }

          if (data.status === "expired") {
            console.log("\n\n  Code expired. Run `polpo login` again.");
            process.exit(1);
          }

          process.stdout.write(".");
        } catch {
          // Network blip — retry
        }
      }

      console.log("\n\n  Timed out. Run `polpo login` again.");
      process.exit(1);
    });
}
