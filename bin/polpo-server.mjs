#!/usr/bin/env node
/**
 * Polpo server entrypoint for the Docker image (ghcr.io/lumea-labs/polpo).
 *
 * Replaces the old `node dist/cli/index.js serve` ENTRYPOINT after the CLI
 * was extracted into the `@polpo-ai/cli` sub-package. The Docker image is
 * backend-only — it does not ship the CLI.
 *
 * Configuration is via environment variables:
 *   PORT              HTTP port             (default: 3890)
 *   HOST              Bind address          (default: 0.0.0.0)
 *   WORK_DIR          Project directory     (default: /app/workspace)
 *   POLPO_API_KEYS    Comma-separated keys  (optional — no auth if unset)
 *   CORS_ORIGINS      Comma-separated list  (optional)
 */
import { PolpoServer } from "../dist/server/index.js";

const port = Number(process.env.PORT ?? 3890);
const host = process.env.HOST ?? "0.0.0.0";
const workDir = process.env.WORK_DIR ?? "/app/workspace";
const apiKeys = process.env.POLPO_API_KEYS
  ? process.env.POLPO_API_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
  : undefined;
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : undefined;

const server = new PolpoServer({ port, host, workDir, apiKeys, corsOrigins });

try {
  await server.start();
} catch (err) {
  console.error("[polpo-server] Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
}
