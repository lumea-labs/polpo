import type { MissionAbortOptions, MissionExecutionOptions } from "@polpo-ai/core/mission-store";
import { parseProjectEnvironment, type ProjectEnvironment } from "@polpo-ai/core/project-environment";
import { getPolpoDir } from "../core/constants.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { cors } from "hono/cors";
import {
  dispatchChannelWebhook,
  type ChannelInstallationResolver,
  type ChannelManagementScope,
  type ChannelManagementService,
  type ChannelRuntime,
} from "@polpo-ai/channels";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isVersionedAgentStore, type AgentMutation } from "@polpo-ai/core/agent-store";
import { projectLoopConfigSchema } from "@polpo-ai/core/schemas";
import {
  resolveConfiguredModelSelection,
  renderToolResult,
  type ConnectionCapabilityResolver,
} from "@polpo-ai/core";
import { buildSystemPrompt } from "../adapters/spawn-helpers.js";
// NodeFileSystem no longer instantiated here — use orchestrator's getFs() instead
import type { Orchestrator } from "../core/orchestrator.js";
import type { SSEBridge } from "./sse-bridge.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorMiddleware } from "./middleware/error.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
// Shared routes from @polpo-ai/server (edge-compatible, single source of truth)
import {
  healthRoutes,
  routeProjectEnvironment,
  taskRoutes,
  missionRoutes,
  chatRoutes,
  clientToolResolutionRoutes,
  approvalRoutes,
  playbookRoutes,
  stateRoutes,
  completionRoutes,
  scheduleRoutes,
  watcherRoutes,
  vaultRoutes,
  agentRoutes,
  loopRoutes,
  eventRoutes,
  configRoutes,
  customToolRoutes,
  brainRoutes,
  runDeliveryRoutes,
  runSteeringRoutes,
  runtimeHookRoutes,
  conversationChannelRoutes,
  connectRoutes,
  connectCallbackRoutes,
  memoryItemRoutes,
  memoryCandidateRoutes,
  type CompletionRuntimeGuardrailsResolver,
  type CompletionRouteDeps,
  type ConnectRouteDeps,
} from "@polpo-ai/server";
import type { HookHost, HookPackStore } from "@polpo-ai/core/runtime-hooks";
import {
  createProjectHookRuntime,
} from "../runtime-hooks.js";
import { createNodeHookHost } from "../hooks-host.js";
// Node.js-only routes (stay in src/server/routes/)
import { publicConfigRoutes } from "./routes/config.js";
import { filesystemRoutes } from "./routes/filesystem.js";
import { providerRoutes } from "./routes/providers.js";
import { skillRoutes } from "./routes/skills.js";
import { fileRoutes } from "./routes/files.js";
import { createLocalCustomToolRuntime } from "../custom-tools/runtime.js";
import { resolveNodeModelOptions } from "../llm/model-runtime-options.js";
import {
  createConfiguredRunPreflightPolicy,
  createConfiguredRunOutputPolicy,
  createConfiguredRunToolMiddleware,
  resolveRuntimeGuardrailRequestPolicy,
  type RunOutputPolicy,
  type RunPreflightPolicy,
  type RunToolMiddleware,
} from "@polpo-ai/core/guardrails";
import { createLocalBrainRuntime } from "../brain/local-runtime.js";
import { localDataRuntime, type NodeDataRuntime } from "../data/index.js";
import { dataRoutes } from "@polpo-ai/server";
import type {
  BrainManagementService,
  BrainServiceContext,
} from "@polpo-ai/core/brain";
import {
  InMemoryRunEventNotifier,
} from "@polpo-ai/core/run-delivery-follower";
import {
  InMemorySteeringController,
  InMemorySteeringRunRegistry,
  type SteeringController,
} from "@polpo-ai/core/steering";
import { FileRuntimeHookPackStore } from "@polpo-ai/file-stores";

function readRuntimeVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const runtimeVersion = readRuntimeVersion();

/**
 * Explicit allowlist of /api/* routes reachable without an API key when keys
 * are configured. Everything else is denied by default.
 *
 * - health: liveness probes, no data. (The OpenAPI document stays behind the
 *   key, as it always was via the `authed` sub-app middleware.)
 * - Connect OAuth callback: the provider redirects the user's browser here;
 *   it is bound to a single-use server-side state, not to the API key.
 * - /api/environments/*: only rewrites the path and re-enters the app, where
 *   this gate runs again on the rewritten path.
 */
export function isPublicApiPath(
  method: string,
  path: string,
  options: { connectCallbackEnabled: boolean },
): boolean {
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (normalized === "/api/environments" || normalized.startsWith("/api/environments/")) return true;
  if (method !== "GET" && method !== "HEAD") return false;
  if (normalized === "/api/v1/health") return true;
  return options.connectCallbackEnabled && normalized === "/api/v1/connect/oauth/callback";
}

export interface AppOptions {
  /** Fixed identity of this process; configure separate processes/stores for the other environment. */
  environment?: ProjectEnvironment;
  /** Explicit operator-configured Connect service; routes use normal control-plane auth. */
  connectService?: ConnectRouteDeps["connectService"];
  data?: NodeDataRuntime;
  apiKeys?: string[];
  corsOrigins?: string[];
  workDir?: string;
  onInitialize?: (workDir: string) => Promise<void>;
  /** Resolver for strict logical Connection slots used by custom tools. */
  connectionCapabilityResolver?: ConnectionCapabilityResolver;
  resolveMcpCapabilities?: import("@polpo-ai/core").ResolveMcpRuntimeCapabilities;
  /** Optional process-local override for completion tool guardrails. */
  runToolMiddleware?: RunToolMiddleware;
  /** Optional process-local override for final-output guardrails. */
  runOutputPolicy?: RunOutputPolicy;
  /** Optional process-local override for input/context/model guardrails. */
  runPreflightPolicy?: RunPreflightPolicy;
  /**
   * Required with process-local guardrail hook overrides when callers should
   * be allowed to request stricter per-run enforcement.
   */
  resolveRuntimeGuardrails?: CompletionRuntimeGuardrailsResolver;
  /** Host override for resolving immutable runtime hook snapshots. */
  resolveRuntimeHooks?: CompletionRouteDeps["resolveRuntimeHooks"];
  /** Handler adapter for local `.polpo/hooks` packs. Defaults to command + HTTPS handlers. */
  runtimeHookHost?: HookHost;
  /** Persistence override for runtime hook packs. */
  runtimeHookStore?: HookPackStore;
  brain?: {
    service: BrainManagementService;
    resolveContext: (input?: {
      agentName?: string;
    }) => BrainServiceContext | Promise<BrainServiceContext>;
  };
  channels?: {
    resolveInstallation: ChannelInstallationResolver;
    runtime: ChannelRuntime;
    management?: {
      resolveScope?: (requestContext: unknown) => ChannelManagementScope | Promise<ChannelManagementScope>;
      service: ChannelManagementService;
    };
  };
}

/**
 * Create the Hono app with all routes and middleware.
 * Single-orchestrator architecture — no project concept.
 *
 * Route factories receive explicit dependency thunks instead of pulling
 * from Hono context.  This lets consumers wire stores directly
 * without needing the full Orchestrator class.
 */
export function createApp(orchestrator: Orchestrator, sseBridge: SSEBridge, opts?: AppOptions): OpenAPIHono {
  const environment = opts?.environment === undefined ? undefined : parseProjectEnvironment(opts.environment);
  const app = new OpenAPIHono();
  const data = opts?.data ?? (process.env.POLPO_DATA_DATABASE_URL ? localDataRuntime(orchestrator.getPolpoDir()) : undefined);
  const steeringRegistry = new InMemorySteeringRunRegistry();
  const projectPolpoDir = typeof (orchestrator as any).getPolpoDir === "function"
    ? (orchestrator as any).getPolpoDir() as string
    : undefined;
  const runtimeHookStore = opts?.runtimeHookStore
    ?? (projectPolpoDir ? new FileRuntimeHookPackStore(projectPolpoDir) : undefined);
  const runEventNotifier = new InMemoryRunEventNotifier();
  const durableRunOwner = `node-${process.pid}-${randomUUID()}`;
  const knownDurableRuns = new Set<string>();
  const localBrain = !opts?.brain && opts?.workDir
    ? createLocalBrainRuntime({
        workDir: opts.workDir,
        polpoDir: getPolpoDir(opts.workDir),
      })
    : undefined;
  const brain = opts?.brain ?? (
    localBrain
      ? {
          service: localBrain.service,
          resolveContext: (input?: { agentName?: string }) =>
            localBrain.context({
              ...(input?.agentName
                ? {
                    actor: "agent" as const,
                    actorId: input.agentName,
                    agentName: input.agentName,
                  }
                : {
                    actor: "user" as const,
                    actorId: "local-user",
                  }),
            }),
        }
      : undefined
  );
  const hasProcessGuardrailOverrides = Boolean(
    opts?.runToolMiddleware
    || opts?.runOutputPolicy
    || opts?.runPreflightPolicy,
  );

  // Global middleware
  app.use("*", errorMiddleware());
  // Rate limit API routes only (not static assets)
  app.use("/api/*", rateLimitMiddleware());
  app.use("/v1/*", rateLimitMiddleware());

  const corsExposeHeaders = ["x-session-id", "x-polpo-run-id", "x-polpo-run-terminal", "ETag", "Location"];
  if (opts?.corsOrigins && opts.corsOrigins.length > 0) {
    app.use("*", cors({ origin: opts.corsOrigins, exposeHeaders: corsExposeHeaders }));
  } else {
    // Default: restrict to localhost origins only
    app.use("*", cors({
      origin: [
        "http://localhost:3000", "http://localhost:3001",
        "http://localhost:3890", "http://localhost:3891",
        "http://localhost:5173", "http://localhost:5174", "http://localhost:5175", "http://localhost:5176",
        "http://127.0.0.1:3000", "http://127.0.0.1:3001",
        "http://127.0.0.1:3890", "http://127.0.0.1:3891",
        "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175", "http://127.0.0.1:5176",
      ],
      exposeHeaders: corsExposeHeaders,
    }));
  }

  // ── Default-deny authentication for the control API ───────────────────
  //
  // When API keys are configured, every /api/* route requires a key unless it
  // is on the explicit public allowlist below. Routes mounted directly on
  // `app` (setup wizard, filesystem browser, provider key management) used to
  // run before the `authed` sub-app middleware and were therefore reachable
  // without credentials. /v1/* routes authenticate themselves (completions,
  // client-tool resolution, run delivery) or verify provider signatures
  // (channel webhooks).
  if (opts?.apiKeys && opts.apiKeys.length > 0) {
    const requireApiKey = authMiddleware(opts.apiKeys);
    const connectCallbackEnabled = Boolean(opts.connectService);
    app.use("/api/*", (c, next) =>
      isPublicApiPath(c.req.method, c.req.path, { connectCallbackEnabled })
        ? next()
        : requireApiKey(c, next));
  }

  // ── Public routes (no auth) ───────────────────────────────────────────

  app.route("/api/v1/health", healthRoutes(runtimeVersion));
  if (opts?.connectService) app.route("/api/v1/connect", connectCallbackRoutes(() => ({ connectService: opts.connectService })));

  if (opts?.channels) {
    const handleChannelWebhook = async (c: any) => dispatchChannelWebhook({
      provider: c.req.param("provider"),
      request: c.req.raw,
      resolveInstallation: opts.channels!.resolveInstallation,
      routeKey: c.req.param("routeKey") || undefined,
      runtime: opts.channels!.runtime,
      webhookOptions: {
        waitUntil: (task) => {
          void task.catch((error) => {
            console.error(
              "[channels] background webhook failed:",
              error instanceof Error ? error.message : String(error),
            );
          });
        },
      },
    });
    app.all("/v1/channel-webhooks/:provider", handleChannelWebhook);
    app.all("/v1/channel-webhooks/:provider/:routeKey", handleChannelWebhook);
  }

  // Setup routes below do not require an initialized orchestrator, but they
  // DO require an API key when keys are configured (default-deny gate above).

  // Config status + initialize — available before initialization so the setup wizard works
  if (opts?.workDir) {
    app.route("/api/v1/config", publicConfigRoutes(orchestrator, opts.workDir, opts.onInitialize));
  }

  // Filesystem browsing — available before initialization (setup wizard path picker)
  app.route("/api/v1/filesystem", filesystemRoutes());

  // Provider management — available before initialization (API key CRUD, model listing)
  if (opts?.workDir) {
    const polpoDir = getPolpoDir(opts.workDir);
    app.route("/api/v1/providers", providerRoutes(polpoDir));
  }

  // OpenAI-compatible chat completions
  app.route("/v1/chat/completions", completionRoutes(() => ({
    getAgents: () => o.engine.getAgents(),
    ...(isVersionedAgentStore(o.getAgentStore()) ? {
      getAgentSnapshot: (name: string) => o.engine.getAgentSnapshot(name),
    } : {}),
    getConfig: () => o.getConfig(),
    getMemoryStore: () => o.getMemoryStore(),
    getSessionStore: () => o.getSessionStore(),
    onCanonicalTurnCommitted: () => o.reconcileMemoryLearning(),
    getStore: () => o.getStore(),
    createRunDeliveryScope: ({ runId }) => {
      knownDurableRuns.add(runId);
      const stores = o.getRunDeliveryStores();
      return {
        eventStore: stores.eventStore,
        leaseStore: stores.leaseStore,
        cancellationStore: stores.cancellationStore,
        notifier: runEventNotifier,
        owner: durableRunOwner,
        token: randomUUID(),
      };
    },
    runToolMiddleware: opts?.runToolMiddleware
      ?? createConfiguredRunToolMiddleware(o.getConfig()?.settings?.guardrails),
    runOutputPolicy: opts?.runOutputPolicy
      ?? createConfiguredRunOutputPolicy(o.getConfig()?.settings?.guardrails),
    runPreflightPolicy: opts?.runPreflightPolicy
      ?? createConfiguredRunPreflightPolicy(o.getConfig()?.settings?.guardrails),
    ...(
      opts?.resolveRuntimeGuardrails
      || !hasProcessGuardrailOverrides
        ? {
            resolveRuntimeGuardrails:
              opts?.resolveRuntimeGuardrails
              ?? ((request) => {
                const settings = resolveRuntimeGuardrailRequestPolicy(
                  o.getConfig()?.settings?.guardrails,
                  request,
                );
                const runToolMiddleware =
                  createConfiguredRunToolMiddleware(settings);
                const runOutputPolicy =
                  createConfiguredRunOutputPolicy(settings);
                const runPreflightPolicy =
                  createConfiguredRunPreflightPolicy(settings);
                if (
                  !runToolMiddleware
                  || !runOutputPolicy
                  || !runPreflightPolicy
                ) {
                  throw new Error(
                    "Strict guardrail policy did not create all runtime hooks",
                  );
                }
                return {
                  runToolMiddleware,
                  runOutputPolicy,
                  runPreflightPolicy,
                };
              }),
          }
        : {}
    ),
    emit: (event: string, data: any) => o.emit(event as any, data),
    resolveRuntimeHooks: opts?.resolveRuntimeHooks ?? (async ({ agentConfig, surface, runId, sessionId, loop, step, turnId }) => {
      const names = Array.isArray(agentConfig?.hooks)
        ? agentConfig.hooks.filter((name: unknown): name is string => typeof name === "string")
        : [];
      if (names.length === 0) return undefined;
      if (!projectPolpoDir) throw new Error("Runtime hook project directory is unavailable");
      const host = opts?.runtimeHookHost ?? createNodeHookHost({
        record: async (execution) => { o.emit("runtime:hook" as any, execution); },
      });
      const cwd = o.getAgentWorkDir();
      return await createProjectHookRuntime({
        polpoDir: projectPolpoDir,
        names,
        host,
        context: {
          sessionId: sessionId ?? runId ?? "polpo",
          cwd,
          projectDir: opts?.workDir ?? cwd,
          permissionMode: "default",
          ...(agentConfig?.name ? { agentType: agentConfig.name } : {}),
          polpo: {
            ...(runId ? { run_id: runId } : {}),
            ...(turnId ? { turn_id: turnId } : {}),
            ...(loop ? { loop } : {}),
            ...(step ? { step } : {}),
            surface,
          },
        },
      });
    }),
    resolveExecutionRouteClassifier: (context) =>
      o.resolveExecutionRouteClassifier(context),
    resolveAgentModel: async (agentConfig: any, reasoning?: string) => {
      const { buildResolvedModelProviderOptions, resolveModel } = await import("@polpo-ai/llm");
      const settings = o.getConfig()?.settings;
      const modelSpec = agentConfig.model
        ? resolveConfiguredModelSelection(
            agentConfig.model,
            settings ?? {},
            agentConfig.allowedModelProfiles,
          ).policy.primary
        : undefined;
      const m = resolveModel(modelSpec, resolveNodeModelOptions(modelSpec, o.getGatewayConfig()));
      const r = agentConfig.reasoning ?? reasoning;
      const providerOptions = buildResolvedModelProviderOptions(m, r);
      return { model: m, providerOptions };
    },
    buildAgentPrompt: (agentConfig: any, promptOptions) => {
      return buildSystemPrompt(
        agentConfig,
        o.getAgentWorkDir(),
        o.getPolpoDir(),
        undefined,
        agentConfig.allowedPaths,
        promptOptions?.activatedSkills,
      );
    },
    resolveAgentTools: async (agentConfig: any, _runScope, invocation, signal) => {
      const { createSystemTools, createMemoryTools, createBrainTools, createDataTools, resolveTypedMemoryTools, resolveRuntimeMcpTools, expandToolWildcards, TOOL_CATALOG } = await import("@polpo-ai/tools");
      const { resolveAgentVault } = await import("../vault/index.js");
      const { nanoid } = await import("nanoid");
      const vaultEntries = await o.getVaultStore()?.getAllForAgent(agentConfig.name);
      const vault = resolveAgentVault(vaultEntries);
      const tools: any[] = createSystemTools(o.getAgentWorkDir(), agentConfig.allowedTools, agentConfig.allowedPaths, undefined, vault, o.getFs(), o.getShell());
      if (data && agentConfig.allowedTools) tools.push(...createDataTools(data.forAgent(agentConfig.name), expandToolWildcards(agentConfig.allowedTools, TOOL_CATALOG)));
      tools.push(...await customTools(agentConfig.name).loadAssigned(
        agentConfig.allowedTools,
        undefined,
        invocation,
      ));
      const memoryStore = o.getMemoryStore();
      if (memoryStore) {
        const memoryTools = createMemoryTools(memoryStore, agentConfig.name);
        // Respect allowedTools — when omitted, all memory tools load (back-compat).
        const allowed = agentConfig.allowedTools
          ? expandToolWildcards(agentConfig.allowedTools, TOOL_CATALOG)
          : null;
        const filtered = allowed
          ? memoryTools.filter((t: any) => allowed.includes(t.name))
          : memoryTools;
        tools.push(...filtered);
      }
      if (invocation) {
        tools.push(...resolveTypedMemoryTools({
          store: o.getMemoryItemStore(),
          namespace: o.getPolpoDir(),
          agent: agentConfig,
          invocation,
        }));
      }
      if (brain && agentConfig.allowedTools) {
        const allowed = expandToolWildcards(
          agentConfig.allowedTools,
          TOOL_CATALOG,
        );
        if (
          allowed.includes("brain_search")
          || allowed.includes("source_read")
        ) {
          tools.push(...createBrainTools(
            brain.service,
            await brain.resolveContext({ agentName: agentConfig.name }),
            allowed,
          ));
        }
      }
      // External MCP-server tools (stdio / SSE / HTTP) declared on the agent.
      // The connections are opened once per request; `dispose` is wired into
      // the `cleanup` callback so transports close as soon as the agent's
      // turn finishes — no orphaned file descriptors / keep-alives.
      const mcp = await resolveRuntimeMcpTools({ agentName: agentConfig.name, mcpServers: agentConfig.mcpServers, vault,
        invocation, signal, resolveCapabilities: opts?.resolveMcpCapabilities, policy: { global: agentConfig.allowedTools } });
      tools.push(...mcp.tools);
      const toolMap = new Map(tools.map((t: any) => [t.name, t]));
      const executor = async (name: string, args: Record<string, unknown>, execution?: { callId?: string; signal?: AbortSignal }): Promise<string> => {
        const tool = toolMap.get(name);
        if (!tool) return `Error: Unknown tool "${name}"`;
        try {
          const result = await tool.execute(execution?.callId ?? nanoid(), args as any, execution?.signal);
          return renderToolResult(result);
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      };
      return {
        tools,
        executor,
        cleanup: mcp.dispose,
        disclosure: { mode: agentConfig.toolLoading?.mode ?? "auto" },
      };
    },
    getProjectLoop: (name: string) => o.getProjectLoop(name),
    createRunSteeringScope: async (runId: string) => {
      const steering = new InMemorySteeringController();
      const release = await steeringRegistry.register(runId, steering);
      return { steering, release };
    },
    // Run chat completions through the shared executeRun lifecycle +
    // loop-engine. Injects the route's
    // already-resolved model/prompt/tools/messages so the engine runs a chat
    // turn-loop at parity with the inline handler. Stream runs are persisted
    // for observability but excluded from background task collection.
    runChatViaRun: async (inject: any, hooks: {
      onEvent: (e: Record<string, unknown>) => void;
      signal?: AbortSignal;
      runId?: string;
      steering?: SteeringController;
    }) => {
      const { executeRun } = await import("../core/run-lifecycle.js");
      const { nanoid } = await import("nanoid");
      const runId = hooks.runId ?? `chat-${nanoid()}`;
      const steering = hooks.steering ?? new InMemorySteeringController();
      const task: any = {
        id: runId, title: inject.title ?? "chat", description: "",
        assignTo: inject.agent?.name ?? "agent", dependsOn: [], status: "pending",
        expectations: [], metrics: [], retries: 0, maxRetries: 0,
      };
      const outcome = await executeRun(
        {
          runId, taskId: runId, agent: inject.agent, task,
          agentIdentity: inject.toolInvocation?.agent,
          toolInvocation: inject.toolInvocation,
          polpoDir: o.getPolpoDir(), cwd: o.getAgentWorkDir(),
          outputDir: join(o.getPolpoDir(), "output", runId),
        } as any,
        {
          runStore: o.getRunStore(),
          pid: -1,
          configPath: `memory://${runId}`,
          fs: o.getFs(),
          shell: o.getShell(),
          connectionCapabilityResolver: opts?.connectionCapabilityResolver,
          resolveMcpCapabilities: opts?.resolveMcpCapabilities,
          memoryStore: o.getMemoryStore(),
          memoryItemStore: o.getMemoryItemStore(),
          data: data?.forAgent(inject.agent?.name ?? "agent"),
          ...(brain
            ? {
                brainService: brain.service,
                brainContext: await brain.resolveContext({
                  agentName: inject.agent?.name,
                }),
              }
            : {}),
          vaultStore: o.getVaultStore(),
          gatewayConfig: o.getGatewayConfig(),
          signal: hooks.signal,
          steering,
          inject,
          onEvent: hooks.onEvent,
        },
      );
      return { status: outcome.status, result: outcome.result };
    },
  }), opts?.apiKeys));
  app.route("/v1/chat", clientToolResolutionRoutes(() => ({
    sessionStore: o.getSessionStore(),
    runStore: o.getRunStore(),
    // A self-hosted process is its own trusted project/environment boundary.
    // The Session store still enforces the exact persisted agent and user.
    ...(opts?.apiKeys && opts.apiKeys.length > 0
      ? { authorizeClientToolSettlement: () => orchestrator.isInitialized }
      : {}),
  }), opts?.apiKeys));
  app.route("/v1/runs", runDeliveryRoutes(() => ({
    resolveRunDelivery: async (runId) => {
      const stores = o.getRunDeliveryStores();
      const bounds = await stores.eventStore.bounds(runId);
      if (bounds) knownDurableRuns.delete(runId);
      if (!knownDurableRuns.has(runId) && !bounds) {
        return null;
      }
      return {
        eventStore: stores.eventStore,
        cancellationStore: stores.cancellationStore,
        notifier: runEventNotifier,
      };
    },
  }), opts?.apiKeys));

  // ── Authenticated routes (require initialized orchestrator) ───────────

  const authed = new OpenAPIHono();
  if (opts?.apiKeys && opts.apiKeys.length > 0) {
    authed.use("*", authMiddleware(opts.apiKeys));
  }

  // Gate: orchestrator must be initialized for these routes
  authed.use("*", async (c, next) => {
    if (!orchestrator.isInitialized) {
      return c.json({ ok: false, error: "Polpo is not initialized. Complete setup first." }, 503);
    }
    return next();
  });

  // ── Dependency thunks ─────────────────────────────────────────────────
  //
  // Each route factory receives a thunk that returns its deps at request
  // time. In the single-orchestrator Node host every thunk delegates to the
  // same Orchestrator instance. Other hosts can supply different thunks that
  // read from database stores directly.

  const o = orchestrator; // short alias
  const customTools = (agentName?: string) => createLocalCustomToolRuntime({
    data: agentName ? data?.forAgent(agentName) : undefined,
    polpoDir: o.getPolpoDir(),
    workDir: o.getAgentWorkDir(),
    fs: o.getFs(),
    shell: o.getShell(),
    connectionCapabilityResolver: opts?.connectionCapabilityResolver,
  });

  if (data) authed.route("/data", dataRoutes(request => data.resolveService(request)));
  if (opts?.connectService) authed.route("/connect", connectRoutes(() => ({ connectService: opts.connectService })));
  authed.route("/hooks", runtimeHookRoutes(() => ({ store: runtimeHookStore })));

  authed.route("/tasks", taskRoutes(() => ({
    taskStore: o.getStore(),
    runStore: o.getRunStore(),
    logStore: o.getLogStore(),
    createTask: (opts: any) => o.engine.createTask(opts),
    deleteTask: (id: string) => o.engine.deleteTask(id),
    retryTask: (id: string) => o.engine.retryTask(id),
    killTask: (id: string) => o.engine.killTask(id),
    reassessTask: (id: string) => o.engine.reassessTask(id),
    forceFailTask: (id, expected) => o.engine.forceFailTask(id, expected),
    updateTaskDescription: (id: string, desc: string) => o.engine.updateTaskDescription(id, desc),
    updateTaskAssignment: (id: string, agent: string) => o.engine.updateTaskAssignment(id, agent),
    updateTaskExpectations: (id: string, exp: any) => o.engine.updateTaskExpectations(id, exp),
  })));

  authed.route("/missions", missionRoutes(() => ({
    listMissions: () => o.engine.listMissions(),
    getResumableMissions: () => o.engine.getResumableMissions(),
    getMission: (id: string) => o.engine.getMission(id),
    createMission: (opts: any) => o.engine.createMission(opts),
    updateMission: (id: string, updates: any) => o.engine.updateMission(id, updates),
    deleteMission: (id: string) => o.engine.deleteMission(id),
    executeMission: (id: string, options?: MissionExecutionOptions) => o.engine.executeMission(id, options),
    resumeMission: (id: string, opts?: any) => o.engine.resumeMission(id, opts),
    abortMission: (id: string, options?: MissionAbortOptions) => o.engine.abortMission(id, options),
    getActiveCheckpoints: () => o.engine.getActiveCheckpoints(),
    resumeCheckpointByMissionId: (mid: string, cp: string) => o.engine.resumeCheckpointByMissionId(mid, cp),
    getActiveDelays: () => o.engine.getActiveDelays(),
    addMissionTask: (mid: string, task: any) => o.engine.addMissionTask(mid, task),
    updateMissionTask: (mid: string, title: string, u: any) => o.engine.updateMissionTask(mid, title, u),
    removeMissionTask: (mid: string, title: string) => o.engine.removeMissionTask(mid, title),
    reorderMissionTasks: (mid: string, titles: string[]) => o.engine.reorderMissionTasks(mid, titles),
    addMissionCheckpoint: (mid: string, cp: any) => o.engine.addMissionCheckpoint(mid, cp),
    updateMissionCheckpoint: (mid: string, name: string, u: any) => o.engine.updateMissionCheckpoint(mid, name, u),
    removeMissionCheckpoint: (mid: string, name: string) => o.engine.removeMissionCheckpoint(mid, name),
    addMissionDelay: (mid: string, d: any) => o.engine.addMissionDelay(mid, d),
    updateMissionDelay: (mid: string, name: string, u: any) => o.engine.updateMissionDelay(mid, name, u),
    removeMissionDelay: (mid: string, name: string) => o.engine.removeMissionDelay(mid, name),
    addMissionQualityGate: (mid: string, g: any) => o.engine.addMissionQualityGate(mid, g),
    updateMissionQualityGate: (mid: string, name: string, u: any) => o.engine.updateMissionQualityGate(mid, name, u),
    removeMissionQualityGate: (mid: string, name: string) => o.engine.removeMissionQualityGate(mid, name),
    addMissionTeamMember: (mid: string, m: any) => o.engine.addMissionTeamMember(mid, m),
    updateMissionTeamMember: (mid: string, name: string, u: any) => o.engine.updateMissionTeamMember(mid, name, u),
    removeMissionTeamMember: (mid: string, name: string) => o.engine.removeMissionTeamMember(mid, name),
    updateMissionNotifications: (mid: string, n: any) => o.engine.updateMissionNotifications(mid, n),
  })));

  authed.route("/agents", agentRoutes(() => ({
    getAgents: () => o.engine.getAgents(),
    addAgent: (agent: any, teamName?: string) => o.engine.addAgent(agent, teamName),
    removeAgent: (name: string) => o.engine.removeAgent(name),
    updateAgent: (name: string, updates: any) => o.engine.updateAgent(name, updates),
    ...(isVersionedAgentStore(o.getAgentStore()) ? {
      getAgentSnapshot: (name: string) => o.engine.getAgentSnapshot(name),
      compareAndSwapAgent: (name: string, mutation: AgentMutation) => o.engine.compareAndSwapAgent(name, mutation),
    } : {}),
    getTeams: () => o.engine.getTeams(),
    getTeam: (name?: string) => o.engine.getTeam(name),
    addTeam: (team: any) => o.engine.addTeam(team),
    updateTeam: (name: string, updates: { description?: string }) => o.engine.updateTeam(name, updates),
    removeTeam: (name: string) => o.engine.removeTeam(name),
    renameTeam: (oldName: string, newName: string) => o.engine.renameTeam(oldName, newName),
    taskStore: o.getStore(),
    runStore: o.getRunStore(),
    polpoDir: o.getPolpoDir(),
    fs: o.getFs(),
  })));

  authed.route("/loops", loopRoutes(() => ({
    polpoDir: o.getPolpoDir(),
    fs: o.getFs(),
  })));

  authed.route("/events", eventRoutes(sseBridge));

  authed.route("/chat", chatRoutes(() => ({
    sessionStore: o.getSessionStore(),
    runStore: o.getRunStore(),
  })));

  if (opts?.channels?.management) {
    authed.route("/channels", conversationChannelRoutes(() => ({
      channelManagementService: opts.channels!.management!.service,
      resolveChannelManagementScope: opts.channels!.management!.resolveScope
        ?? (() => ({
          actorId: "local-user",
          actorType: "user" as const,
          projectId: "local",
        })),
    })));
  }

  authed.route("/runs", runSteeringRoutes(() => ({ steeringRegistry })));

  authed.route("/skills", skillRoutes(() => ({
    polpoDir: o.getPolpoDir(),
    workDir: o.getWorkDir(),
    getAgents: () => o.engine.getAgents(),
  })));

  authed.route("/approvals", approvalRoutes(() => ({
    getAllApprovals: (status?: string) => o.engine.getAllApprovals(status as any),
    getApprovalRequest: (id: string) => o.engine.getApprovalRequest(id),
    approveRequest: (id: string, resolvedBy?: string, note?: string) => o.engine.approveRequest(id, resolvedBy, note),
    rejectRequest: (id: string, feedback: string, resolvedBy?: string) => o.engine.rejectRequest(id, feedback, resolvedBy),
    canRejectRequest: (id: string) => o.engine.canRejectRequest(id),
  })));

  authed.route("/playbooks", playbookRoutes(() => ({
    playbookStore: o.getPlaybookStore(),
    createMission: (opts: any) => o.engine.createMission(opts),
    executeMission: (id: string, options?: MissionExecutionOptions) => o.engine.executeMission(id, options),
  })));
  // Backward-compat: keep /templates as alias
  authed.route("/templates", playbookRoutes(() => ({
    playbookStore: o.getPlaybookStore(),
    createMission: (opts: any) => o.engine.createMission(opts),
    executeMission: (id: string, options?: MissionExecutionOptions) => o.engine.executeMission(id, options),
  })));

  authed.route("/config", configRoutes(() => ({
    getConfig: () => o.getConfig(),
    reloadConfig: () => o.reloadConfig(),
    saveConfig: async (config: any) => {
      const { savePolpoConfig } = await import("../core/config.js");
      savePolpoConfig(o.getPolpoDir(), config);
    },
    getNotificationRouter: () => undefined,
  })));

  authed.route("/tools", customToolRoutes(() => {
    const runtime = customTools();
    return {
      store: runtime.store,
      deployer: runtime,
      runner: runtime,
      generateExample: (name: string) => runtime.generateExample(name),
    };
  }));

  if (brain) {
    authed.route("/brain", brainRoutes(async () => ({
      service: brain.service,
      context: await brain.resolveContext(),
    })));
  }

  authed.route("/schedules", scheduleRoutes(() => ({
    getScheduler: () => o.getScheduler(),
    getMission: (id: string) => o.engine.getMission(id),
    updateMission: (id: string, updates: any) => o.engine.updateMission(id, updates),
  })));

  authed.route("/watchers", watcherRoutes(() => ({
    getWatcherManager: () => o.getWatcherManager(),
    taskStore: o.getStore(),
  })));

  authed.route("/vault", vaultRoutes(() => ({
    vaultStore: o.getVaultStore(),
  })));

  authed.route("/", memoryItemRoutes((requestContext: any) => ({
    memoryItemStore: o.getMemoryItemStore(),
    resolveMemoryContext: (agentName: string) => {
      const externalUserId = requestContext.req.header("x-polpo-external-user-id")?.trim();
      const sessionId = requestContext.req.header("x-session-id")?.trim();
      const channelId = requestContext.req.header("x-polpo-channel-id")?.trim();
      return {
        namespace: o.getPolpoDir(),
        access: {
          projectId: o.getConfig()?.project,
          agentName,
          ...(externalUserId ? { externalUserId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(channelId ? { channelId } : {}),
        },
        surface: "api" as const,
      };
    },
  })));

  authed.route("/", memoryCandidateRoutes((requestContext: any) => ({
    memoryItemStore: o.getMemoryItemStore(),
    memoryExtractionStore: o.getMemoryExtractionStore(),
    resolveMemoryContext: (agentName: string) => {
      const externalUserId = requestContext.req.header("x-polpo-external-user-id")?.trim();
      const sessionId = requestContext.req.header("x-session-id")?.trim();
      const channelId = requestContext.req.header("x-polpo-channel-id")?.trim();
      return {
        namespace: o.getPolpoDir(),
        access: {
          projectId: o.getConfig()?.project,
          agentName,
          ...(externalUserId ? { externalUserId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(channelId ? { channelId } : {}),
        },
        surface: "api" as const,
      };
    },
    resolveMemoryReviewer: () => ({
      actor: "user" as const,
      actorId: requestContext.req.header("x-polpo-reviewer-id")?.trim()
        || "self-host-api-key",
    }),
  })));

  authed.route("/files", fileRoutes(() => ({
    publicFileBasePath: environment ? `/environments/${environment}/api/v1/files` : undefined,
    polpoDir: o.getPolpoDir(),
    workDir: o.getWorkDir(),
    agentWorkDir: o.getAgentWorkDir(),
    fs: o.getFs(),
    emit: (event: string, data: any) => o.emit(event as any, data),
  })));

  authed.route("/", stateRoutes(() => ({
    taskStore: o.getStore(),
    getConfig: () => o.getConfig(),
    hasMemory: () => o.engine.hasMemory(),
    getMemory: () => o.engine.getMemory(),
    saveMemory: (content: string) => o.engine.saveMemory(content),
    hasAgentMemory: (name: string) => o.engine.hasAgentMemory(name),
    getAgentMemory: (name: string) => o.engine.getAgentMemory(name),
    saveAgentMemory: (name: string, content: string) => o.engine.saveAgentMemory(name, content),
    getLogStore: () => o.getLogStore(),
  })));

  app.route("/api/v1", authed);

  // OpenAPI spec endpoint
  app.doc("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Polpo API",
      version: "1.0.0",
      description: "REST API for Polpo — an AI agent that manages teams of AI coding agents. Manage tasks, missions, agents, playbooks, skills, and approvals. For conversational interaction, use the OpenAI-compatible POST /v1/chat/completions endpoint.",
    },
    servers: [
      { url: "http://localhost:3000", description: "Local development" },
    ],
    security: [{ bearerAuth: [] }],
  });

  // Register security scheme for OpenAPI docs
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "API key passed as a Bearer token. Configure via the apiKeys field in project.json or the POLPO_API_KEY environment variable.",
  });

  // Prefixes are aliases into this already configured instance, never a choice
  // of database or credentials supplied by the caller. Re-enter the same app so
  // authentication, rate limits and route validation still run normally.
  for (const prefix of ["/environments/*", "/api/environments/*"]) {
    app.all(prefix, (c) => routeProjectEnvironment(c.req.raw, environment, request => app.fetch(request)));
  }

  return app;
}
