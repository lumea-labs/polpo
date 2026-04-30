# Polpo Runner Image

Canonical source of truth for the Polpo agent **sandbox runtime**.
This is the filesystem every Daytona sandbox boots into; it is also
what the local layer-2 test rig pulls.

It is **not** the Polpo HTTP server (that one is the Koyeb deploy,
no Docker needed there).

## What's inside

| Layer | Purpose |
|---|---|
| `node:22-slim` | Base |
| apt baseline | git/curl/ca-certs/fuse |
| apt Chromium libs | exhaustive list — every `.so` agent-browser's bundled Chrome links against |
| apt extras | poppler (pdf_read full text), python3 (edge-tts), fonts |
| `mountpoint-s3` | R2 FUSE mount (used by cloud sandbox pool) |
| `edge-tts` (pip) | free TTS fallback for `audio_speak` |
| `polpo-ai@VERSION` (npm) | the runtime + tool packages |
| `agent-browser` (npm global) + Chromium | browser_* tools + pdf_create driver |

No `ENTRYPOINT` / `CMD`. Daytona keeps the container alive externally
and runs every tool call via `docker exec`. The local test rig invokes
specific commands explicitly.

## Build

```bash
# From the cloud repo root:
docker build \
  --build-arg POLPO_VERSION=0.7.0 \
  -t ghcr.io/lumea-labs/polpo-runner:0.7.0 \
  -t ghcr.io/lumea-labs/polpo-runner:latest \
  docker/runner
```

`POLPO_VERSION` defaults to the value baked into the Dockerfile but
should be overridden at build time so each release of `polpo-ai` on
npm gets a matching image tag.

## Push (manual, until CI is wired)

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <username> --password-stdin
docker push ghcr.io/lumea-labs/polpo-runner:0.7.0
docker push ghcr.io/lumea-labs/polpo-runner:latest
```

## Use as Daytona snapshot base

Replace the imperative `Image.base("node:22-slim").runCommands(...)`
in `packages/server/scripts/create-snapshot-v6.ts` with:

```ts
const image = Image.fromImage(`ghcr.io/lumea-labs/polpo-runner:${POLPO_VERSION}`);
```

Snapshot creation collapses from ~5 min of apt+npm+download to ~30 s
of registry pull.

## Use locally for layer-2 tests

```bash
docker pull ghcr.io/lumea-labs/polpo-runner:0.7.0
docker run --rm \
  -v "$(pwd)/tests:/tests:ro" \
  ghcr.io/lumea-labs/polpo-runner:0.7.0 \
  node /tests/runtime-smoke.mjs
```

## Versioning

Tag matches the `polpo-ai` npm release. When OSS publishes a new
`v0.6.X`, this image is rebuilt with `--build-arg POLPO_VERSION=0.6.X`
and pushed as `:0.6.X` + `:latest`.

The `:latest` tag tracks the most recent build but should not be
used in production sandbox config — pin a specific version on
Daytona's `DAYTONA_SNAPSHOT_IMAGE` env var.
