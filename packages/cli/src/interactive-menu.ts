/**
 * Interactive bare-command menu.
 *
 * When the user runs `polpo` with no arguments on an interactive TTY,
 * we present a picker of the likely next actions instead of dumping
 * help text. Non-TTY invocations (CI, pipe) fall through to commander's
 * default help — no magic there.
 *
 * The menu is state-aware:
 *   - "Log in" shows only when the user is NOT authenticated
 *   - "Deploy this project" shows only when the cwd has .polpo/polpo.json
 *   - Other actions are always offered
 *
 * Selection dispatches to the real subcommand via `program.parseAsync`,
 * so the action lives in one place (its own command file), not duplicated.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { loadCredentials } from "./commands/cloud/config.js";

function hasLinkedProject(cwd: string = process.cwd()): boolean {
  return existsSync(resolve(cwd, ".polpo", "polpo.json"));
}

export function isBareInteractiveInvocation(): boolean {
  return process.argv.length <= 2 && !!process.stdout.isTTY && !process.env.CI;
}

export async function runInteractiveMenu(program: Command): Promise<void> {
  const isLoggedIn = !!loadCredentials();
  const linked = hasLinkedProject();

  clack.intro(pc.bold("Polpo"));

  const options: { value: string; label: string; hint?: string }[] = [];

  if (!isLoggedIn) {
    options.push({ value: "login", label: "Log in to Polpo Cloud" });
  }
  options.push({
    value: "create",
    label: "Create a new project",
    hint: !isLoggedIn ? "requires login" : undefined,
  });
  options.push({
    value: "link",
    label: "Link an existing project",
    hint: !isLoggedIn ? "requires login" : undefined,
  });
  if (linked) {
    options.push({ value: "deploy", label: "Deploy this project" });
  }
  options.push({ value: "projects", label: "List projects" });
  options.push({ value: "docs", label: "View documentation" });
  options.push({ value: "help", label: "Show all commands" });

  const choice = await clack.select<string>({
    message: "What would you like to do?",
    options,
  });

  if (clack.isCancel(choice)) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }

  if (choice === "docs") {
    const { openBrowser } = await import("./util/browser.js");
    await openBrowser("https://docs.polpo.sh");
    clack.outro(pc.dim("Opened https://docs.polpo.sh"));
    return;
  }

  if (choice === "help") {
    clack.outro(pc.dim("Showing full command list."));
    program.outputHelp();
    return;
  }

  // For "link" we need a --project-id. Ask the user up front so the
  // command receives a valid argv.
  if (choice === "link") {
    const projectId = await promptForProjectId();
    if (!projectId) {
      clack.cancel("Cancelled.");
      process.exit(0);
    }
    await program.parseAsync([
      process.argv[0], process.argv[1],
      "link", "--project-id", projectId,
    ]);
    return;
  }

  // Dispatch to the real subcommand. Commander consumes argv shape
  // ['node', 'polpo', '<cmd>', ...args], so we rebuild that here.
  await program.parseAsync([process.argv[0], process.argv[1], choice]);
}

/**
 * Fetch the user's projects and let them pick, with a paste-id fallback
 * for folks whose creds are valid but org/project listing is gated.
 */
async function promptForProjectId(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  const { createApiClient } = await import("./commands/cloud/api.js");
  const { pickOrg } = await import("./util/org.js");
  const { listProjects } = await import("./util/project.js");

  try {
    const client = createApiClient({ apiKey: creds.apiKey, baseUrl: creds.baseUrl });
    const org = await pickOrg(client);
    const projects = await listProjects(client, org.id);

    if (projects.length === 0) {
      clack.log.warn("No projects found in this organization.");
      return null;
    }

    const choice = await clack.select<string>({
      message: "Select a project to link:",
      options: projects.map((p) => ({ value: p.id, label: p.name })),
    });
    if (clack.isCancel(choice)) return null;
    return choice;
  } catch {
    // Fallback to manual paste if the API call fails.
    const id = await clack.text({
      message: "Project ID:",
      placeholder: "c816c3b5-0eab-46a5-aeb0-311a036b271b",
    });
    if (clack.isCancel(id) || !id) return null;
    return id;
  }
}
