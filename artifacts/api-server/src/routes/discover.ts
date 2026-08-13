import { Router, type IRouter } from "express";
import { db, seedsTable, discoverPoolTable } from "@workspace/db";
import { eq, notInArray, sql } from "drizzle-orm";
import { ensureUserTracksSeeded, getRankedTracks } from "../lib/elo";
import {
  lastfmSimilarTracks, lastfmSimilarArtists, lastfmTopTrack,
  lastfmArtistBlurb, lastfmTrackBlurb,
} from "../lib/enrich";
import { fetchItunesData } from "../lib/links";
import { bustCacheEntry } from "../lib/http";
import { resolve } from "../lib/musicbrainz";
import { logger } from "../lib/logger";
import {
  ensurePoolSeeded, ingestSpotifyPlaylist, DEFAULT_DISCOVER_PLAYLIST,
} from "../lib/discoverPool";

const router: IRouter = Router();

const key = (title: string, artist: string) => `${title}|${artist}`.toLowerCase();

interface DiscoverTrack {
  mbid: string;
  type: string;
  title: string;
  artist: string;
  year: number | null;
  spotifyId: string | null;
  artworkUrl: string | null;
}

/**
 * Pick a random pool track the user hasn't matched yet. A rated pool track lands
 * in rankings under a `spotify:<id>` key, so we exclude exactly those at the SQL
 * level — that keeps the pool in play (the 60/40 blend holds) until every last
 * pool song has been matched, at which point this returns null and the feed goes
 * CF-only. `matchedSpotifyIds` are the pool ids already in the user's rankings.
 */
async function tryPool(excluded: Set<string>, matchedSpotifyIds: string[]): Promise<DiscoverTrack | null> {
  // Guarded: the discover_pool table requires a drizzle-kit push; degrade to CF
  // (via the null return) if it isn't there yet.
  let sample: Array<typeof discoverPoolTable.$inferSelect>;
  try {
    const base = db.select().from(discoverPoolTable).$dynamic();
    const filtered = matchedSpotifyIds.length > 0
      ? base.where(notInArray(discoverPoolTable.spotifyId, matchedSpotifyIds))
      : base;
    sample = await filtered.orderBy(sql`random()`).limit(30);
  } catch {
    return null;
  }
  // Second-pass JS filter for cross-source dupes (same title/artist rated via a
  // different source) and the client's recently-served set.
  const pick = sample.find((t) => !excluded.has(key(t.title, t.artist)));
  if (!pick) return null;
  return {
    // A Spotify id makes a perfect stable de-dupe key for ratings too.
    mbid: `spotify:${pick.spotifyId}`,
    type: "track",
    title: pick.title,
    artist: pick.artist,
    year: null,
    spotifyId: pick.spotifyId,
    artworkUrl: pick.artworkUrl,
  };
}

/** Collaborative-filtering pick from Last.fm neighbours of the user's top tracks. */
async function tryCF(
  ranked: Awaited<ReturnType<typeof getRankedTracks>>,
  seeds: Array<{ title: string; artist: string }>,
  excluded: Set<string>,
  excludedArtists: Set<string>,
): Promise<DiscoverTrack | null> {
  const anchorTracks: Array<{ title: string; artist: string }> = [
    ...ranked.filter((t) => t.matches > 0).sort((a, b) => b.rating - a.rating),
    ...ranked.filter((t) => t.matches === 0),
    ...seeds,
  ];
  if (anchorTracks.length === 0) return null;

  // Shuffle all anchors so we don't always query the same top tracks.
  const shuffled = anchorTracks
    .map((t) => ({ t, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.t)
    .slice(0, 8); // wider anchor pool → more varied similar-track results

  const candidates = new Map<string, { title: string; artist: string; match: number }>();
  const add = (title: string, artist: string, match: number) => {
    if (!title || !artist) return;
    // Artist-level exclusion: skip any artist already shown this session or in rankings.
    if (excludedArtists.has(artist.toLowerCase())) return;
    const k = key(title, artist);
    if (excluded.has(k)) return;
    const cur = candidates.get(k);
    if (!cur || match > cur.match) candidates.set(k, { title, artist, match });
  };

  const simTrackLists = await Promise.all(
    shuffled.map((a) => lastfmSimilarTracks(a.artist, a.title).catch(() => [])),
  );
  for (const list of simTrackLists) for (const s of list) add(s.name, s.artist, s.match);

  if (candidates.size === 0) {
    const simArtistLists = await Promise.all(
      shuffled.slice(0, 3).map((a) => lastfmSimilarArtists(a.artist).catch(() => [])),
    );
    const artistNames = [...new Set(simArtistLists.flat().map((a) => a.name))].slice(0, 8);
    const tops = await Promise.all(artistNames.map((n) => lastfmTopTrack(n).catch(() => null)));
    for (const top of tops) if (top) add(top.name, top.artist, 0.5);
  }
  if (candidates.size === 0) return null;

  const ordered = [...candidates.values()].sort((a, b) => b.match - a.match);
  // Pick randomly from the top 20 rather than top 5 — prevents the same handful
  // of highest-match artists from monopolising every session.
  const pick = ordered[Math.floor(Math.random() * Math.min(20, ordered.length))];

  // Attempt a real MusicBrainz resolve for a stable MBID and release year.
  // Fall back to a synthetic key so the CF path never blocks on a slow MB call.
  let mbid = `lastfm:${pick.artist.toLowerCase().replace(/[^\w]/g, "-")}:${pick.title.toLowerCase().replace(/[^\w]/g, "-")}`;
  let year: number | null = null;
  try {
    const resolved = await resolve(
      { artist: pick.artist, title: pick.title, type: "track", likely_known: "medium" },
      3_500,
    );
    if (resolved) { mbid = resolved.mbid; year = resolved.year ?? null; }
  } catch { /* best-effort */ }

  return { mbid, type: "track", title: pick.title, artist: pick.artist, year, spotifyId: null, artworkUrl: null };
}

/**
 * GET /discover/track — pick a track within a hard 2.8 s wall.
 *
 * Blends pool (60 %) + CF (40 %) while the pool has unmatched tracks; once the
 * pool is fully exhausted the feed is CF-only. Pool tracks carry Spotify artwork
 * and a spotifyId; CF tracks carry neither (artwork is fetched lazily via
 * /discover/artwork).
 */
router.get("/discover/track", async (req, res): Promise<void> => {
  const userId = Number(req.query.userId);
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  ensurePoolSeeded(); // fire-and-forget: self-populate the pool after deploy

  const WALL_MS = 2_800;

  const work = async (): Promise<{ track: DiscoverTrack | null }> => {
    await ensureUserTracksSeeded(userId);
    const [ranked, seeds] = await Promise.all([
      getRankedTracks(userId),
      db.select().from(seedsTable).where(eq(seedsTable.userId, userId)).catch(() => []),
    ]);

    const excluded = new Set<string>();
    for (const t of ranked) excluded.add(key(t.title, t.artist));
    for (const s of seeds) excluded.add(key(s.title, s.artist));
    const excludeParam = typeof req.query.exclude === "string" ? req.query.exclude : "";
    for (const k of excludeParam.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      excluded.add(k);
    }

    // Artist-level exclusions: passed by the client as recently-seen artist names.
    // Prevents the same artist from appearing in consecutive cards even for different tracks.
    const excludeArtistsParam = typeof req.query.excludeArtists === "string" ? req.query.excludeArtists : "";
    const excludedArtists = new Set(
      excludeArtistsParam.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    );
    // Also exclude artists already in the user's ranked tracks so they can't
    // reappear via a different track title.
    for (const t of ranked) excludedArtists.add(t.artist.toLowerCase());
    for (const s of seeds) excludedArtists.add(s.artist.toLowerCase());

    // spotify:* MBIDs in rankings = pool tracks already matched
    const matchedSpotifyIds = ranked
      .map((t) => t.mbid)
      .filter((m) => m.startsWith("spotify:"))
      .map((m) => m.slice("spotify:".length));

    const preferPool = Math.random() < 0.6;
    const seedTracks = seeds.map((s) => ({ title: s.title, artist: s.artist }));
    const track = preferPool
      ? (await tryPool(excluded, matchedSpotifyIds)) ?? (await tryCF(ranked, seedTracks, excluded, excludedArtists))
      : (await tryCF(ranked, seedTracks, excluded, excludedArtists)) ?? (await tryPool(excluded, matchedSpotifyIds));

    return { track: track ?? null };
  };

  const wall = new Promise<{ track: null }>((resolve) =>
    setTimeout(() => {
      logger.warn({ userId }, "discover/track wall hit — returning null");
      resolve({ track: null });
    }, WALL_MS),
  );

  const result = await Promise.race([work(), wall]);
  res.json(result);
});

/**
 * GET /discover/artwork — lightweight iTunes artwork lookup for CF tracks that
 * don't carry artwork in the track response. Non-blocking; called after the card
 * renders. Busts stale null-cached entries so empty results are retried fresh.
 */
router.get("/discover/artwork", async (req, res): Promise<void> => {
  const artist = String(req.query.artist ?? "").trim();
  const title  = String(req.query.title  ?? "").trim();
  if (!artist || !title) { res.status(400).json({ error: "artist and title required" }); return; }

  const cacheKey = `itunes:${artist.toLowerCase()}:${title.toLowerCase()}`;
  let { artworkUrl } = await fetchItunesData(artist, title, { timeoutMs: 4_000, retries: 0 });

  if (!artworkUrl) {
    // Cached empty result — bust it and retry once against the live API
    await bustCacheEntry(cacheKey).catch(() => null);
    ({ artworkUrl } = await fetchItunesData(artist, title, { timeoutMs: 4_000, retries: 1 }));
  }

  res.json({ artworkUrl });
});

/**
 * GET /discover/info — artist bio + track blurb from Last.fm, for the info
 * bubbles that appear in the Discover & rank card when a track is shown.
 * Both fields are nullable (Last.fm may have no write-up). Cached 30 days.
 */
router.get("/discover/info", async (req, res): Promise<void> => {
  const artist = typeof req.query.artist === "string" ? req.query.artist.trim() : "";
  const title  = typeof req.query.title  === "string" ? req.query.title.trim()  : "";
  if (!artist) { res.status(400).json({ error: "artist required" }); return; }

  const [artistBlurb, trackBlurb] = await Promise.all([
    lastfmArtistBlurb(artist),
    title ? lastfmTrackBlurb(artist, title) : Promise.resolve(null),
  ]);

  res.json({ artist: artistBlurb, track: trackBlurb });
});

/** Extract a playlist id from a raw id or a full Spotify URL. */
function parsePlaylistId(input: string): string {
  const m = input.match(/playlist[/:]([A-Za-z0-9]+)/);
  return m ? m[1] : input.trim();
}

/**
 * POST /discover/ingest-playlist — pull a Spotify playlist into the pool
 * (append + de-dupe by Spotify track id). Body: { playlistId? } — a raw id or a
 * full playlist URL; defaults to the configured playlist.
 */
router.post("/discover/ingest-playlist", async (req, res): Promise<void> => {
  const raw = (req.body as { playlistId?: unknown })?.playlistId;
  const playlistId = typeof raw === "string" && raw.trim() ? parsePlaylistId(raw) : DEFAULT_DISCOVER_PLAYLIST;
  const result = await ingestSpotifyPlaylist(playlistId);
  res.json({ playlistId, ...result });
});

export default router;
