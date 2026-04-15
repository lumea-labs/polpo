/**
 * Device-code browser login flow.
 *
 * Used by both `polpo login` and the smart `requireAuth()` helper to
 * trigger an interactive OAuth-style login when creds are missing.
 *
 * Flow:
 *   1. POST /v1/cli-auth/request  → returns { code, expiresAt }
 *   2. Open `{dashboard}/cli-auth?code=<code>` in the user's browser
 *   3. Poll /v1/cli-auth/poll/{code} until approved or expired
 *   4. Save creds to ~/.polpo/credentials.json on success
 *
 * Does NOT retry automatically. Callers (requireAuth) can wrap in a
 * retry loop if they want the user to try again on failure.
 */
import pc from "picocolors";
import { openBrowser } from "./browser.js";
import { saveCredentials, type Credentials } from "../commands/cloud/config.js";

const DEFAULT_API_URL = "https://api.polpo.sh";
const DEFAULT_DASHBOARD_URL = "https://polpo.sh";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DeviceCodeOptions {
  /** API base URL (default https://api.polpo.sh). */
  apiUrl?: string;
  /** Dashboard URL hosting the approval page (default https://polpo.sh). */
  dashboardUrl?: string;
  /** When true, do not auto-open the browser — just print the URL. */
  noBrowser?: boolean;
}

export class DeviceCodeError extends Error {
  constructor(
    message: string,
    public reason: "network" | "expired" | "timeout" | "server",
  ) {
    super(message);
    this.name = "DeviceCodeError";
  }
}

/**
 * Run the device-code login flow end-to-end.
 *
 * Resolves with the saved credentials on success.
 * Throws `DeviceCodeError` on failure (network, expired, timeout).
 */
export async function performDeviceCodeLogin(
  opts: DeviceCodeOptions = {},
): Promise<Credentials> {
  const baseUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const dashboardUrl = opts.dashboardUrl ?? DEFAULT_DASHBOARD_URL;

  // 1. Request a code
  let code: string;
  let expiresAt: string;
  try {
    const res = await fetch(`${baseUrl}/v1/cli-auth/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      throw new DeviceCodeError(
        `Server returned ${res.status}. Is ${baseUrl} reachable?`,
        "server",
      );
    }
    const data = (await res.json()) as { code: string; expiresAt: string };
    code = data.code;
    expiresAt = data.expiresAt;
  } catch (err) {
    if (err instanceof DeviceCodeError) throw err;
    throw new DeviceCodeError(
      `Could not reach the API at ${baseUrl}: ${(err as Error).message}`,
      "network",
    );
  }

  // 2. Prompt + open browser
  console.log(`\n  Authorization code: ${pc.bold(code)}\n`);

  const authUrl = `${dashboardUrl}/cli-auth?code=${code}`;
  if (opts.noBrowser) {
    console.log(`  Open this URL to authorize:\n  ${authUrl}\n`);
  } else {
    console.log("  Opening browser...");
    console.log(pc.dim(`  If it doesn't open, visit: ${authUrl}\n`));
    await openBrowser(authUrl);
  }

  process.stdout.write("  Waiting for authorization...");

  // 3. Poll
  const expiry = new Date(expiresAt).getTime();
  const POLL_MS = 2000;

  while (Date.now() < expiry) {
    await sleep(POLL_MS);

    try {
      const res = await fetch(`${baseUrl}/v1/cli-auth/poll/${code}`);

      if (res.status === 404) {
        throw new DeviceCodeError("Code expired.", "expired");
      }

      const data = (await res.json()) as { status: string; token?: string };

      if (data.status === "approved" && data.token) {
        saveCredentials(data.token, baseUrl);
        console.log(pc.green("\n\n  Logged in successfully."));
        console.log(pc.dim(`  Base URL: ${baseUrl}\n`));
        return { apiKey: data.token, baseUrl };
      }

      if (data.status === "expired") {
        throw new DeviceCodeError("Code expired.", "expired");
      }

      process.stdout.write(".");
    } catch (err) {
      if (err instanceof DeviceCodeError) throw err;
      // Network blip — retry silently
    }
  }

  throw new DeviceCodeError("Timed out waiting for authorization.", "timeout");
}
