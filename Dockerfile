# syntax=docker/dockerfile:1
# Local builds on Apple Silicon need `--platform linux/amd64`: pnpm-workspace.yaml strips every native
# binary except linux-x64 (rollup, esbuild, lightningcss, tailwind oxide), so linux/arm64 cannot build.
# Render deploys this image as the single `requisor-api` web service (see render.yaml): the Express
# API plus the static site and game previews it serves in production.
#
# Why Docker: Render's native Node build environment (Sept 2026 image) reinstalls pnpm into the
# read-only /usr tree before the build command runs and fails with EROFS no matter what the repo
# says, so the build happens here, in an image we control.

# ---- build: full workspace install, then site + games + API bundle -------------------------------
FROM node:24-slim AS build
WORKDIR /app

# The same pnpm that wrote pnpm-lock.yaml. /usr/local is writable inside our own image.
RUN npm install -g pnpm@11.5.3

# Lockfile-only fetch first, so the (large) dependency layer survives source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

COPY . .
# NODE_ENV must NOT be production here: pnpm would skip the devDependencies (vite, esbuild, ...)
# that the builds need. The build scripts export NODE_ENV=production themselves.
RUN pnpm install --frozen-lockfile --prefer-offline
# Site first, then every game staged into the site's dist (order is load-bearing, see
# scripts/build-site.mjs), then the API bundle.
RUN pnpm run build:web && pnpm run build:api
# The API bundle links @electric-sql/pglite at startup: drizzle-orm's PGlite driver (inlined by
# esbuild) imports it statically, and build.mjs keeps the package external because it loads WASM
# relative to its own location. Production never uses PGlite, but ESM linking is eager, so the
# runtime image needs this one package (no dependencies of its own). pnpm's node_modules entry is
# a symlink into the store, hence -L.
RUN mkdir -p /runtime-modules/@electric-sql && cp -RL artifacts/api-server/node_modules/@electric-sql/pglite /runtime-modules/@electric-sql/pglite

# ---- runtime: the two build outputs plus the single package the bundle links at startup --------
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# The API bundle is self-contained (esbuild, artifacts/api-server/build.mjs) and finds the site
# build relative to its own location, so the repo layout is preserved.
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/citrus-landing/dist/public ./artifacts/citrus-landing/dist/public
COPY --from=build /runtime-modules ./artifacts/api-server/node_modules
USER node
EXPOSE 10000
# Render injects PORT (10000); the server refuses to start without it.
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
