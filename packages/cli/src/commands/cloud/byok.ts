/**
 * polpo byok — manage BYOK (Bring Your Own Key) API keys.
 */
import type { Command } from "commander";
import pc from "picocolors";
import * as clack from "@clack/prompts";
import { createApiClient } from "./api.js";
import { isTTY } from "./prompt.js";
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
    clack.log.warn(
      `"${provider}" isn't a recognised provider name.\n${pc.dim(`Known: ${KNOWN_PROVIDERS.join(", ")}`)}`,
    );
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
      clack.intro(pc.bold("polpo byok set"));

      const creds = await requireAuth({
        context: "Managing BYOK keys requires an authenticated session.",
      });
      warnUnknownProvider(provider);

      let key: string | undefined = opts.key;
      if (!key) {
        if (isTTY()) {
          const result = await clack.password({
            message: `API key for ${provider}`,
          });
          if (clack.isCancel(result) || !result) {
            clack.outro(pc.red("API key is required."));
            process.exit(1);
          }
          key = result;
        } else {
          clack.outro(pc.red("--key is required in non-interactive mode."));
          process.exit(1);
        }
      }

      const s = clack.spinner();
      s.start(`Setting BYOK key for "${provider}"...`);
      const client = createApiClient(creds);
      try {
        const res = await client.post("/v1/byok", { provider, key, label: opts.label });

        if (res.status >= 200 && res.status < 300) {
          s.stop(`BYOK key set for "${provider}".`);
          clack.outro(pc.green("Done"));
        } else {
          const data = res.data as { error?: string };
          s.stop(pc.red("Failed"));
          clack.outro(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        s.stop(pc.red("Failed"));
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });

  byok
    .command("list")
    .description("List BYOK keys")
    .option("--project <project-id>", "Project ID (if not in credentials)")
    .action(async () => {
      clack.intro(pc.bold("polpo byok list"));

      const creds = await requireAuth({
        context: "Listing BYOK keys requires an authenticated session.",
      });
      const client = createApiClient(creds);

      const s = clack.spinner();
      s.start("Fetching BYOK keys...");
      try {
        const res = await client.get("/v1/byok");

        if (res.status >= 200 && res.status < 300) {
          const data = res.data as { data?: Array<{ provider: string; maskedKey: string; label?: string }> };
          const keys = data?.data ?? [];
          s.stop("Fetched BYOK keys.");
          if (keys.length === 0) {
            clack.log.info(
              `No BYOK keys configured.\n${pc.dim("Add one with ")}${pc.bold("polpo byok set <provider>")}`,
            );
          } else {
            const lines = keys.map((k) => {
              const label = k.label ? ` (${k.label})` : "";
              return `  ${k.provider}: ${k.maskedKey}${label}`;
            });
            clack.log.info(`BYOK keys:\n${lines.join("\n")}`);
          }
          clack.outro(pc.green("Done"));
        } else {
          const data = res.data as { error?: string };
          s.stop(pc.red("Failed"));
          clack.outro(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        s.stop(pc.red("Failed"));
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });

  byok
    .command("remove <provider>")
    .description("Remove a BYOK key")
    .option("--project <project-id>", "Project ID (if not in credentials)")
    .action(async (provider: string) => {
      clack.intro(pc.bold("polpo byok remove"));

      const creds = await requireAuth({
        context: "Removing BYOK keys requires an authenticated session.",
      });
      const client = createApiClient(creds);

      const s = clack.spinner();
      s.start(`Removing BYOK key for "${provider}"...`);
      try {
        const res = await client.delete(`/v1/byok/${provider}`);

        if (res.status >= 200 && res.status < 300) {
          s.stop(`BYOK key removed for "${provider}".`);
          clack.outro(pc.green("Done"));
        } else if (res.status === 404) {
          s.stop(pc.yellow("Not found"));
          clack.outro(pc.yellow(`No BYOK key found for "${provider}".`));
          process.exit(1);
        } else {
          const data = res.data as { error?: string };
          s.stop(pc.red("Failed"));
          clack.outro(pc.red(friendlyError(data?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        s.stop(pc.red("Failed"));
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });
}
