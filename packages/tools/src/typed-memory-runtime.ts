import {
  normalizeAgentMemorySettings,
  resolveAllowedToolPolicy,
  toolNameAllowedByPolicy,
  type AgentMemorySettings,
  type MemoryItemStore,
  type ToolInvocationContext,
} from "@polpo-ai/core";
import {
  ALL_TYPED_MEMORY_TOOL_NAMES,
  createTypedMemoryTools,
} from "./typed-memory-tools.js";
import {
  InMemoryMemoryToolOperationCoordinator,
  type MemoryToolOperationCoordinator,
} from "./memory-tool-operations.js";

const defaultOperationCoordinators = new WeakMap<
  MemoryItemStore,
  MemoryToolOperationCoordinator
>();

function operationCoordinatorFor(store: MemoryItemStore) {
  let coordinator = defaultOperationCoordinators.get(store);
  if (!coordinator) {
    coordinator = new InMemoryMemoryToolOperationCoordinator();
    defaultOperationCoordinators.set(store, coordinator);
  }
  return coordinator;
}

export interface TypedMemoryRuntimeAgent {
  readonly name: string;
  readonly allowedTools?: readonly string[];
  readonly memory?: AgentMemorySettings;
}

export interface ResolveTypedMemoryToolsOptions {
  readonly store: MemoryItemStore;
  /** Host-owned hard tenant/project boundary. */
  readonly namespace: string;
  readonly agent: TypedMemoryRuntimeAgent;
  readonly invocation: ToolInvocationContext;
  readonly operationCoordinator?: MemoryToolOperationCoordinator;
}

/**
 * Resolves model-visible typed Memory tools from host-owned execution state.
 * Authorship opts capabilities in; allowedTools may only narrow them.
 */
export function resolveTypedMemoryTools(
  options: ResolveTypedMemoryToolsOptions,
) {
  if (!options.agent.memory || !options.agent.allowedTools) return [];

  const settings = normalizeAgentMemorySettings(options.agent.memory).tools;
  const policy = resolveAllowedToolPolicy({
    global: options.agent.allowedTools,
  });
  const permitted = new Set(
    ALL_TYPED_MEMORY_TOOL_NAMES.filter((name) =>
      toolNameAllowedByPolicy(name, policy)),
  );
  const externalUserId = options.invocation.user?.trim() || undefined;
  const invocationUserWrite = settings.writeScope === "invocation-user";
  const canWrite = !invocationUserWrite || externalUserId !== undefined;

  return createTypedMemoryTools(options.store, {
    agentName: options.agent.name,
    context: {
      namespace: options.namespace,
      access: {
        projectId: options.namespace,
        agentName: options.agent.name,
        ...(externalUserId ? { externalUserId } : {}),
        ...(options.invocation.sessionId
          ? { sessionId: options.invocation.sessionId }
          : {}),
      },
      surface: options.invocation.surface,
    },
    grants: {
      search: settings.search && permitted.has("memory_search"),
      remember: canWrite
        && settings.remember
        && permitted.has("memory_remember"),
      update: canWrite
        && settings.update
        && permitted.has("memory_update_item"),
      forget: canWrite
        && settings.forget
        && permitted.has("memory_forget"),
      writableScopeKinds: [settings.writeScope === "agent" ? "agent" : "user"],
      writableKinds: settings.writableKinds,
    },
    ...(canWrite
      ? {
          writeScope: settings.writeScope === "agent"
            ? { kind: "agent", agentName: options.agent.name }
            : {
                kind: "user",
                subjectId: externalUserId!,
                agentName: options.agent.name,
              },
        }
      : {}),
    provenance: {
      source: "tool",
      actor: "agent",
      sourceId: options.invocation.requestId,
      runId: options.invocation.runId,
      ...(options.invocation.sessionId
        ? { sessionId: options.invocation.sessionId }
        : {}),
      toolName: "memory_remember",
    },
    operationCoordinator: options.operationCoordinator
      ?? operationCoordinatorFor(options.store),
  });
}
