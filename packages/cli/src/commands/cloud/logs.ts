/**
 * polpo cloud-logs — view logs or follow events via SSE.
 */
import type { Command } from "commander";
import pc from "picocolors";
import { createApiClient } from "./api.js";
import { loadProjectId } from "./project-context.js";
import { requireAuth } from "../../util/auth.js";
import { friendlyError } from "../../util/errors.js";

export function registerLogsCommand(program: Command): void {
  program
    .command("cloud-logs")
    .description("View logs or follow live events")
    .option("--follow", "Follow live events via SSE")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (opts) => {
      const creds = await requireAuth({
        context: "Viewing logs requires an authenticated session.",
      });

      const projectId = loadProjectId(opts.dir);
      if (!projectId) {
        console.error(pc.red("No project linked in this directory."));
        console.error(pc.dim("\n  Run ") + pc.bold("polpo create") + pc.dim(" or ") + pc.bold("polpo link --project-id <id>") + pc.dim(" first."));
        process.exit(1);
      }

      if (opts.follow) {
        // SSE streaming
        const url = `${creds.baseUrl.replace(/\/$/, "")}/v1/events`;
        try {
          const sseHeaders: Record<string, string> = {
            Authorization: `Bearer ${creds.apiKey}`,
            Accept: "text/event-stream",
          };
          if (projectId) sseHeaders["x-project-id"] = projectId;
          const res = await fetch(url, { headers: sseHeaders,
          });

          if (!res.ok) {
            console.error(pc.red(friendlyError(`HTTP ${res.status}: SSE connection failed`)));
            process.exit(1);
          }

          if (!res.body) {
            console.error(pc.red("No response body for SSE stream."));
            process.exit(1);
          }

          console.log("Following events (Ctrl+C to stop)...");

          const decoder = new TextDecoder();
          const reader = res.body.getReader();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            let currentEvent = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                currentEvent = line.slice(7);
              } else if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (currentEvent === "heartbeat") continue;
                if (currentEvent) {
                  console.log(`[${currentEvent}] ${data}`);
                } else {
                  console.log(data);
                }
              }
            }
          }
        } catch (err: any) {
          if (err.name === "AbortError") return;
          console.error(pc.red(friendlyError(err.message)));
          process.exit(1);
        }
      } else {
        // Fetch recent logs
        const client = createApiClient(creds, projectId);

        try {
          const res = await client.get<any>("/v1/state/logs");
          if (res.status === 200) {
            const data = res.data?.data ?? res.data;
            if (Array.isArray(data)) {
              if (data.length === 0) {
                console.log("No recent logs.");
              } else {
                for (const entry of data) {
                  if (typeof entry === "string") {
                    console.log(entry);
                  } else {
                    const ts = entry.timestamp ?? "";
                    const msg = entry.message ?? JSON.stringify(entry);
                    console.log(`${ts ? ts + " " : ""}${msg}`);
                  }
                }
              }
            } else {
              console.log(JSON.stringify(data, null, 2));
            }
          } else {
            console.error(pc.red(friendlyError(`HTTP ${res.status}`)));
            process.exit(1);
          }
        } catch (err: any) {
          console.error(pc.red(friendlyError(err.message)));
          process.exit(1);
        }
      }
    });
}
