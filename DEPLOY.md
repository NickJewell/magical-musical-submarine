# Deploying Trails to Railway

Trails runs as **one Railway service** plus a **Postgres** plugin. The Express
API server (`@workspace/api-server`) also serves the built trails SPA from
`artifacts/trails/dist/public`, so the UI and `/api` share a single origin —
which is what Clerk's same-origin proxy needs. `railway.toml` at the repo root
drives the build, the schema push, and the start command.

Your Claude Code → GitHub → Railway loop stays the same: open PRs here, merge to
`main`, and Railway auto-builds and deploys. Preview environments (optional) give
each PR its own URL.

## One-time setup

1. **Create the project** — in Railway, *New Project → Deploy from GitHub repo* and
   pick `NickJewell/magical-musical-submarine`. It will read `railway.toml`.
2. **Add Postgres** — *New → Database → PostgreSQL*. Railway injects `DATABASE_URL`
   into the service automatically. (The `preDeployCommand` runs `drizzle-kit push`
   against it on every deploy, so the schema is applied without migration files.)
3. **Set the environment variables** below (*Service → Variables*). Do **not** set a
   global `NODE_ENV` — it would prune the dev dependencies the build needs;
   `railway.toml` sets `NODE_ENV=production` inline where required.
4. **Deploy** — trigger the first deploy. Once green, grab the public URL
   (*Settings → Networking → Generate Domain*) and set `APP_BASE_URL` /
   `VITE_CLERK_PROXY_URL` if you used the full-URL form (see notes).
5. **(Optional) PR previews** — *Settings → Environments* → enable PR deploys so each
   open PR gets an isolated environment. Give it "wait for CI" so the GitHub Actions
   check (`.github/workflows/ci.yml`) must pass before a preview deploys.

## Environment variables

### Runtime — required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Injected by the Railway Postgres plugin. |
| `CLERK_SECRET_KEY` | Clerk backend key (`sk_...`). |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key (`pk_...`) — server fallback. |
| `OPENROUTER_API_KEY` | LLM (dives, portraits) — features fail without it. |
| `LASTFM_API_KEY` | Enrichment / CF / info bubbles. |
| `APP_BASE_URL` | Your deployed URL, e.g. `https://trails.up.railway.app` (used as the OpenRouter referer). |
| `SESSION_SECRET` | HMAC secret for the Spotify OAuth session (set a long random value). |

> `PORT` and `NODE_ENV` are handled for you (Railway injects `PORT`; `railway.toml`
> sets `NODE_ENV`). No need to add them.

### Build-time — required (must exist when the trails SPA builds)

| Variable | Notes |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key — **inlined into the bundle at build**, so it must be present as a service variable before the build runs. |
| `VITE_CLERK_PROXY_URL` | Set to `/api/__clerk` (relative → same-origin, works on any domain). Passed to `ClerkProvider proxyUrl`. |

### Optional

| Variable | Default / purpose |
|---|---|
| `MB_CONTACT` | Contact string in the MusicBrainz User-Agent (be polite — set a real email). |
| `OPENROUTER_PROPOSE_MODEL` | `moonshotai/kimi-k2` |
| `OPENROUTER_PORTRAIT_MODEL` | `moonshotai/kimi-k2` |
| `OPENROUTER_NARRATE_MODEL` | `meta-llama/llama-3.3-70b-instruct` |
| `LOG_LEVEL` | pino level (`info` default). |
| `CACHE_PURGE_INTERVAL_MS` | http_cache sweep interval (default 6h). |
| `FEATURE_SPOTIFY_EXPORT` + `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` / `SPOTIFY_REDIRECT_URI` | Enable the "export dive to Spotify" flow. `SPOTIFY_REDIRECT_URI` must be `<APP_BASE_URL>/api/spotify/callback` and registered in the Spotify app. |
| `CANON_ADMIN_SECRET` / `CANON_DUEL_STRATEGY` / `CANON_POOL_TARGET` | Canon (shared-pool) admin + tuning. |

## Heads-up: Clerk was provisioned by Replit

The Clerk auth instance was set up through Replit's Auth pane, which noted "there is
no external Clerk dashboard." Moving off Replit means you'll want to **own the Clerk
application directly** (Clerk dashboard): confirm the publishable/secret keys, add
your Railway domain to the allowed origins, and verify the Frontend-API proxy points
at `<your-domain>/api/__clerk`. This is the one part of the migration that lives
outside the repo — the code already proxies Clerk correctly; it just needs the keys
and the domain registered on Clerk's side.

## What maps from the old Replit setup

| Replit | Railway |
|---|---|
| `.replit` autoscale + application router | one service (API serves SPA + `/api`) — `railway.toml` |
| `scripts/post-merge.sh` → `pnpm --filter db push` | `preDeployCommand` in `railway.toml` |
| Replit Postgres module | Railway Postgres plugin (`DATABASE_URL`) |
| Replit secrets | Railway service variables (above) |
