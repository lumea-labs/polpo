# Polpo Runner image — canonical source of truth.
#
# Translates the declarative `create-snapshot-v6.ts` (Daytona Image
# SDK) into a real Dockerfile so we have a single artifact we can:
#   - build & push to GHCR per release
#   - use as base for the Daytona snapshot (Image.fromImage)
#   - pull locally for the layer-2 test rig
#   - hand to a future provider (Vercel Sandbox / Modal / Fly Machines)
#
# This image is the *runtime* sandbox where agent tools execute. It
# is NOT the Polpo HTTP server — that one stays as the Koyeb deploy
# (Node, no Docker needed there). Daytona pulls this image to spin
# sandboxes; tools run via `docker exec` against an idle container,
# so there's no ENTRYPOINT / CMD that auto-starts anything.

FROM node:22-slim

ARG POLPO_VERSION=0.7.0
LABEL org.opencontainers.image.source="https://github.com/Lumea-Technologies/polpo-cloud" \
      org.opencontainers.image.title="polpo-runner" \
      org.opencontainers.image.description="Polpo agent sandbox runtime — Chromium, agent-browser, edge-tts, polpo-ai" \
      org.opencontainers.image.version="${POLPO_VERSION}"

# ─────────────────────────────────────────────────────────────
# 1. System deps
# ─────────────────────────────────────────────────────────────
# Baseline tools + every shared library agent-browser's bundled
# Chrome links against + poppler for pdf_read full-text extraction
# + python for edge-tts + a few font packages so PDF/browser
# rendering doesn't fall back to "Tofu" boxes for non-ASCII.
#
# The Chromium list MUST be exhaustive: `agent-browser install
# --with-deps` shells to `sudo apt-get`, which doesn't exist in
# node:22-slim, so the wrapped Playwright installer silently
# no-ops. If a lib is missing here, Chrome dies at navigate-time
# with `error while loading shared libraries: libXfoo.so.N` and
# the sandbox is broken. Verified empirically inside a live v6
# sandbox; this exact list is what made navigate + screenshot
# work end-to-end.
RUN apt-get update && apt-get install -y --no-install-recommends \
        # Baseline
        git curl ca-certificates fuse libfuse2 \
        # PDF text extraction
        poppler-utils \
        # edge-tts runtime
        python3 python3-pip \
        # Chromium runtime libs (exhaustive — see comment above)
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
        libxss1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 \
        libcairo2 libwayland-client0 libxshmfence1 \
        libxfixes3 libxext6 libxcursor1 libxi6 libxtst6 \
        libxrender1 libxinerama1 libdbus-1-3 libatspi2.0-0 \
        # Fonts so Chromium renders non-ASCII / emoji properly
        fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────
# 2. mountpoint-s3 (R2 / S3 FUSE mount)
# ─────────────────────────────────────────────────────────────
# The cloud sandbox pool mounts each project's R2 bucket at
# /home/daytona/project via mountpoint-s3 at sandbox-acquire time.
# The binary is harmless in a non-cloud context (self-hosters or
# local test rigs simply don't invoke it) but cheap to keep here
# for parity with the production image.
RUN curl -sSL https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.deb \
        -o /tmp/mount-s3.deb \
    && dpkg -i /tmp/mount-s3.deb \
    && rm /tmp/mount-s3.deb

# ─────────────────────────────────────────────────────────────
# 3. Edge TTS (free voice fallback for audio_speak)
# ─────────────────────────────────────────────────────────────
# --break-system-packages because slim is PEP-668-locked. We are
# intentionally installing a single CLI tool globally.
RUN pip install --break-system-packages edge-tts

# ─────────────────────────────────────────────────────────────
# 4. Polpo runtime (npm packages)
# ─────────────────────────────────────────────────────────────
# /home/daytona/project is the future mountpoint-s3 attach point,
# so it must stay empty in the image. node_modules live one level
# up at /home/daytona/node_modules. `--include=optional` makes
# @polpo-ai/tools peer deps explicit (pdf-lib, exceljs, docx,
# mammoth, nodemailer, imapflow, playwright-core, execa) regardless
# of the consumer's npm config.
WORKDIR /home/daytona
RUN npm init -y \
    && npm install --include=optional \
        polpo-ai@${POLPO_VERSION} \
        @polpo-ai/core@${POLPO_VERSION} \
        @polpo-ai/drizzle@${POLPO_VERSION} \
        @polpo-ai/tools@${POLPO_VERSION} \
        postgres drizzle-orm

# ─────────────────────────────────────────────────────────────
# 5. Browser stack (agent-browser CLI + Chromium binary)
# ─────────────────────────────────────────────────────────────
# `install` (without --with-deps) just downloads the bundled
# Chromium binary into ~/.agent-browser/browsers. We deliberately
# do NOT use --with-deps: it shells to `sudo apt-get`, sudo isn't
# available in node:22-slim, so it would silently do nothing
# while making the build look successful. All the shared libs
# Chrome needs are installed in step 1.
RUN npm install -g agent-browser && agent-browser install

# No ENTRYPOINT / CMD on purpose. Daytona keeps the container alive
# externally and runs every tool call via `docker exec`. The local
# test rig invokes specific commands explicitly (`docker run …
# node /tests/runtime-smoke.mjs`).
