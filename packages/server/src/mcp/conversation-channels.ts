import type {
  ChannelManagementScope,
  ChannelManagementService,
  ChannelProvisioningResult,
  SecureChannelSetupAction,
} from "@polpo-ai/channels";

export type ChannelManagementToolContext = Readonly<{
  invocation: unknown;
}>;

export type ChannelManagementToolDefinition = Readonly<{
  annotations?: Readonly<{
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    readOnlyHint?: boolean;
  }>;
  description: string;
  execute: (args: Record<string, unknown>, context: ChannelManagementToolContext) => Promise<unknown>;
  inputSchema: Record<string, unknown>;
  name: string;
  title: string;
}>;

export type ChannelManagementToolsOptions = {
  requestUrlElicitation?: (
    action: SecureChannelSetupAction,
    context: ChannelManagementToolContext,
  ) => Promise<void>;
  resolveScope: (context: ChannelManagementToolContext) => ChannelManagementScope | Promise<ChannelManagementScope>;
  service: ChannelManagementService;
};

const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const string = (description: string): Record<string, unknown> => ({ type: "string", description });

async function maybeElicit(
  result: ChannelProvisioningResult,
  context: ChannelManagementToolContext,
  request?: ChannelManagementToolsOptions["requestUrlElicitation"],
): Promise<ChannelProvisioningResult> {
  if (request && (result.status === "setup_required" || result.status === "pending_external") && result.setup) {
    await request(result.setup, context);
  }
  return result;
}

export function createChannelManagementTools(
  options: ChannelManagementToolsOptions,
): readonly ChannelManagementToolDefinition[] {
  const scope = (context: ChannelManagementToolContext) => options.resolveScope(context);
  return [
    {
      name: "polpo_channels_providers",
      title: "List Channel providers",
      description: "List conversational Channel providers and their safe setup capabilities.",
      inputSchema: object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: async () => options.service.listProviders(),
    },
    {
      name: "polpo_channels_list",
      title: "List Channels",
      description: "List conversational Channels in the authenticated project. Credentials are never returned.",
      inputSchema: object({
        provider: { type: "string", enum: ["slack", "telegram", "discord", "whatsapp"] },
        status: { type: "string", enum: ["pending", "active", "disabled", "error"] },
        connectionId: string("Optional Connection id filter."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: async (args, context) => options.service.list(await scope(context), args as any),
    },
    {
      name: "polpo_channels_get",
      title: "Get Channel",
      description: "Inspect one conversational Channel without exposing provider credentials or webhook secrets.",
      inputSchema: object({ channelId: string("Channel id.") }, ["channelId"]),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: async (args, context) => options.service.get(await scope(context), String(args.channelId)),
    },
    {
      name: "polpo_channels_configure",
      title: "Configure Channel",
      description: "Create or reuse a conversational Channel and grant an agent Route. Missing authorization uses a secure user handoff; never ask for secrets.",
      inputSchema: object({
        provider: { type: "string", enum: ["slack", "telegram", "discord", "whatsapp"] },
        agentName: string("Agent name to route messages to."),
        allowedTools: { type: "array", items: { type: "string" }, maxItems: 256 },
        connectionId: string("Existing project Connection id, when already authorized."),
        externalChannelId: string("Provider destination id, when known."),
        name: string("Optional display name."),
        idempotencyKey: string("Stable key for this logical setup operation."),
        settings: { type: "object", additionalProperties: true },
      }, ["provider", "agentName", "idempotencyKey"]),
      annotations: { idempotentHint: true, openWorldHint: true },
      execute: async (args, context) => maybeElicit(
        await options.service.configure(await scope(context), args as any),
        context,
        options.requestUrlElicitation,
      ),
    },
    {
      name: "polpo_channels_update",
      title: "Update Channel",
      description: "Update the display settings or enabled status of a conversational Channel.",
      inputSchema: object({
        channelId: string("Channel id."),
        name: string("Optional display name."),
        status: { type: "string", enum: ["active", "disabled"] },
        settings: { type: "object", additionalProperties: true },
      }, ["channelId"]),
      annotations: { idempotentHint: true, openWorldHint: false },
      execute: async (args, context) => {
        const { channelId, ...patch } = args;
        return options.service.update(await scope(context), String(channelId), patch as any);
      },
    },
    {
      name: "polpo_channels_test",
      title: "Test Channel",
      description: "Run the provider test for an active conversational Channel.",
      inputSchema: object({
        channelId: string("Channel id."),
        recipient: string("Optional provider recipient for direct-message tests such as WhatsApp."),
      }, ["channelId"]),
      annotations: { openWorldHint: true },
      execute: async (args, context) => options.service.test(
        await scope(context),
        String(args.channelId),
        typeof args.recipient === "string" ? { recipient: args.recipient } : {},
      ),
    },
    {
      name: "polpo_channels_remove",
      title: "Remove Channel",
      description: "Remove a conversational Channel and its Routes. This does not revoke a shared Connection.",
      inputSchema: object({ channelId: string("Channel id.") }, ["channelId"]),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      execute: async (args, context) => options.service.remove(await scope(context), String(args.channelId)),
    },
    {
      name: "polpo_channel_routes_list",
      title: "List Channel Routes",
      description: "List agent Routes granted for one conversational Channel.",
      inputSchema: object({ channelId: string("Channel id.") }, ["channelId"]),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: async (args, context) => options.service.listRoutes(await scope(context), String(args.channelId)),
    },
    {
      name: "polpo_channel_routes_upsert",
      title: "Add or update Channel Route",
      description: "Grant or update one agent Route on a conversational Channel.",
      inputSchema: object({
        channelId: string("Channel id."),
        agentName: string("Agent name."),
        allowedTools: { type: "array", items: { type: "string" }, maxItems: 256 },
        enabled: { type: "boolean" },
        externalChannelId: { type: ["string", "null"] },
        priority: { type: "integer" },
      }, ["channelId", "agentName"]),
      annotations: { idempotentHint: true, openWorldHint: false },
      execute: async (args, context) => options.service.upsertRoute(await scope(context), args as any),
    },
    {
      name: "polpo_channel_routes_remove",
      title: "Remove Channel Route",
      description: "Remove one agent Route without deleting the Channel or Connection.",
      inputSchema: object({ routeId: string("Route id.") }, ["routeId"]),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      execute: async (args, context) => options.service.removeRoute(await scope(context), String(args.routeId)),
    },
    {
      name: "polpo_channel_setup_status",
      title: "Get Channel setup status",
      description: "Inspect a resumable secure Channel setup after the user completes an authorization step.",
      inputSchema: object({ setupId: string("Secure setup id.") }, ["setupId"]),
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: async (args, context) => options.service.setupStatus(await scope(context), String(args.setupId)),
    },
  ];
}
