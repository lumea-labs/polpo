# syntax=docker/dockerfile:1.7

FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app
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
RUN --mount=type=cache,id=pnpm-dashboard,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build --filter=@polpo-ai/dashboard-app...

FROM node:22-slim AS production
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/dashboard/.next/standalone/ ./
COPY --from=build --chown=node:node /app/apps/dashboard/.next/static/ ./apps/dashboard/.next/static/

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/dashboard/server.js"]
