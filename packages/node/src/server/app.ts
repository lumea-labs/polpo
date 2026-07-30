import { getPolpoDir } from "../core/constants.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { cors } from "hono/cors";
import { join } from "node:path";
import { projectLoopConfigSchema } from "@polpo-ai/core/schemas";
import { resolveConfiguredModelSelection } from "@polpo-ai/core";
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
  taskRoutes,
  missionRoutes,
  chatRoutes,
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
} from "@polpo-ai/server";
// Node.js-only routes (stay in src/server/routes/)
import { publicConfigRoutes } from "./routes/config.js";
import { filesystemRoutes } from "./routes/filesystem.js";
import { providerRoutes } from "./routes/providers.js";
import { skillRoutes } from "./routes/skills.js";
import { fileRoutes } from "./routes/files.js";
import { createLocalCustomToolRuntime } from "../custom-tools/runtime.js";
import { resolveNodeModelOptions } from "../llm/model-runtime-options.js";
import {
  createConfiguredRunToolMiddleware,
  type RunToolMiddleware,
} from "@polpo-ai/core/guardrails";

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

export interface AppOptions {
  apiKeys?: string[];
  corsOrigins?: string[];
  workDir?: string;
  onInitialize?: (workDir: string) => Promise<void>;
  /** Optional process-local override for completion tool guardrails. */
  runToolMiddleware?: RunToolMiddleware;
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
  const app = new OpenAPIHono();

  // Global middleware
  app.use("*", errorMiddleware());
  // Rate limit API routes only (not static assets)
  app.use("/api/*", rateLimitMiddleware());
  app.use("/v1/*", rateLimitMiddleware());

  const corsExposeHeaders = ["x-session-id"];
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

  // ── Public routes (no auth) ───────────────────────────────────────────

  app.route("/api/v1/health", healthRoutes(runtimeVersion));

  // Config status + initialize — always available so setup wizard works
  if (opts?.workDir) {
    app.route("/api/v1/config", publicConfigRoutes(orchestrator, opts.workDir, opts.onInitialize));
  }

  // Filesystem browsing — always available (used by setup wizard path picker)
  app.route("/api/v1/filesystem", filesystemRoutes());

  // Provider management — always available (API key CRUD, model listing)
  if (opts?.workDir) {
    const polpoDir = getPolpoDir(opts.workDir);
    app.route("/api/v1/providers", providerRoutes(polpoDir));
  }

  // OpenAI-compatible chat completions
  app.route("/v1/chat/completions", completionRoutes(() => ({
    getAgents: () => o.engine.getAgents(),
    getConfig: () => o.getConfig(),
    getMemoryStore: () => o.getMemoryStore(),
    getSessionStore: () => o.getSessionStore(),
    getStore: () => o.getStore(),
    runToolMiddleware: opts?.runToolMiddleware
      ?? createConfiguredRunToolMiddleware(o.getConfig()?.settings?.guardrails),
    emit: (event: string, data: any) => o.emit(event as any, data),
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
    buildAgentPrompt: (agentConfig: any) => {
      return buildSystemPrompt(agentConfig, o.getAgentWorkDir(), o.getPolpoDir(), undefined, agentConfig.allowedPaths);
    },
    resolveAgentTools: async (agentConfig: any) => {
      const { createSystemTools, createMemoryTools, resolveAgentMcpTools, expandToolWildcards, TOOL_CATALOG } = await import("@polpo-ai/tools");
      const { resolveAgentVault } = await import("../vault/index.js");
      const { nanoid } = await import("nanoid");
      const vaultEntries = await o.getVaultStore()?.getAllForAgent(agentConfig.name);
      const vault = resolveAgentVault(vaultEntries);
      const tools: any[] = createSystemTools(o.getAgentWorkDir(), agentConfig.allowedTools, agentConfig.allowedPaths, undefined, vault, o.getFs(), o.getShell());
      tools.push(...await customTools().loadAssigned(agentConfig.allowedTools));
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
      // External MCP-server tools (stdio / SSE / HTTP) declared on the agent.
      // The connections are opened once per request; `dispose` is wired into
      // the `cleanup` callback so transports close as soon as the agent's
      // turn finishes — no orphaned file descriptors / keep-alives.
      const mcp = await resolveAgentMcpTools(agentConfig.name, agentConfig.mcpServers, vault);
      tools.push(...mcp.tools);
      const toolMap = new Map(tools.map((t: any) => [t.name, t]));
      const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const tool = toolMap.get(name);
        if (!tool) return `Error: Unknown tool "${name}"`;
        try {
          const result = await tool.execute(nanoid(), args as any);
          return result.content.map((c: any) => c.text ?? "").join("");
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      };
      return { tools, executor, cleanup: mcp.dispose };
    },
    getProjectLoop: (name: string) => o.getProjectLoop(name),
    // Run chat completions through the shared executeRun lifecycle +
    // loop-engine. Injects the route's
    // already-resolved model/prompt/tools/messages so the engine runs a chat
    // turn-loop at parity with the inline handler; keeps the run ephemeral.
    runChatViaRun: async (inject: any, hooks: { onEvent: (e: Record<string, unknown>) => void; signal?: AbortSignal }) => {
      const { executeRun } = await import("../core/run-lifecycle.js");
      const { EphemeralRunStore } = await import("./ephemeral-run-store.js");
      const { nanoid } = await import("nanoid");
      const runId = `chat-${nanoid()}`;
      const task: any = {
        id: runId, title: inject.title ?? "chat", description: "",
        assignTo: inject.agent?.name ?? "agent", dependsOn: [], status: "pending",
        expectations: [], metrics: [], retries: 0, maxRetries: 0,
      };
      const outcome = await executeRun(
        {
          runId, taskId: runId, agent: inject.agent, task,
          polpoDir: o.getPolpoDir(), cwd: o.getAgentWorkDir(),
          outputDir: join(o.getPolpoDir(), "output", runId),
        } as any,
        {
          runStore: new EphemeralRunStore(),
          pid: -1,
          configPath: `memory://${runId}`,
          fs: o.getFs(),
          shell: o.getShell(),
          memoryStore: o.getMemoryStore(),
          vaultStore: o.getVaultStore(),
          gatewayConfig: o.getGatewayConfig(),
          signal: hooks.signal,
          inject,
          onEvent: hooks.onEvent,
        },
      );
      return { status: outcome.status, result: outcome.result };
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
  const customTools = () => createLocalCustomToolRuntime({
    polpoDir: o.getPolpoDir(),
    workDir: o.getAgentWorkDir(),
    fs: o.getFs(),
    shell: o.getShell(),
  });

  authed.route("/tasks", taskRoutes(() => ({
    taskStore: o.getStore(),
    runStore: o.getRunStore(),
    logStore: o.getLogStore(),
    createTask: (opts: any) => o.engine.createTask(opts),
    deleteTask: (id: string) => o.engine.deleteTask(id),
    retryTask: (id: string) => o.engine.retryTask(id),
    killTask: (id: string) => o.engine.killTask(id),
    reassessTask: (id: string) => o.engine.reassessTask(id),
    forceFailTask: (id: string) => o.engine.forceFailTask(id),
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
    executeMission: (id: string) => o.engine.executeMission(id),
    resumeMission: (id: string, opts?: any) => o.engine.resumeMission(id, opts),
    abortGroup: (group: string) => o.engine.abortGroup(group),
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
    getTeams: () => o.engine.getTeams(),
    getTeam: (name?: string) => o.engine.getTeam(name),
    addTeam: (team: any) => o.engine.addTeam(team),
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
  })));

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
    executeMission: (id: string) => o.engine.executeMission(id),
  })));
  // Backward-compat: keep /templates as alias
  authed.route("/templates", playbookRoutes(() => ({
    playbookStore: o.getPlaybookStore(),
    createMission: (opts: any) => o.engine.createMission(opts),
    executeMission: (id: string) => o.engine.executeMission(id),
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

  authed.route("/files", fileRoutes(() => ({
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
    description: "API key passed as a Bearer token. Configure via the apiKeys field in polpo.json or the POLPO_API_KEY environment variable.",
  });

  return app;
}
