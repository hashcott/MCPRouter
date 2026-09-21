# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json  packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json   packages/cli/package.json
COPY packages/web/package.json   packages/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# --legacy: pnpm 10 refuses a non-injected deploy otherwise, and injecting
# workspace packages would change how every dev install links them.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm deploy --legacy --filter @mcprouter/server --prod /out

FROM base AS runtime
# uv/uvx as static binaries for Python upstreams (P1), plus one managed CPython.
COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /uvx /usr/local/bin/
# The install below runs as root but the process runs as `node`. Without this
# the interpreter lands in /root/.local and is unreadable at runtime.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && uv python install 3.13
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/packages/web/dist ./packages/web/dist
ENV NODE_ENV=production WEB_ROOT=/app/packages/web/dist MIGRATIONS_DIR=/app/drizzle
USER node
EXPOSE 3000
# Deliberately `node`, not `pnpm start`: corepack re-download breaks non-root
# and egress-restricted runs (spec §12, mcphub entrypoint.sh:67-71).
CMD ["node", "dist/main.js"]
