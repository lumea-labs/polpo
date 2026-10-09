import {
  createRemoteDataClient,
  createDataCapability,
  DataError,
  DataGrantSchema,
  DataService,
  parseData,
  type DataClient,
} from "@polpo-ai/core/data";
import { z } from "zod";
import type {
  PostgresDataProvider,
  DataSqlExecutor,
} from "@polpo-ai/drizzle/data";

export interface NodeDataRuntime {
  resolveService(request: Request): Promise<DataService>;
  forAgent(name: string): DataClient;
  close(): Promise<void>;
}
export function createNodeDataRuntime(options: {
  databaseUrl: string;
  scope: string;
  /** Trusted host configuration, not agent-authored tool arguments. Re-read on every call. */
  resolveAgentGrants: (name: string) => unknown | Promise<unknown>;
}): NodeDataRuntime {
  let initialized: Promise<PostgresDataProvider> | undefined;
  let close = async () => {};
  const provider = () =>
    (initialized ??= (async () => {
      const [{ default: postgres }, { PostgresDataProvider }] =
        await Promise.all([
          import("postgres"),
          import("@polpo-ai/drizzle/data"),
        ]);
      const sql = postgres(options.databaseUrl, {
        max: 3,
        idle_timeout: 20,
        connect_timeout: 10,
      });
      close = () => sql.end({ timeout: 5 });
      const executor = (
        client: Pick<typeof sql, "unsafe">,
      ): DataSqlExecutor => ({
        query: async (text, values = []) => [
          ...(await client.unsafe(text, values as any[])),
        ],
      });
      const result = new PostgresDataProvider({
        ...executor(sql),
        transaction: (fn) => sql.begin(async (tx) => fn(executor(tx))) as any,
      });
      try {
        await result.initialize();
        return result;
      } catch (error) {
        await close();
        throw error;
      }
    })().catch((error) => {
      initialized = undefined;
      throw error;
    }));
  return {
    // The Node app mounts this behind its existing administrator authentication.
    resolveService: async () =>
      new DataService(await provider(), {
        scope: options.scope,
        principalId: "local-admin",
        grants: [{ resource: "*", actions: ["manage"] }],
      }),
    forAgent: (name) =>
      createDataCapability(async () => {
        const grants = parseData(
          z.array(DataGrantSchema),
          await options.resolveAgentGrants(name),
        );
        if (!grants.length)
          throw new DataError(
            "data_forbidden",
            "No Data resources are granted to this agent",
          );
        return new DataService(await provider(), {
          scope: options.scope,
          principalId: `agent:${name}`,
          grants,
        });
      }),
    close: () => close(),
  };
}

const environmentRuntimes = new Map<string, NodeDataRuntime>();
/** Explicit application database opt-in. Runtime storage configuration is unrelated. */
export function localDataRuntime(scope: string): NodeDataRuntime | undefined {
  const databaseUrl = process.env.POLPO_DATA_DATABASE_URL;
  if (
    !databaseUrl ||
    ["off", "false", "0"].includes(process.env.POLPO_DATA_ENABLED ?? "")
  )
    return undefined;
  const key = JSON.stringify([scope, databaseUrl]);
  let runtime = environmentRuntimes.get(key);
  if (!runtime) {
    runtime = createNodeDataRuntime({
      databaseUrl,
      scope,
      resolveAgentGrants: (name) => {
        let grants: unknown;
        try {
          grants = JSON.parse(process.env.POLPO_DATA_AGENT_GRANTS ?? "{}");
        } catch {
          throw new DataError(
            "data_invalid",
            "Invalid host Data grants configuration",
          );
        }
        if (!grants || typeof grants !== "object" || Array.isArray(grants))
          throw new DataError(
            "data_invalid",
            "Invalid host Data grants configuration",
          );
        return Object.hasOwn(grants, name)
          ? (grants as Record<string, unknown>)[name]
          : [];
      },
    });
    environmentRuntimes.set(key, runtime);
  }
  return runtime;
}

let runnerCapability: { agentName: string; client: DataClient } | undefined;
/** Consume a host-injected, expiring capability without retaining it in process.env. */
export function runnerDataClient(
  scope: string,
  agentName: string,
): DataClient | undefined {
  const encoded = process.env.POLPO_DATA_CAPABILITY;
  if (encoded) {
    delete process.env.POLPO_DATA_CAPABILITY;
    try {
      if (encoded.length > 8192) throw new Error("Oversized capability");
      const binding = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
      if (
        typeof binding.agentName !== "string" ||
        typeof binding.url !== "string" ||
        typeof binding.token !== "string" ||
        typeof binding.sandboxId !== "string"
      )
        throw new Error("Invalid binding");
      runnerCapability = {
        agentName: binding.agentName,
        client: createRemoteDataClient({
          url: binding.url,
          token: binding.token,
          headers: { "x-polpo-sandbox-id": binding.sandboxId },
        }),
      };
    } catch {
      throw new DataError("data_invalid", "Invalid host Data capability");
    }
  }
  if (runnerCapability) {
    if (runnerCapability.agentName !== agentName)
      throw new DataError(
        "data_forbidden",
        "Data capability belongs to a different agent",
      );
    return runnerCapability.client;
  }
  return localDataRuntime(scope)?.forAgent(agentName);
}
