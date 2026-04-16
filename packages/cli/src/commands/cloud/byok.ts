/**
 * polpo byok — manage BYOK (Bring Your Own Key) API keys.
 */
import type { Command } from "commander";
import pc from "picocolors";
import { createApiClient } from "./api.js";
import { isTTY, promptMasked } from "./prompt.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";

const KNOWN_PROVIDERS = [
  "openai",
  "anthropic",
  "xai",
  "google",
  "groq",
  "openrouter",
  "cerebras",
  "gemini",
];

function warnUnknownProvider(provider: string): void {
  if (!KNOWN_PROVIDERS.includes(provider.toLowerCase())) {
    console.error(
      pc.yellow(`Warning: "${provider}" isn't a recognised provider name.`),
    );
    console.error(pc.dim(`  Known: ${KNOWN_PROVIDERS.join(", ")}`));
  }
}

export function registerByokCommand(program: Command): void {
  const byok = program
    .command("byok")
    .description("Manage BYOK (Bring Your Own Key) API keys");

  byok
    .command("set <provider>")
    .description("Set a BYOK key for a provider")
    .option("--key <key>", "API key for the provider")
    .option("--label <label>", "Optional label")
    .option("--project <project-id>", "Project ID (if not in credentials)")
    .action(async (provider: string, opts) => {
      const creds = await requireAuth({
        context: "Managing BYOK keys requires an authenticated session.",
      });
      warnUnknownProvider(provider);

      let key: string | undefined = opts.key;
      if (!key) {
        if (isTTY()) {
          key = await promptMasked(`API key for ${provider}: `);
          if (!key) {
            console.error(pc.red("API key is required."));
            process.exit(1);
          }
        } else {
          console.error(pc.red("--key is required in non-interactive mode."));
          process.exit(1);
        }
      }

      const client = createApiClient(creds);
      try {
        const res = await client.post("/v1/byok", { provider, key, label: opts.label });

        if (res.status >= 200 && res.status < 300) {
          console.log(pc.green(`✓ BYOK key set for "${provider}".`));
        } else {
          const data = res.data as { error?: string };
          console.error(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        console.error(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });

  byok
    .command("list")
    .description("List BYOK keys")
    .option("--project <project-id>", "Project ID (if not in credentials)")
    .action(async () => {
      const creds = await requireAuth({
        context: "Listing BYOK keys requires an authenticated session.",
      });
      const client = createApiClient(creds);

      try {
        const res = await client.get("/v1/byok");

        if (res.status >= 200 && res.status < 300) {
          const data = res.data as { data?: Array<{ provider: string; maskedKey: string; label?: string }> };
          const keys = data?.data ?? [];
          if (keys.length === 0) {
            console.log(pc.dim("No BYOK keys configured."));
            console.log(pc.dim("Add one with ") + pc.bold("polpo byok set <provider>"));
          } else {
            console.log("BYOK keys:");
            for (const k of keys) {
              const label = k.label ? ` (${k.label})` : "";
              console.log(`  ${k.provider}: ${k.maskedKey}${label}`);
            }
          }
        } else {
          const data = res.data as { error?: string };
          console.error(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        console.error(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });

  byok
    .command("remove <provider>")
    .description("Remove a BYOK key")
    .option("--project <project-id>", "Project ID (if not in credentials)")
    .action(async (provider: string) => {
      const creds = await requireAuth({
        context: "Removing BYOK keys requires an authenticated session.",
      });
      const client = createApiClient(creds);

      try {
        const res = await client.delete(`/v1/byok/${provider}`);

        if (res.status >= 200 && res.status < 300) {
          console.log(pc.green(`✓ BYOK key removed for "${provider}".`));
        } else if (res.status === 404) {
          console.error(pc.yellow(`No BYOK key found for "${provider}".`));
          process.exit(1);
        } else {
          const data = res.data as { error?: string };
          console.error(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        console.error(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });
}
