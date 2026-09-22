# Deployment

The site is split across two hosts:

| Piece | Host | What it serves |
| --- | --- | --- |
| `citrus-landing` + all 5 game builds | **Vercel** (static CDN) | The marketing site, the customizer, and `/game-previews/<slug>/` |
| `@workspace/api-server` | **Railway** | Everything under `/api` |
| Postgres | **Railway** (or any managed Postgres) | `DATABASE_URL` |

The browser only ever talks to the Vercel origin. `vercel.json` rewrites
`/api/*` through to Railway, so there is no CORS setup and no API URL baked
into the client bundle.

---

## 1. Database

Provision Postgres first — the API will not start without it.

Railway → **New → Database → PostgreSQL**. Copy the `DATABASE_URL` it
generates.

Then, from your machine, create the schema and seed the game catalog:

```bash
DATABASE_URL="postgres://..." pnpm run db:push
```

```bash
DATABASE_URL="postgres://..." pnpm run db:seed
```

> Without `DATABASE_URL` the app silently falls back to PGlite, an embedded
> Postgres stored under `~/.game-dev-hub/pglite-data`. That is a local-dev
> convenience only — on Railway it would live on ephemeral disk and be wiped
> on every deploy, so `DATABASE_URL` is required in production.

## 2. API on Railway

Railway → **New → GitHub Repo**, point it at this repo. `railway.json` is
picked up automatically:

- build: `pnpm run build:api`
- start: `pnpm run start:api`
- health check: `/api/healthz`

Set these variables on the service:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | from step 1 |
| `NODE_ENV` | `production` |
| `XAI_API_KEY` | your xAI key — **only** needed for Boat Booth's AI scene generation |
| `NIXPACKS_INSTALL_CMD` | `pnpm install --frozen-lockfile --filter @workspace/api-server...` |

`PORT` is injected by Railway; the server reads it and refuses to start if
it's missing, so don't set it yourself.

That `NIXPACKS_INSTALL_CMD` is a build-time optimisation, not a requirement.
Without it Railway installs every workspace package — including three.js,
face-api and the rest of the game dependencies — none of which the API needs.
The filtered install pulls only `@workspace/api-server` and its transitive
workspace deps.

Once it's live, note the public URL (e.g. `https://xyz.up.railway.app`) and
confirm it:

```bash
curl https://YOUR-RAILWAY-URL.up.railway.app/api/healthz
```

## 3. Site on Vercel

**Before importing**, edit `vercel.json` and replace the placeholder in the
first rewrite with your real Railway host:

```json
{
  "source": "/api/:path*",
  "destination": "https://REPLACE-ME.up.railway.app/api/:path*"
}
```

Then Vercel → **Add New → Project** → import this repo. `vercel.json` supplies
the build command, install command and output directory, so leave the
framework preset as "Other" and change nothing in the dashboard.

Build time is around 5–8 minutes: the site plus all five games.

### What the rewrites do

1. `/api/*` → Railway.
2. `/game-previews/boat-booth/*` → that game's `index.html`. Boat Booth is the
   only game with client-side routes (`/` and `/create`), so a direct load or
   refresh of `/create` would otherwise 404.
3. Everything else → the site's `index.html`, the usual SPA fallback. The
   negative lookahead keeps it from swallowing the two rules above.

Vercel applies rewrites *after* the filesystem check, so real static files —
every JS chunk, video and image — are served directly and never touch these
rules.

## 4. Verify

- `/` — landing page loads, game catalog populated (proves the API rewrite works)
- `/games` — 5 cards; Zombie Hunter is gone
- Customize any game — the preview iframe themes live as you change colors
- `/game-previews/boat-booth/create` — loads on a hard refresh (proves rewrite 2)

---

## The build pipeline

`pnpm run build:web` → `scripts/build-site.mjs`, which runs two steps in a
load-bearing order:

1. Build `citrus-landing` into `artifacts/citrus-landing/dist/public`.
2. Run `scripts/build-games.mjs`, which builds each game at its own public base
   path (`/game-previews/<slug>/`) and copies the output into the site's
   `dist/public/game-previews/`.

The order cannot be swapped: citrus-landing's vite config sets
`emptyOutDir: true`, so building the site second would delete the games.

To rebuild a single game while iterating:

```bash
node scripts/build-games.mjs cyber-adventure
```

Each game must be built with its base path baked in, because they resolve
assets at runtime through `import.meta.env.BASE_URL`. A game built at the
default `/` base will 404 on every asset once it's served from a sub-path.

## Known costs

The basketball game ships ~66MB of video (`client/public/newbb/*.mp4`,
`ball/ball.mp4`). It is by far the largest thing on the CDN and will dominate
bandwidth for anyone who opens that game. If bills become a concern, the fix is
to move those files to a video host and reference them by URL rather than
bundling them into the build.

---

# Deploying to Render instead

`render.yaml` at the repo root is a Render Blueprint. Unlike the Vercel +
Railway split above, it runs everything as **one Docker web service** plus a
Postgres instance:

| Piece | Render resource | Name in the Blueprint |
| --- | --- | --- |
| API + `citrus-landing` + all 5 game builds | Web Service (Docker, `./Dockerfile`) | `requisor-api` |
| Postgres | Render Postgres | `requisor-db` |

**Why one service.** Render's native Node build image (September 2026)
reinstalls pnpm into the read-only `/usr` tree before the build command runs
and fails with `EROFS`, whatever the repo says. The Dockerfile sidesteps
Render's Node tooling entirely, and in production the API serves the built
site and the staged game previews itself
(`artifacts/api-server/src/lib/site-static.ts`, mounted from `app.ts` when
`NODE_ENV=production` and the site build exists next to the bundle). One
origin, so no `/api/*` rewrite and no hostname to check. The trade-off is
that game videos are served by the Node container rather than a CDN; for
booth-scale traffic that is fine, and the static-site layout can come back
once Render fixes their image.

## 1. Apply the Blueprint

Render Dashboard → **New → Blueprint** → this repo, on the branch that holds
`render.yaml`. Render prompts for the one secret marked `sync: false`:

| Prompt | Value |
| --- | --- |
| `XAI_API_KEY` | your xAI key — only needed for Boat Booth's AI scene generation; any placeholder otherwise |

Click **Apply**. The first build takes roughly ten minutes (a full workspace
install, the site, five games, the API bundle). Later builds reuse Docker
layers and are quicker unless `pnpm-lock.yaml` changed.

If the Blueprint already exists from the earlier attempt, pushing the new
`render.yaml` re-syncs it and `requisor-api` switches from the Node runtime
to Docker in place. The old `requisor-site` static site is no longer in the
file; Render leaves removed resources alone, so delete it from the dashboard
once `requisor-api` is healthy.

## 2. Database (one-time, from your machine)

The runtime image carries the built bundles but no pnpm or drizzle-kit, so
schema and seed are pushed from your machine using the database's **External**
connection string
(dashboard → `requisor-db` → Connect):

```bash
DATABASE_URL="postgres://...render.com/requisor?sslmode=require" pnpm run db:push
DATABASE_URL="postgres://...render.com/requisor?sslmode=require" pnpm run db:seed
```

Repeat `db:push` for every later schema change. Until the first push runs,
`/api/games` returns a 500 and the catalog is empty.

## 3. Verify

Read the service URL from the dashboard (Render suffixes the subdomain when
`requisor-api` is taken), then:

```bash
curl https://YOUR-SERVICE.onrender.com/api/healthz
```

- `/` — landing page loads, game catalog populated
- `/games` — 5 cards
- Customize any game — the preview iframe themes live as you change colors
- `/game-previews/boat-booth/create` — loads on a hard refresh

## Plans and cost

| Resource | Blueprint plan | What `free` would do |
| --- | --- | --- |
| `requisor-api` | `0.5c-512mb` (~$7/mo) | spins down after 15 idle minutes: ~1 min cold start, and Boat Booth's background video polling dies mid-job until the next request wakes the service |
| `requisor-db` | `0.1c-256mb` (~$6/mo) | expires 30 days after creation, no backups, deleted 14 days later with all drafts, orders and Boat Booth media |

Game videos (the basketball game alone ships ~66 MB) now leave through the
web service and count against the workspace's outbound bandwidth allowance.

## Building the image locally

```bash
docker build --platform linux/amd64 -t requisor-game .
docker run --rm -e PORT=10000 -p 10000:10000 -e DATABASE_URL="postgres://..." requisor-game
```

`--platform linux/amd64` is mandatory on Apple Silicon: `pnpm-workspace.yaml`
strips every native binary except linux-x64 (and the Windows ones listed in the
root `package.json`), so a linux/arm64 image cannot build. Without
`DATABASE_URL` the container falls back to PGlite inside its ephemeral
filesystem, which is fine for a smoke test.
