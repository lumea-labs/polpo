#!/usr/bin/env node
/**
 * bench/lib/server-host.mjs — child-process host for a PolpoServer.
 *
 * The crash_resume scenario needs a Polpo server it can KILL -9 (a graceful
 * stop is useless: gracefulStop() SIGTERMs runners, marks runs killed and
 * DELETES the run records — no checkpoint survives it). PolpoServer also
 * traps SIGTERM/SIGINT into a graceful stop, so the only honest "machine
 * died" simulation is SIGKILL on a dedicated child process.
 *
 * Usage (spawned by lib/crash-resume.mjs, not by hand):
 *   node bench/lib/server-host.mjs --entry <dist/server/index.js> \
 *        --port <port> --workdir <projectDir>
 *
 * Readiness is probed by the parent over HTTP (/api/v1/health) — stdout is
 * informational only.
 */

import { pathToFileURL } from "node:url";

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const entry = getArg("entry", null);
const port = Number(getArg("port", 8379));
const workDir = getArg("workdir", null);

if (!entry || !workDir) {
  console.error("[server-host] usage: node server-host.mjs --entry <server.js> --port <port> --workdir <dir>");
  process.exit(2);
}

const { PolpoServer } = await import(pathToFileURL(entry).href);
const server = new PolpoServer({ port, host: "127.0.0.1", workDir });
await server.start();
console.log(`[server-host] up on http://127.0.0.1:${port} (pid ${process.pid})`);
