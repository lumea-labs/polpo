import { createConnectorContributionRegistry } from "../contribution.js";
import { githubContribution } from "./github/index.js";
import { slackContribution } from "./slack/index.js";
import { gmailContribution } from "./gmail/index.js";
import { googleDriveContribution } from "./google-drive/index.js";

export * from "./github/index.js";
export * from "./slack/index.js";
export * from "./gmail/index.js";
export * from "./google-drive/index.js";

/**
 * Deliberately explicit: adding a Connector changes the public catalog and
 * therefore requires one small integration review instead of runtime globbing.
 */
export const defaultConnectorContributions = Object.freeze([
  githubContribution,
  slackContribution,
  googleDriveContribution,
  gmailContribution,
]);

export const defaultConnectorContributionRegistry = createConnectorContributionRegistry(
  defaultConnectorContributions,
);
