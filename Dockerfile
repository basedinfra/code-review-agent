# syntax=docker/dockerfile:1

# BaseInfra BYO code-review agent runtime. A small Node.js process that joins the
# Headscale tailnet (via the host's tailscale), registers with the dashboard, and
# runs ephemeral PR-Agent containers per review through a Docker socket-proxy.
#
# Zero production npm dependencies — the agent runs on Node's standard library
# only — so this image bundles no third-party JS. That matters: the process can
# reach a privileged Docker proxy, so its supply-chain surface is kept minimal.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# No production deps today; --omit=dev keeps the image clean if any are added
# (dev tooling like prettier/eslint never ships). `npm ci` creates no
# node_modules with zero prod deps, so mkdir keeps the COPY below valid (and the
# dir is populated automatically once a production dependency is introduced).
RUN npm ci --omit=dev && mkdir -p node_modules

FROM node:${NODE_VERSION}-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as the base image's built-in non-root `node` user.
USER node

# Informational under `network_mode: host` (the agent binds its tailnet IP).
EXPOSE 7777

# /health is unauthenticated and cheap; it probes the same resolved bind address
# the server listens on (see src/config.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

ENTRYPOINT ["node", "src/index.js"]

LABEL org.opencontainers.image.source="https://github.com/basedinfra/code-review-agent"
LABEL org.opencontainers.image.description="BaseInfra BYO code-review agent runtime (Tailscale join + dashboard register + PR-Agent runner via docker-socket-proxy)"
LABEL org.opencontainers.image.licenses="MIT"
