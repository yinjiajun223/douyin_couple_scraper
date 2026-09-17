# syntax=docker/dockerfile:1.7
FROM node:24.18.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/collector/package.json apps/collector/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/platform-douyin/package.json packages/platform-douyin/package.json
RUN npm ci
COPY tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.18.1-bookworm-slim AS node-runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
RUN rm -rf ./node_modules/playwright ./node_modules/playwright-core
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build --chown=node:node /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /app/packages/domain/migrations ./packages/domain/migrations
COPY --from=build --chown=node:node /app/packages/platform-douyin/package.json ./packages/platform-douyin/package.json
COPY --from=build --chown=node:node /app/packages/platform-douyin/dist ./packages/platform-douyin/dist
USER node

FROM node-runtime AS api
ARG RELEASE_ID=development
LABEL org.opencontainers.image.revision=$RELEASE_ID
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
EXPOSE 3000
CMD ["node", "--enable-source-maps", "apps/api/dist/server.js"]

FROM node-runtime AS worker
ARG RELEASE_ID=development
LABEL org.opencontainers.image.revision=$RELEASE_ID
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
CMD ["node", "--enable-source-maps", "apps/worker/dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
ARG RELEASE_ID=development
LABEL org.opencontainers.image.revision=$RELEASE_ID
USER root
RUN apk upgrade --no-cache
COPY infra/docker/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /app/apps/web/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
