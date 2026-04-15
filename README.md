<p align="center">
  <img src="https://polpo.sh/logo.svg" alt="Polpo" width="80" />
</p>

<h1 align="center">Polpo</h1>

<p align="center">
  The open backend for AI agents.
  <br />
  Define your agent, deploy it, and get a fully working API with memory, tools, sandboxing, completions — out of the box.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/polpo-ai"><img src="https://img.shields.io/npm/v/polpo-ai.svg" alt="npm" /></a>
  <a href="https://github.com/lumea-labs/polpo/actions/workflows/ci.yml"><img src="https://github.com/lumea-labs/polpo/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/lumea-labs/polpo/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0" /></a>
  <a href="https://discord.gg/6JHCYQHr"><img src="https://img.shields.io/discord/placeholder?label=discord" alt="Discord" /></a>
</p>

<p align="center">
  <a href="https://docs.polpo.sh">Docs</a> &middot;
  <a href="https://polpo.sh">Website</a> &middot;
  <a href="https://discord.gg/6JHCYQHr">Discord</a> &middot;
  <a href="https://github.com/lumea-labs/polpo/issues">Issues</a>
</p>

---

## What is Polpo?

Polpo is an open-source runtime for building, running, and managing AI agents. It provides the infrastructure layer so you can focus on what your agents do, not how they run.

- **Tasks** -- assign work to agents, track status, retry on failure
- **Missions** -- multi-step workflows with checkpoints and delays
- **Tools** -- filesystem, browser, HTTP, email, PDF, Excel, audio, images, vault
- **Completions** -- OpenAI-compatible `/v1/chat/completions` endpoint
- **Real-time** -- SSE event streaming for live agent activity
- **Storage** -- file (default), SQLite, or PostgreSQL via Drizzle
- **Assessment** -- built-in quality scoring with LLM review
- **Skills** -- reusable agent capabilities loaded from YAML playbooks
- **CLI** -- `polpo create`, `polpo dev`, `polpo deploy`

## Quick start

```bash
npx polpo create
```

Scaffolds a new Polpo project (cloud + local) with an interactive wizard: pick an org, a project name, and a template. Link an existing project instead:

```bash
npx polpo link --project-id <id>
```

Install globally so `polpo` is on your PATH:

```bash
npm i -g @polpo-ai/cli
```

The local server starts on `http://localhost:3890`. Open the API at `/api/v1/health`.

### Programmatic usage

```typescript
import { Orchestrator } from "polpo-ai";

const orchestrator = new Orchestrator("./my-project");
await orchestrator.init();
await orchestrator.run();
```

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`polpo-ai`](.) | Main package -- CLI, server, orchestrator | [![npm](https://img.shields.io/npm/v/polpo-ai.svg)](https://www.npmjs.com/package/polpo-ai) |
| [`@polpo-ai/core`](packages/core) | Pure business logic, zero Node.js deps | [![npm](https://img.shields.io/npm/v/@polpo-ai/core.svg)](https://www.npmjs.com/package/@polpo-ai/core) |
| [`@polpo-ai/drizzle`](packages/drizzle) | Drizzle ORM stores (SQLite + PostgreSQL) | [![npm](https://img.shields.io/npm/v/@polpo-ai/drizzle.svg)](https://www.npmjs.com/package/@polpo-ai/drizzle) |
| [`@polpo-ai/server`](packages/server) | Hono route factories (shared between OSS and cloud) | [![npm](https://img.shields.io/npm/v/@polpo-ai/server.svg)](https://www.npmjs.com/package/@polpo-ai/server) |
| [`@polpo-ai/sdk`](packages/client-sdk) | TypeScript client SDK | [![npm](https://img.shields.io/npm/v/@polpo-ai/sdk.svg)](https://www.npmjs.com/package/@polpo-ai/sdk) |
| [`@polpo-ai/react`](packages/react-sdk) | React hooks (TanStack Query + SSE) | [![npm](https://img.shields.io/npm/v/@polpo-ai/react.svg)](https://www.npmjs.com/package/@polpo-ai/react) |
| [`@polpo-ai/tools`](packages/tools) | Extended tool definitions | [![npm](https://img.shields.io/npm/v/@polpo-ai/tools.svg)](https://www.npmjs.com/package/@polpo-ai/tools) |
| [`@polpo-ai/vault-crypto`](packages/vault-crypto) | Encryption for vault secrets | [![npm](https://img.shields.io/npm/v/@polpo-ai/vault-crypto.svg)](https://www.npmjs.com/package/@polpo-ai/vault-crypto) |

## Architecture

```
@polpo-ai/core          Pure logic, types, state machine, store interfaces
    |
@polpo-ai/drizzle       SQLite + PostgreSQL store implementations
    |
polpo-ai                Node.js shell: orchestrator, CLI, Hono server, tools
    |
@polpo-ai/server        Shared Hono route factories
@polpo-ai/sdk           Client SDK (fetch + SSE)
@polpo-ai/react         React hooks wrapping the SDK
```

Core contains zero Node.js dependencies. The shell (`polpo-ai`) wires concrete adapters: file stores, Drizzle stores, the LLM engine, and the HTTP server.

## Storage

Polpo supports three storage backends:

```jsonc
// .polpo/polpo.json
{
  "settings": {
    "storage": "file"      // default -- JSON/MD files in .polpo/
    // "storage": "sqlite"  // better-sqlite3 via Drizzle
    // "storage": "postgres" // PostgreSQL via Drizzle
  }
}
```

## Tools

Agents get access to tools based on their configuration. Built-in tool groups:

- **System** -- bash, read, write, edit, glob, grep, memory
- **Browser** -- Playwright-based web automation
- **HTTP** -- fetch, download
- **Email** -- SMTP send, IMAP read/search
- **PDF** -- read, create, merge
- **Excel** -- read/write spreadsheets
- **Docx** -- read Word documents
- **Audio** -- STT/TTS (Deepgram, OpenAI Whisper, ElevenLabs)
- **Image** -- generation and analysis
- **Vault** -- encrypted secret management

## SDK

### Client SDK

```typescript
import { PolpoClient } from "@polpo-ai/sdk";

const client = new PolpoClient({
  baseUrl: "http://localhost:3890",
});

const tasks = await client.getTasks();
const agents = await client.getAgents();
```

### React SDK

```tsx
import { PolpoProvider, useTasks, useAgents } from "@polpo-ai/react";

function App() {
  return (
    <PolpoProvider baseUrl="http://localhost:3890">
      <TaskList />
    </PolpoProvider>
  );
}

function TaskList() {
  const { tasks, createTask } = useTasks();
  // Real-time updates via SSE
  return <ul>{tasks.map(t => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

## Development

```bash
git clone https://github.com/lumea-labs/polpo.git
cd polpo
pnpm install
pnpm build
pnpm test
```

### Project structure

```
src/                    Main package source
  adapters/             Node.js runtime adapters (engine, filesystem, shell)
  assessment/           Quality scoring and LLM review
  cli/                  Commander CLI commands
  core/                 Orchestrator wiring + re-exports from @polpo-ai/core
  server/               Hono HTTP server + routes
  stores/               File-based store implementations
  tools/                Tool implementations (browser, email, PDF, etc.)
packages/
  core/                 @polpo-ai/core -- pure business logic
  drizzle/              @polpo-ai/drizzle -- SQL store implementations
  server/               @polpo-ai/server -- shared Hono route factories
  client-sdk/           @polpo-ai/sdk -- TypeScript client
  react-sdk/            @polpo-ai/react -- React hooks
  tools/                @polpo-ai/tools -- tool definitions
  vault-crypto/         @polpo-ai/vault-crypto -- encryption
examples/
  chat-app/             React chat app example
```

## Cloud

Polpo Cloud is the managed version at [polpo.sh](https://polpo.sh). It uses the same open-source core with managed infrastructure: Neon PostgreSQL, sandboxed execution, and a dashboard.

## License

[Apache 2.0](LICENSE) -- Lumea Labs
