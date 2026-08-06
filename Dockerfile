# syntax=docker/dockerfile:1.7

FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/client-sdk/package.json ./packages/client-sdk/package.json
COPY packages/connect/package.json ./packages/connect/package.json
COPY packages/connect-server/package.json ./packages/connect-server/package.json
COPY packages/connectors/package.json ./packages/connectors/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
COPY packages/drizzle/package.json ./packages/drizzle/package.json
COPY packages/file-stores/package.json ./packages/file-stores/package.json
COPY packages/llm/package.json ./packages/llm/package.json
COPY packages/node/package.json ./packages/node/package.json
COPY packages/react-sdk/package.json ./packages/react-sdk/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/tools/package.json ./packages/tools/package.json
COPY packages/vault-crypto/package.json ./packages/vault-crypto/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build --filter=@polpo-ai/node...
RUN pnpm run build:root
RUN pnpm --filter polpo-ai deploy --prod --legacy /opt/polpo \
    && mkdir -p /opt/polpo/bin \
    && cp /app/bin/polpo-server.mjs /opt/polpo/bin/polpo-server.mjs

FROM node:22-slim AS production
WORKDIR /app
COPY --from=build --chown=node:node /opt/polpo/ ./
COPY --chown=node:node docker/self-host/project.example/project.json /app/default-project.json
COPY docker/railway/runtime-entrypoint.sh /usr/local/bin/polpo-runtime-entrypoint
RUN chmod +x /usr/local/bin/polpo-runtime-entrypoint \
    && mkdir -p /app/workspace/.polpo \
    && chown -R node:node /app/workspace /app/default-project.json

ENV NODE_ENV=production
ENV PORT=3890
ENV HOST=0.0.0.0
ENV WORK_DIR=/app/workspace

EXPOSE 3890
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3890/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["polpo-runtime-entrypoint"]
CMD ["node", "bin/polpo-server.mjs"]
