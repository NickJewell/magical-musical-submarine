import { Router, type IRouter } from "express";
import { db, seedsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ensureUserTracksSeeded, getRankedTracks } from "../lib/elo";
import { lastfmSimilarTracks, lastfmSimilarArtists, lastfmTopTrack } from "../lib/enrich";
import { fetchItunesData } from "../lib/links";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const key = (title: string, artist: string) => `${title}|${artist}`.toLowerCase();

/**
 * GET /discover/track — serve a single fresh track within a hard 2.8 s wall.
 *
 * Deliberate simplification: MusicBrainz resolve and iTunes artwork are NOT
 * awaited here (they were the main source of 4-13 s hangs). Artwork is served
 * by the separate /discover/artwork endpoint so the card can render it lazily.
 */
router.get("/discover/track", async (req, res): Promise<void> => {
  const userId = Number(req.query.userId);
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  // Hard wall: if everything below doesn't complete in 2.8 s return null so
  // the client gets a quick "no fresh picks" state rather than hanging.
  const WALL_MS = 2_800;

  type TrackResult = {
    track: { mbid: string; type: string; title: string; artist: string; year: null };
  } | { track: null };

  const work = async (): Promise<TrackResult> => {
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

    const anchorTracks: Array<{ title: string; artist: string }> = [
      ...ranked.filter((t) => t.matches > 0).sort((a, b) => b.rating - a.rating),
      ...ranked.filter((t) => t.matches === 0),
      ...seeds.map((s) => ({ title: s.title, artist: s.artist })),
    ];
    if (anchorTracks.length === 0) return { track: null };

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

    if (candidates.size === 0) return { track: null };

    const ordered = [...candidates.values()].sort((a, b) => b.match - a.match);
    const pick = ordered[Math.floor(Math.random() * Math.min(5, ordered.length))];

    // Synthetic MBID — stable enough for rankings dedup; a real MBID is not
    // worth the 3-10 s MusicBrainz resolve cost on this hot path.
    const mbid = `lastfm:${pick.artist.toLowerCase().replace(/[^\w]/g, "-")}:${pick.title.toLowerCase().replace(/[^\w]/g, "-")}`;

    return { track: { mbid, type: "track", title: pick.title, artist: pick.artist, year: null } };
  };

  const wall = new Promise<TrackResult>((resolve) =>
    setTimeout(() => {
      logger.warn({ userId }, "discover/track wall hit — returning null");
      resolve({ track: null });
    }, WALL_MS),
  );

  const result = await Promise.race([work(), wall]);
  res.json(result);
});

/**
 * GET /discover/artwork?artist=&title= — lightweight iTunes artwork lookup.
 * Called lazily by the client after it has the track, so it never blocks
 * the initial card render.  Cached 30 days so repeat calls are instant.
 */
router.get("/discover/artwork", async (req, res): Promise<void> => {
  const artist = String(req.query.artist ?? "").trim();
  const title  = String(req.query.title  ?? "").trim();
  if (!artist || !title) { res.status(400).json({ error: "artist and title required" }); return; }

  const { artworkUrl } = await fetchItunesData(artist, title, { timeoutMs: 4_000, retries: 0 });
  res.json({ artworkUrl });
});

export default router;
