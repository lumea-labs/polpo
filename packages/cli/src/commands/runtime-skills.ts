import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { runDeploy } from "./cloud/deploy.js";
import {
  assignRuntimeSkills,
  discoverRuntimeSkills,
  installRuntimeSkills,
  listLocalRuntimeSkills,
  readRuntimeSkillsLock,
  removeRuntimeSkill,
  unassignRuntimeSkills,
  type DiscoveredRuntimeSkill,
} from "../util/runtime-skills.js";
import { withRuntimeSkillSource } from "../util/runtime-skill-source.js";

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function fail(error: unknown): void {
  clack.log.error(pc.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

async function deployIfRequested(projectDir: string, deploy: boolean | undefined): Promise<void> {
  if (!deploy) return;
  const report = await runDeploy({ dir: projectDir, yes: true, silent: true });
  if (report.total.failed > 0) {
    throw new Error(`Deploy completed with ${report.total.failed} failed resource(s)`);
  }
  clack.log.success("Project deployed");
}

async function selectSkills(
  available: readonly DiscoveredRuntimeSkill[],
  requested: readonly string[],
  all: boolean | undefined,
): Promise<DiscoveredRuntimeSkill[]> {
  if (available.length === 0) throw new Error("No valid SKILL.md bundles were found in the source");
  if (all) return [...available];
  if (requested.length > 0) {
    const selected = available.filter((skill) => requested.includes(skill.name));
    const found = new Set(selected.map((skill) => skill.name));
    const missing = [...new Set(requested)].filter((name) => !found.has(name));
    if (missing.length > 0) {
      throw new Error(`Requested skill${missing.length === 1 ? "" : "s"} not found: ${missing.join(", ")}. Available: ${available.map((skill) => skill.name).join(", ")}`);
    }
    return selected;
  }
  if (available.length === 1) return [available[0]];
  if (!process.stdin.isTTY) {
    throw new Error(`The source contains multiple skills. Use --skill <name> or --all. Available: ${available.map((skill) => skill.name).join(", ")}`);
  }
  const choices = await clack.multiselect<string>({
    message: "Select runtime skills to add",
    options: available.map((skill) => ({
      value: skill.name,
      label: skill.name,
      hint: skill.description,
    })),
    required: true,
  });
  if (clack.isCancel(choices)) throw new Error("Cancelled");
  const selected = new Set(choices);
  return available.filter((skill) => selected.has(skill.name));
}

function logInstallResult(result: ReturnType<typeof installRuntimeSkills>): void {
  for (const name of result.installed) clack.log.success(`Installed ${pc.bold(name)}`);
  for (const name of result.updated) clack.log.success(`Updated ${pc.bold(name)}`);
  for (const name of result.unchanged) clack.log.info(`${pc.bold(name)} is already current`);
  for (const name of result.skipped) clack.log.warn(`${pc.bold(name)} exists locally; use --force to replace it`);
  for (const assignment of result.assigned) {
    clack.log.success(`Assigned ${pc.bold(assignment.skill)} to ${pc.bold(assignment.agent)}`);
  }
}

interface DirectoryOptions { dir: string; deploy?: boolean }

export function registerRuntimeSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description("Manage runtime skills stored in .polpo/skills");

  skills.command("list")
    .description("List local runtime skills and agent assignments")
    .option("-d, --dir <path>", "Project directory", ".")
    .option("--json", "Print JSON")
    .action((options: DirectoryOptions & { json?: boolean }) => {
      try {
        const items = listLocalRuntimeSkills(options.dir);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
        } else if (items.length === 0) {
          clack.log.info("No local runtime skills.");
        } else {
          clack.log.info(items.map((item) => {
            const assignment = item.assignedTo.length ? ` → ${item.assignedTo.join(", ")}` : "";
            return `  ${pc.bold(item.name)}${pc.dim(assignment)}\n    ${pc.dim(item.description)}`;
          }).join("\n"));
        }
      } catch (error) { fail(error); }
    });

  skills.command("add <source>")
    .description("Add complete Agent Skills bundles from a local directory or Git repository")
    .option("--skill <name>", "Install a named skill (repeatable)", collectOption, [])
    .option("--all", "Install every skill found in the source")
    .option("--agent <name>", "Assign installed skills to an agent (repeatable)", collectOption, [])
    .option("--force", "Replace local bundles that differ")
    .option("--deploy", "Deploy the project after the local change")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (source: string, options: DirectoryOptions & {
      skill: string[]; all?: boolean; agent: string[]; force?: boolean;
    }) => {
      try {
        await withRuntimeSkillSource(source, options.dir, async (checkout) => {
          const selected = await selectSkills(discoverRuntimeSkills(checkout.root), options.skill, options.all);
          logInstallResult(installRuntimeSkills({
            projectDir: options.dir,
            skills: selected,
            source: checkout.source,
            revision: checkout.revision,
            agents: options.agent,
            force: options.force,
          }));
        });
        await deployIfRequested(options.dir, options.deploy);
      } catch (error) { fail(error); }
    });

  skills.command("assign <skill>")
    .description("Assign a local runtime skill to one or more agents")
    .requiredOption("--agent <name>", "Agent name (repeatable)", collectOption, [])
    .option("--deploy", "Deploy the project after the local change")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (skill: string, options: DirectoryOptions & { agent: string[] }) => {
      try {
        const changes = assignRuntimeSkills(options.dir, [skill], options.agent);
        if (changes.length === 0) clack.log.info(`${skill} is already assigned`);
        else for (const change of changes) clack.log.success(`Assigned ${change.skill} to ${change.agent}`);
        await deployIfRequested(options.dir, options.deploy);
      } catch (error) { fail(error); }
    });

  skills.command("unassign <skill>")
    .description("Remove a runtime skill assignment from one or more agents")
    .requiredOption("--agent <name>", "Agent name (repeatable)", collectOption, [])
    .option("--deploy", "Deploy the project after the local change")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (skill: string, options: DirectoryOptions & { agent: string[] }) => {
      try {
        const changes = unassignRuntimeSkills(options.dir, [skill], options.agent);
        if (changes.length === 0) clack.log.info(`${skill} was not assigned`);
        else for (const change of changes) clack.log.success(`Unassigned ${change.skill} from ${change.agent}`);
        await deployIfRequested(options.dir, options.deploy);
      } catch (error) { fail(error); }
    });

  skills.command("remove <skill>")
    .alias("rm")
    .description("Remove a local runtime skill and all of its agent assignments")
    .option("--yes", "Skip confirmation")
    .option("--deploy", "Deploy the project after the local change")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (skill: string, options: DirectoryOptions & { yes?: boolean }) => {
      try {
        if (!options.yes) {
          if (!process.stdin.isTTY) throw new Error("Use --yes in non-interactive environments");
          const confirmed = await clack.confirm({ message: `Remove runtime skill ${skill}?` });
          if (clack.isCancel(confirmed) || !confirmed) return;
        }
        if (removeRuntimeSkill(options.dir, skill)) clack.log.success(`Removed ${skill}`);
        else clack.log.info(`Runtime skill ${skill} is not installed`);
        await deployIfRequested(options.dir, options.deploy);
      } catch (error) { fail(error); }
    });

  skills.command("update [skill]")
    .description("Update installed runtime skills from skills.lock.json")
    .option("--all", "Update every locked runtime skill")
    .option("--deploy", "Deploy the project after the local change")
    .option("-d, --dir <path>", "Project directory", ".")
    .action(async (skill: string | undefined, options: DirectoryOptions & { all?: boolean }) => {
      try {
        const lock = readRuntimeSkillsLock(options.dir);
        const names = options.all
          ? Object.keys(lock.skills).sort()
          : skill ? [skill] : [];
        if (names.length === 0) throw new Error("Provide a skill name or use --all");
        const missing = names.filter((name) => !lock.skills[name]);
        if (missing.length) throw new Error(`No lock entry for: ${missing.join(", ")}`);

        const bySource = new Map<string, string[]>();
        for (const name of names) {
          const source = lock.skills[name].source;
          bySource.set(source, [...(bySource.get(source) ?? []), name]);
        }
        for (const [source, sourceNames] of bySource) {
          await withRuntimeSkillSource(source, options.dir, async (checkout) => {
            const available = discoverRuntimeSkills(checkout.root);
            const selected = await selectSkills(available, sourceNames.map((name) => lock.skills[name].sourceSkill), false);
            logInstallResult(installRuntimeSkills({
              projectDir: options.dir,
              skills: selected,
              source: checkout.source,
              revision: checkout.revision,
              force: true,
            }));
          });
        }
        await deployIfRequested(options.dir, options.deploy);
      } catch (error) { fail(error); }
    });
}
