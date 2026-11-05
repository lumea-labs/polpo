import {
  ConnectError,
  normalizeConnectorDefinition,
  type ConnectorActionGateway,
  type ConnectorActionRequest,
  type ConnectorDefinition,
} from "@polpo-ai/connect";

export type ConnectorContributionRequestGateway = (
  request: ConnectorActionRequest["request"],
) => ReturnType<ConnectorActionGateway>;

export type ConnectorContributionExecutionContext = Readonly<{
  /**
   * Host-authorized request gateway. It resolves credentials and enforces the
   * Connector HTTP policy. Action identity and scopes are injected by the
   * registry from the immutable definition; contribution code cannot widen
   * either one and never receives a secret.
   */
  request: ConnectorContributionRequestGateway;
}>;

export type ConnectorContributionHostContext = Readonly<{
  request: ConnectorActionGateway;
}>;

export type ConnectorContributionExecutor = (
  actionId: string,
  input: unknown,
  context: ConnectorContributionExecutionContext,
) => Promise<unknown>;

export interface ConnectorContribution {
  readonly definition: ConnectorDefinition;
  readonly execute?: ConnectorContributionExecutor;
}

export interface ConnectorContributionTool {
  readonly name: string;
  readonly providerId: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ConnectorContributionRegistry {
  list(): readonly ConnectorContribution[];
  definitions(): readonly ConnectorDefinition[];
  tools(): readonly ConnectorContributionTool[];
  getByProvider(providerId: string): ConnectorContribution | undefined;
  getByAction(actionId: string): ConnectorContribution | undefined;
  execute(actionId: string, input: unknown, context: ConnectorContributionHostContext): Promise<unknown>;
}

/**
 * Validates one independently owned Connector module. Static HTTP API actions
 * are inseparable from their executor; MCP tools remain runtime-discovered.
 */
export function defineConnectorContribution(input: {
  definition: ConnectorDefinition;
  execute?: ConnectorContributionExecutor;
}): ConnectorContribution {
  const definition = normalizeConnectorDefinition(input.definition);
  const actions = definition.actions ?? [];
  if (definition.protocol === "http_api" && actions.length > 0 && !input.execute) {
    throw new ConnectError("invalid_provider", `Connector contribution "${definition.id}" requires an action executor`);
  }
  if (actions.length === 0 && input.execute) {
    throw new ConnectError("invalid_provider", `Connector contribution "${definition.id}" does not declare actions`);
  }
  return Object.freeze({
    definition,
    ...(input.execute ? { execute: input.execute } : {}),
  });
}

/**
 * The only shared integration point for curated Connector modules. It rejects
 * ambiguous global tool names before a host can expose them to a model.
 */
export function createConnectorContributionRegistry(
  values: readonly ConnectorContribution[],
): ConnectorContributionRegistry {
  const contributions: ConnectorContribution[] = [];
  const byProvider = new Map<string, ConnectorContribution>();
  const byAction = new Map<string, ConnectorContribution>();
  const tools: ConnectorContributionTool[] = [];

  for (const value of values) {
    const contribution = defineConnectorContribution(value);
    const providerId = contribution.definition.id;
    if (byProvider.has(providerId)) {
      throw new ConnectError("invalid_provider", `Duplicate connector contribution: ${providerId}`);
    }
    byProvider.set(providerId, contribution);
    contributions.push(contribution);

    for (const action of contribution.definition.actions ?? []) {
      if (byAction.has(action.id)) {
        throw new ConnectError("invalid_provider", `Duplicate connector action: ${action.id}`);
      }
      byAction.set(action.id, contribution);
      tools.push(Object.freeze({
        name: action.id,
        providerId,
        label: action.label ?? action.id,
        description: action.description ?? action.label ?? action.id,
        parameters: (action.inputSchema ?? Object.freeze({
          type: "object",
          additionalProperties: false,
          properties: Object.freeze({}),
        })) as Record<string, unknown>,
      }));
    }
  }

  Object.freeze(contributions);
  Object.freeze(tools);
  const snapshot = <T>(items: readonly T[]): readonly T[] => Object.freeze([...items]);

  return Object.freeze({
    list: () => snapshot(contributions),
    definitions: () => snapshot(contributions.map((entry) => entry.definition)),
    tools: () => snapshot(tools),
    getByProvider: (providerId: string) => byProvider.get(providerId),
    getByAction: (actionId: string) => byAction.get(actionId),
    async execute(actionId: string, input: unknown, context: ConnectorContributionHostContext) {
      const contribution = byAction.get(actionId);
      if (!contribution?.execute) {
        throw new ConnectError("invalid_request", `Unknown connector action "${actionId}"`, { status: 404 });
      }
      const action = contribution.definition.actions!.find((entry) => entry.id === actionId)!;
      return contribution.execute(actionId, input, {
        request: request => context.request({
          actionId,
          scopes: [...(action.scopes ?? [])],
          request,
        }),
      });
    },
  });
}
