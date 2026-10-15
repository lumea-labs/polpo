// Isolated subprocess fixture. No model calls or external provider credentials.
import { serve } from "@hono/node-server";
import { Orchestrator } from "../../../dist/core/orchestrator.js";
import { SSEBridge } from "../../../dist/server/sse-bridge.js";
import { createApp } from "../../../dist/server/app.js";

const [workDir, environment] = process.argv.slice(2);
const orchestrator = new Orchestrator({ workDir });
await orchestrator.initInteractive("environment-fixture", {
  name: "default", agents: [{ name: "support", role: "Test fixture" }],
});
const bridge = new SSEBridge(orchestrator);
bridge.start();
const app = createApp(orchestrator, bridge, {
  environment, apiKeys: [process.env.POLPO_TEST_API_KEY], workDir,
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) => {
  process.send?.({ port, pid: process.pid, environment });
});
process.once("SIGTERM", async () => {
  bridge.dispose();
  await orchestrator.gracefulStop();
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
