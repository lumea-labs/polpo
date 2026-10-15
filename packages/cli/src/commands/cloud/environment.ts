import type { Command } from "commander";
import { parseProjectEnvironment, type ProjectEnvironment } from "@polpo-ai/core/project-environment";

export interface EnvironmentOptions {
  env?: string;
  prod?: boolean;
}

/** CLI-only default. SDK/API requests without a selector follow their key. */
export function resolveCliEnvironment(options: EnvironmentOptions): ProjectEnvironment {
  const explicit = options.env === undefined ? undefined : parseProjectEnvironment(options.env);
  if (options.prod && explicit !== undefined && explicit !== "production") {
    throw new Error("--prod conflicts with --env development. Choose one environment.");
  }
  return explicit ?? (options.prod ? "production" : "development");
}

/** Attach to an action command, so its handler receives the selected options. */
export function addEnvironmentOptions(command: Command): Command {
  return command
    .option("--env <environment>", "Target development (default) or production")
    .option("--prod", "Target production explicitly")
    .hook("preAction", (_command, action) => {
      resolveCliEnvironment(action.optsWithGlobals());
    });
}

/** Resource groups expose the same flags on every leaf, including nested commands. */
export function addEnvironmentOptionsToActions(group: Command): void {
  for (const command of group.commands) {
    if (command.commands.length > 0) addEnvironmentOptionsToActions(command);
    else addEnvironmentOptions(command);
  }
}
