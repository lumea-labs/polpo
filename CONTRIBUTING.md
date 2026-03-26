# Contributing to Polpo

Thanks for your interest in contributing. Here's how to get started.

## Development setup

```bash
git clone https://github.com/lumea-labs/polpo.git
cd polpo
pnpm install
pnpm build
pnpm test
```

Requires Node.js >= 20 and pnpm.

## Making changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm build` and `pnpm test` to verify
4. Open a PR against `main`

PRs are squash-merged — write a clear PR title, it becomes the commit message.

## Project structure

```
src/                    Main package (orchestrator, CLI, server, tools)
packages/
  core/                 Pure business logic (zero Node.js deps)
  drizzle/              SQL store implementations (SQLite + PostgreSQL)
  server/               Shared Hono route factories
  client-sdk/           TypeScript client SDK
  react-sdk/            React hooks
  tools/                Tool definitions
  vault-crypto/         Encryption utilities
```

## Build order

Packages have build dependencies:

```
@polpo-ai/core → @polpo-ai/vault-crypto → @polpo-ai/drizzle → @polpo-ai/tools → @polpo-ai/server → root tsc → @polpo-ai/sdk → @polpo-ai/react
```

`pnpm build` handles this automatically.

## Tests

```bash
pnpm test              # watch mode
pnpm test run          # single run
```

Tests run without any external dependencies. PostgreSQL tests skip automatically if no database is available.

To run PostgreSQL tests locally:

```bash
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=polpo_test postgres:16
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/polpo_test pnpm test run
```

## Code style

- TypeScript strict mode
- No lint config — `tsc` is the linter
- Keep changes minimal and focused
- Don't add features beyond what's requested in the issue

## Reporting bugs

Use [GitHub Issues](https://github.com/lumea-labs/polpo/issues) with the bug report template.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
