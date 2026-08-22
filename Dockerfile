# RemoteAgent — one image, five entry points (RA-027-WU-09).
#
# ONE IMAGE, NOT FIVE. `infra/cdk` gives every service the same
# `ContainerImage.fromEcrRepository(repository, imageTag)` and differentiates them by
# `command` — so `dist/worker.js`, `dist/executor.js`, `dist/discord.js`, `dist/ingress.js`
# and `dist/health.js` must all resolve inside ONE image. Five images would need five tags in
# the release manifest and five things to keep in step; one image with five commands has a
# single version.
#
# THE ENTRY POINTS LIVE IN DIFFERENT WORKSPACE PACKAGES, each compiling to its own `dist/`,
# and `apps -> apps` imports are forbidden by the eslint boundary. So the collection happens
# HERE, at the image layer, which is the one place allowed to know about all of them. That is
# why the final stage copies each app's `dist` into a single `/app/dist`.
#
# NOT BUILT IN THIS TASK. Docker's client and engine are version-mismatched on the
# development machine (`AGENTS.md`), so this file is written and reviewed but never built —
# stated here rather than implied, because a Dockerfile that has never been built is a
# hypothesis. `test/processes/entrypoints.test.ts` verifies the NAMES it must produce, which
# is the part that can be checked without Docker.

# --- build ------------------------------------------------------------------------------
FROM node:24.19.0-slim AS build
WORKDIR /repo

# corepack pins pnpm to the version in `package.json`, so the image build resolves the same
# dependency tree the lockfile describes rather than whatever pnpm is newest.
RUN corepack enable

# Manifests and the lockfile first, so a source-only change does not re-resolve dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY infra ./infra

# `--frozen-lockfile` so a build can never silently resolve a different tree than the one the
# SBOM and the dependency audit describe. A build that updates the lockfile is a build whose
# supply chain nobody reviewed.
RUN pnpm install --frozen-lockfile --ignore-scripts

RUN pnpm run build

# --- runtime ----------------------------------------------------------------------------
FROM node:24.19.0-slim AS runtime
WORKDIR /app

# Non-root. The worker executes repository code and commands under a network-DENY profile;
# running that as root would make a sandbox escape a root escape.
RUN useradd --create-home --shell /usr/sbin/nologin remoteagent
ENV NODE_ENV=production

# Production dependencies only: no compiler, no test framework, nothing that only the build
# needed. Every omitted package is one fewer thing in the SBOM of what actually ships.
COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps ./apps
RUN corepack enable && pnpm install --frozen-lockfile --prod --ignore-scripts

# The collection step described above: every entry point into one `dist/`.
RUN mkdir -p /app/dist \
 && cp /app/apps/agent-worker/dist/worker.js       /app/dist/worker.js \
 && cp /app/apps/agent-worker/dist/health.js       /app/dist/health.js \
 && cp /app/apps/action-executor/dist/executor.js  /app/dist/executor.js \
 && cp /app/apps/ingress-api/dist/ingress.js       /app/dist/ingress.js \
 && cp /app/apps/discord-bot/dist/discord.js       /app/dist/discord.js \
 && cp /app/apps/scheduler/dist/scheduler.js       /app/dist/scheduler.js \
 && chown -R remoteagent:remoteagent /app

USER remoteagent

# 8080 for health on the workers, and for webhooks on the ingress (which puts its own health
# on 8081 — see `ingressConfigFromEnv`, and the note there on why they must differ).
EXPOSE 8080 8081

# No default CMD. Deliberate: an image that defaults to one process would let a
# misconfigured task definition silently run the wrong one — most dangerously the executor,
# which is the process that performs external writes. `infra/cdk` always states the command.
