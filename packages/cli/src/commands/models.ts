/**
 * polpo models list — list available models from the Polpo AI Gateway.
 */
import { Command } from "commander";
import pc from "picocolors";

const GATEWAY_URL = "https://polpo.sh/api/gateway/models";

interface GatewayModel {
  id: string;
  owned_by: string;
  type?: string | null;
  context_window?: number;
  pricing?: { input: string; output: string } | null;
}

export function registerModelsCommands(parent: Command): void {
  const models = parent
    .command("models")
    .description("List available AI models");

  models
    .command("list")
    .description("List available models from the AI Gateway")
    .option("--provider <name>", "Filter by provider (e.g. anthropic, openai, xai)")
    .option("--json", "Output as JSON")
    .option("--plain", "One model per line (machine-friendly)")
    .action(async (opts: { provider?: string; json?: boolean; plain?: boolean }) => {
      let data: GatewayModel[];
      try {
        const res = await fetch(GATEWAY_URL);
        if (!res.ok) {
          console.error(`Error: Could not fetch models (HTTP ${res.status})`);
          process.exit(1);
        }
        const json = await res.json() as any;
        data = json.data ?? json ?? [];
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }

      if (opts.provider) {
        data = data.filter(m => m.id.startsWith(`${opts.provider}/`));
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      if (opts.plain) {
        for (const m of data) console.log(m.id);
        return;
      }

      // Group by provider
      const byProvider = new Map<string, GatewayModel[]>();
      for (const m of data) {
        const provider = m.id.split("/")[0] ?? m.owned_by;
        if (!byProvider.has(provider)) byProvider.set(provider, []);
        byProvider.get(provider)!.push(m);
      }

      console.log(`\n  ${pc.bold(`${data.length} models`)} from ${byProvider.size} providers\n`);

      for (const [provider, models] of byProvider) {
        console.log(`  ${pc.bold(provider)} (${models.length})`);
        for (const m of models) {
          const ctx = m.context_window ? pc.dim(` ${(m.context_window / 1000).toFixed(0)}k`) : "";
          const price = m.pricing ? pc.dim(` $${m.pricing.input}/$${m.pricing.output}`) : "";
          console.log(`    ${m.id}${ctx}${price}`);
        }
        console.log();
      }
    });
}
