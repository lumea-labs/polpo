import {
  ConnectError,
  compileConnectorDefinition,
  type ConnectorActionGateway,
} from "@polpo-ai/connect";
import { createConnectorContributionRegistry } from "./contribution.js";
import {
  gmailContribution,
  gmailDefinition,
  GMAIL_READ_SCOPE,
  GOOGLE_IDENTITY_SCOPES,
} from "./contributions/gmail/index.js";
import {
  DRIVE_READ_SCOPE,
  googleDriveContribution,
  googleDriveDefinition,
} from "./contributions/google-drive/index.js";

export {
  DRIVE_READ_SCOPE,
  GMAIL_READ_SCOPE,
  GOOGLE_IDENTITY_SCOPES,
  gmailDefinition,
  googleDriveDefinition,
};
export type GoogleActionGateway = ConnectorActionGateway;

export const gmailConnector = compileConnectorDefinition(gmailDefinition);
export const googleDriveReadOnlyConnector = compileConnectorDefinition(googleDriveDefinition);

const googleContributions = createConnectorContributionRegistry([
  gmailContribution,
  googleDriveContribution,
]);

/** @deprecated Prefer the provider-specific contribution registry executor. */
export async function executeGoogleAction(
  actionId: string,
  input: unknown,
  context: { request: GoogleActionGateway },
): Promise<unknown> {
  if (!googleContributions.getByAction(actionId)) {
    throw new ConnectError("invalid_request", "Unsupported Google action");
  }
  return googleContributions.execute(actionId, input, context);
}
