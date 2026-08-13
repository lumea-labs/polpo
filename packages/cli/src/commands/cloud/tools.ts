/**
 * polpo tools — manage custom tools (defineTool). [BETA]
 *
 * Tool entrypoints `export default defineTool({...})`. Relative TypeScript and
 * JSON dependencies are packaged with the entrypoint and executed inside the
 * project sandbox. These commands wrap the cloud API (`/v1/tools`).
 */
import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import * as clack from "@clack/prompts";
import { createApiClient } from "./api.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";
import {
  collectCustomToolSourceArtifact,
  extractCustomToolName,
} from "../../util/custom-tool-source.js";

function clientFor(creds: { apiKey: string; baseUrl: string }) {
  return createApiClient(creds, loadProjectId());
}

export function registerToolsCommand(program: Command): void {
  const tools = program
    .command("tools")
    .description("Manage custom tools (defineTool) [beta]");

  // polpo tools push <file>
  tools
    .command("push <file>")
    .description("Upload a custom tool from a .ts file")
    .option("--name <name>", "Tool name (defaults to the `name:` in the source)")
    .action(async (file: string, opts: { name?: string }) => {
      clack.intro(pc.bold("polpo tools push") + pc.dim(" (beta)"));
      const creds = await requireAuth({ context: "Pushing a custom tool requires an authenticated session." });

      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) {
        clack.outro(pc.red(`File not found: ${abs}`));
        process.exit(1);
      }
      const source = fs.readFileSync(abs, "utf-8");
      const name = opts.name ?? extractCustomToolName(source) ?? path.basename(abs).replace(/\.[tj]s$/, "");
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        clack.outro(pc.red(`Invalid tool name "${name}" — use snake_case, or pass --name.`));
        process.exit(1);
      }

      const s = clack.spinner();
      s.start(`Pushing "${name}"...`);
      try {
        const artifact = await collectCustomToolSourceArtifact(abs, path.dirname(abs));
        const res = await clientFor(creds).post<any>("/v1/tools", { name, artifact });
        if (res.status >= 200 && res.status < 300) {
          s.stop(`Pushed "${name}".`);
          clack.outro(pc.green("Done"));
        } else {
          const d = res.data as { error?: string; details?: string[] };
          s.stop(pc.red("Failed"));
          clack.outro(pc.red(friendlyError(d?.details?.join("; ") ?? d?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        s.stop(pc.red("Failed"));
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });

  // polpo tools list
  tools
    .command("list")
    .description("List custom tools")
    .action(async () => {
      clack.intro(pc.bold("polpo tools list") + pc.dim(" (beta)"));
      const creds = await requireAuth({ context: "Listing custom tools requires an authenticated session." });
      const s = clack.spinner();
      s.start("Fetching tools...");
      try {
        const res = await clientFor(creds).get<any>("/v1/tools");
        if (res.status >= 200 && res.status < 300) {
          const list = (res.data?.data ?? []) as Array<{ name: string; description?: string | null }>;
          s.stop("Fetched tools.");
          if (!list.length) {
            clack.log.info(`No custom tools.\n${pc.dim("Push one with ")}${pc.bold("polpo tools push <file>")}`);
          } else {
            clack.log.info(`Custom tools:\n${list.map((t) => `  ${pc.bold(t.name)}${t.description ? pc.dim(" — " + t.description) : ""}`).join("\n")}`);
          }
          clack.outro(pc.green("Done"));
        } else {
          s.stop(pc.red("Failed"));
          clack.outro(pc.red(friendlyError((res.data as any)?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        s.stop(pc.red("Failed"));
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });

  // polpo tools get <name>
  tools
    .command("get <name>")
    .description("Print a tool's source")
    .action(async (name: string) => {
      const creds = await requireAuth({ context: "Fetching a custom tool requires an authenticated session." });
      try {
        const res = await clientFor(creds).get<any>(`/v1/tools/${encodeURIComponent(name)}`);
        if (res.status >= 200 && res.status < 300) {
          process.stdout.write((res.data?.data?.source ?? "") + "\n");
        } else {
          console.error(pc.red(friendlyError((res.data as any)?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        console.error(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });

  // polpo tools run <name> --args '{...}'
  tools
    .command("run <name>")
    .description("Run a tool in the sandbox with args (JSON)")
    .option("--args <json>", "Arguments as a JSON object", "{}")
    .action(async (name: string, opts: { args: string }) => {
      clack.intro(pc.bold("polpo tools run") + pc.dim(" (beta)"));
      const creds = await requireAuth({ context: "Running a custom tool requires an authenticated session." });
      let args: unknown;
      try {
        args = JSON.parse(opts.args);
      } catch {
        clack.outro(pc.red("--args must be valid JSON."));
        process.exit(1);
      }
      const s = clack.spinner();
      s.start(`Running "${name}"...`);
      try {
        const res = await clientFor(creds).post<any>(`/v1/tools/${encodeURIComponent(name)}/run`, { args });
        if (res.status >= 200 && res.status < 300) {
          const text = (res.data?.data?.content ?? []).map((c: any) => c.text ?? "").join("") || JSON.stringify(res.data?.data);
          s.stop("Ran.");
          clack.log.info(text);
          clack.outro(pc.green("Done"));
        } else {
          s.stop(pc.red("Failed"));
          clack.outro(pc.red(friendlyError((res.data as any)?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        s.stop(pc.red("Failed"));
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });

  // polpo tools rm <name>
  tools
    .command("rm <name>")
    .alias("remove")
    .description("Delete a custom tool")
    .action(async (name: string) => {
      clack.intro(pc.bold("polpo tools rm") + pc.dim(" (beta)"));
      const creds = await requireAuth({ context: "Deleting a custom tool requires an authenticated session." });
      const s = clack.spinner();
      s.start(`Deleting "${name}"...`);
      try {
        const res = await clientFor(creds).delete<any>(`/v1/tools/${encodeURIComponent(name)}`);
        if (res.status >= 200 && res.status < 300) {
          s.stop(`Deleted "${name}".`);
          clack.outro(pc.green("Done"));
        } else if (res.status === 404) {
          s.stop(pc.yellow("Not found"));
          clack.outro(pc.yellow(`No custom tool "${name}".`));
          process.exit(1);
        } else {
          s.stop(pc.red("Failed"));
          clack.outro(pc.red(friendlyError((res.data as any)?.error ?? `HTTP ${res.status}`)));
          process.exit(1);
        }
      } catch (err) {
        s.stop(pc.red("Failed"));
        clack.outro(pc.red(friendlyError((err as Error).message)));
        process.exit(1);
      }
    });
}
