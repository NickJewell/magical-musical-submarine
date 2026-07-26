import { Router, type IRouter } from "express";
import { db, seedsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ensureUserTracksSeeded, getRankedTracks } from "../lib/elo";
import { lastfmSimilarTracks, lastfmSimilarArtists, lastfmTopTrack } from "../lib/enrich";
import { resolve } from "../lib/musicbrainz";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const key = (title: string, artist: string) => `${title}|${artist}`.toLowerCase();

/**
 * GET /discover/track — a single fresh track recommendation to rate, so the user
 * can build their rankings quickly. Collaborative-filtering from what they
 * already rank highest (Last.fm similar tracks of their top picks, then similar
 * artists' top tracks), excluding anything already in their rankings/seeds and
 * anything the client has recently been served (`exclude`, a csv of
 * "title|artist" keys). Resolves a real MusicBrainz id when quick, else a stable
 * synthetic key so the rating still lands in rankings.
 */
router.get("/discover/track", async (req, res): Promise<void> => {
  const userId = Number(req.query.userId);
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  await ensureUserTracksSeeded(userId);
  const [ranked, seeds] = await Promise.all([
    getRankedTracks(userId),
    db.select().from(seedsTable).where(eq(seedsTable.userId, userId)).catch(() => []),
  ]);

  // Everything we must NOT recommend: current rankings, seeds, and the client's
  // recently-served set.
  const excluded = new Set<string>();
  for (const t of ranked) excluded.add(key(t.title, t.artist));
  for (const s of seeds) excluded.add(key(s.title, s.artist));
  const excludeParam = typeof req.query.exclude === "string" ? req.query.exclude : "";
  for (const k of excludeParam.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    excluded.add(k);
  }

  // Anchors: the tracks the user ranks highest carry the most signal; fall back
  // to seeds. A little shuffle keeps the feed from repeating the same neighbours.
  const anchorTracks: Array<{ title: string; artist: string }> = [
    ...ranked.filter((t) => t.matches > 0).sort((a, b) => b.rating - a.rating),
    ...ranked.filter((t) => t.matches === 0),
    ...seeds.map((s) => ({ title: s.title, artist: s.artist })),
  ];
  if (anchorTracks.length === 0) { res.json({ track: null }); return; }

  const shuffled = anchorTracks
    .map((t) => ({ t, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.t)
    .slice(0, 5);

  // Collect candidates: similar tracks of the anchors first (most precise CF),
  // then similar artists' top tracks as a broader fallback.
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

  if (candidates.size === 0) { res.json({ track: null }); return; }

  // Weighted-ish pick: sort by match, then take one of the top few at random so
  // the feed stays fresh rather than deterministic.
  const ordered = [...candidates.values()].sort((a, b) => b.match - a.match);
  const pick = ordered[Math.floor(Math.random() * Math.min(5, ordered.length))];

  // Try to attach a real MBID (dedups with dive recs), but don't stall the feed.
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

  res.json({
    track: { mbid, type: "track", title: pick.title, artist: pick.artist, year },
  });
});

export default router;
