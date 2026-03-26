# Polpo — Agent Guidelines

## Workflow

- Never push directly to `main` — branch protection is enabled
- Create a branch, open PR against `main`, CI must pass, squash merge
- PR title becomes the commit message on main — write it clearly
- Branch auto-deleted after merge

## Release

1. Bump version in all 8 `package.json` files (versions stay in sync)
2. PR → merge to main
3. `git tag v{version} && git push --tags`
4. Release workflow runs automatically: test → npm publish → GitHub Release
5. Delete old tag first if re-tagging: `git tag -d v0.x.0 && git push origin :refs/tags/v0.x.0`

## Build

Packages must build in this order (dependencies):

```
core → vault-crypto → drizzle → tools → server → root tsc → sdk → react
```

`pnpm build` handles this. The `typecheck` script also needs tools and server built before `tsc --noEmit`.

## Testing

```bash
pnpm test run          # run all tests
```

- No secrets needed — all tests run locally
- Drizzle PG tests skip without `TEST_DATABASE_URL` (CI provides a Postgres container)
- No cloud E2E in this repo — those live in the cloud repo
- Always run tests before opening a PR

## Rules

- `workspace:*` for internal dependencies (pnpm converts to `^version` on publish)
- File stores are actively used — never delete them
- No linter config — `tsc` is the linter
- Don't add notifications, peers, or WhatsApp — these were intentionally removed
