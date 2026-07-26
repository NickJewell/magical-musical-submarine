import { Router, type IRouter } from "express";
import { db, seedsTable, discoverPoolTable } from "@workspace/db";
import { eq, sql, notInArray } from "drizzle-orm";
import { ensureUserTracksSeeded, getRankedTracks } from "../lib/elo";
import {
  lastfmSimilarTracks, lastfmSimilarArtists, lastfmTopTrack,
  lastfmArtistBlurb, lastfmTrackBlurb,
} from "../lib/enrich";
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
): Promise<DiscoverTrack | null> {
  const anchorTracks: Array<{ title: string; artist: string }> = [
    ...ranked.filter((t) => t.matches > 0).sort((a, b) => b.rating - a.rating),
    ...ranked.filter((t) => t.matches === 0),
    ...seeds,
  ];
  if (anchorTracks.length === 0) return null;

  const shuffled = anchorTracks
    .map((t) => ({ t, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.t)
    .slice(0, 5);

  const candidates = new Map<string, { title: string; artist: string; match: number }>();
  const add = (title: string, artist: string, match: number) => {
    if (!title || !artist) return;
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
    const artistNames = [...new Set(simArtistLists.flat().map((a) => a.name))].slice(0, 6);
    const tops = await Promise.all(artistNames.map((n) => lastfmTopTrack(n).catch(() => null)));
    for (const top of tops) if (top) add(top.name, top.artist, 0.5);
  }
  if (candidates.size === 0) return null;

  const ordered = [...candidates.values()].sort((a, b) => b.match - a.match);
  const pick = ordered[Math.floor(Math.random() * Math.min(5, ordered.length))];

  let mbid = `lastfm:${pick.artist.toLowerCase().replace(/[^\w]/g, "-")}:${pick.title.toLowerCase().replace(/[^\w]/g, "-")}`;
  let year: number | null = null;
  try {
    const resolved = await resolve(
      { artist: pick.artist, title: pick.title, type: "track", likely_known: "medium" },
      3500,
    );
    if (resolved) { mbid = resolved.mbid; year = resolved.year; }
  } catch (err) {
    logger.debug({ err, pick }, "discover: MB resolve failed — using synthetic key");
  }

  return { mbid, type: "track", title: pick.title, artist: pick.artist, year, spotifyId: null, artworkUrl: null };
}

/**
 * GET /discover/track — a single fresh track to rate, so the user can build
 * their rankings quickly. Blends two sources: the persisted playlist pool
 * (a curated Spotify playlist) and collaborative-filtering from what the user
 * already ranks highest. Pool-favoured, but each falls back to the other so the
 * feed keeps flowing. Excludes anything already ranked, seeded, or recently
 * served (`exclude`, a csv of "title|artist" keys).
 */
router.get("/discover/track", async (req, res): Promise<void> => {
  const userId = Number(req.query.userId);
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  ensurePoolSeeded(); // fire-and-forget: self-populate the pool after deploy

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

  const seedTracks = seeds.map((s) => ({ title: s.title, artist: s.artist }));

  // Pool tracks the user has already matched land in rankings under `spotify:<id>`.
  const matchedSpotifyIds = ranked
    .map((t) => t.mbid)
    .filter((m) => m.startsWith("spotify:"))
    .map((m) => m.slice("spotify:".length));

  // 60/40 pool-favoured while any pool song remains unmatched; once the pool is
  // fully matched tryPool() returns null and the feed is CF-only. Cross-fallback
  // keeps it flowing if either source comes up empty.
  const preferPool = Math.random() < 0.6;
  const track = preferPool
    ? (await tryPool(excluded, matchedSpotifyIds)) ?? (await tryCF(ranked, seedTracks, excluded))
    : (await tryCF(ranked, seedTracks, excluded)) ?? (await tryPool(excluded, matchedSpotifyIds));

  res.json({ track: track ?? null });
});

/**
 * GET /discover/info — short "info bubble" blurbs about an artist and a track,
 * from Last.fm (artist.getInfo + track.getInfo). Either may be null when Last.fm
 * has no write-up. Cheap + cached; fired when the user opens a track's preview.
 */
router.get("/discover/info", async (req, res): Promise<void> => {
  const artist = typeof req.query.artist === "string" ? req.query.artist.trim() : "";
  const title = typeof req.query.title === "string" ? req.query.title.trim() : "";
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
