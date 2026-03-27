FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/vault-crypto/package.json packages/vault-crypto/
COPY packages/drizzle/package.json packages/drizzle/
COPY packages/server/package.json packages/server/
COPY packages/tools/package.json packages/tools/
COPY packages/client-sdk/package.json packages/client-sdk/
COPY packages/react-sdk/package.json packages/react-sdk/
RUN pnpm install --frozen-lockfile

# Build
FROM deps AS build
COPY . .
RUN pnpm build

# Production
FROM node:22-slim AS production
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/drizzle/node_modules ./packages/drizzle/node_modules
COPY --from=deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=deps /app/packages/tools/node_modules ./packages/tools/node_modules
COPY --from=deps /app/packages/vault-crypto/node_modules ./packages/vault-crypto/node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/vault-crypto/dist ./packages/vault-crypto/dist
COPY --from=build /app/packages/drizzle/dist ./packages/drizzle/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/tools/dist ./packages/tools/dist
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/vault-crypto/package.json ./packages/vault-crypto/
COPY --from=build /app/packages/drizzle/package.json ./packages/drizzle/
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/tools/package.json ./packages/tools/
COPY --from=build /app/playbooks ./playbooks

ENV NODE_ENV=production
ENV PORT=3890

EXPOSE 3890

# Default: start the server. Override with any polpo command.
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve", "--host", "0.0.0.0"]
