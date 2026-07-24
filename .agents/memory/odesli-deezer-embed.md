---
name: Odesli/Deezer embed resolution
description: How music embed IDs are resolved; why Odesli is unreliable and Deezer is the working fallback.
---

# Music Embed Resolution Pipeline

## Current pipeline (links.ts `resolveLinks`)

1. **DB cache** — `resolved_entities` table; reads `spotifyUri`, `youtubeId`, `artworkUrl` from prior runs and `relationships_json` from MB enrich. Fast path when already resolved.
2. **Fake MBID early exit** — `lastfm:…` MBIDs skip all external calls; Deezer search runs for embed.
3. **Odesli with MB recording URL** — single attempt (`retries: 1`); no wait on last-attempt 429. Fails instantly if IP-blocked.
4. **Deezer + iTunes in parallel** — Deezer free search API (no auth) + iTunes for artwork & Apple Music URL. Deezer widget embed: `https://widget.deezer.com/widget/auto/track/{deezerId}`.
5. **Search-URL absolute fallback** — when Deezer also returns nothing.

## Why Odesli is unreliable from this server IP

- **MB recording URLs** return HTTP 400 for most jazz recordings (Odesli doesn't index them).
- When rate-limited (429), Odesli sometimes returns **empty `{}`** rather than 429, making detection harder.
- **Apple Music URLs** also return empty `{}` from this IP — Odesli appears to have an IP-level block.
- MusicBrainz `relationships_json`: every resolved entity has `spotify_rels_count = 0` — MB does not store Spotify streaming links for these tracks (older jazz recordings).

**Why:** The development server IP is rate-limited by Odesli. Production may behave differently.

## Deezer details

- Free search endpoint: `https://api.deezer.com/search?q={artist}+{title}&limit=1`
- Returns `id` (Deezer track ID), `preview` (30s MP3 CDN URL), `isrc`
- Widget embed: `https://widget.deezer.com/widget/auto/track/{id}?autoplay=true`
- Cache TTL: 30 days (stable IDs)

## http.ts retry behavior

- **4xx** (except 429): immediately re-thrown from catch block — not retried.
- **429**: retried up to `retries` times; on the LAST attempt, does NOT wait (hasMoreAttempts check).
- Default `retries: 3`; Odesli calls use `retries: 1` to fail fast.

## StreamingLinks interface additions

Added `deezerId: string | null` to `StreamingLinks` (api-server) and `ResolvedLinks` (web frontend).
`source` union now includes: `"odesli" | "odesli_am" | "mb_relations" | "deezer" | "search_fallback"`.

## Frontend: InlinePlayer

Supports three providers: Spotify → YouTube → Deezer (priority order).
Deezer tab shows `SiDeezer` icon (exists in react-icons/si as `SiDeezer`).
`queue.tsx` and `timeline.tsx` thread `deezerId` through `linksHaveEmbedIds` checks and `linksToResolved`.
