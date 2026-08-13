import { Router, type IRouter } from "express";
import {
  fetchLastfmTopTracks, importLastfmHistory,
  LASTFM_PERIODS, IMPORT_MAX, type LastfmPeriod,
} from "../lib/importHistory";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function parsePeriod(raw: unknown): LastfmPeriod {
  return LASTFM_PERIODS.includes(raw as LastfmPeriod) ? (raw as LastfmPeriod) : "overall";
}

const isNotFound = (err: unknown) =>
  err instanceof Error && (err.message.includes("HTTP 404") || err.message.includes("Last.fm error 6"));

/**
 * GET /import/lastfm/preview?username=&period= — validate a username before
 * importing: returns the canonical username, how many tracks the period holds,
 * and a small sample. 404 when Last.fm doesn't know the user.
 */
router.get("/import/lastfm/preview", async (req, res): Promise<void> => {
  const username = typeof req.query.username === "string" ? req.query.username.trim() : "";
  if (!username) { res.status(400).json({ error: "username required" }); return; }
  const period = parsePeriod(req.query.period);

  try {
    const { user, total, tracks } = await fetchLastfmTopTracks(username, period, 5);
    res.json({
      username: user,
      totalTracks: total,
      sample: tracks.map((t) => ({ title: t.title, artist: t.artist, playcount: t.playcount })),
    });
  } catch (err) {
    if (isNotFound(err)) { res.status(404).json({ error: "Last.fm user not found" }); return; }
    logger.warn({ err: String(err), username }, "lastfm preview failed");
    res.status(502).json({ error: "Couldn't reach Last.fm — try again" });
  }
});

/**
 * POST /import/lastfm — import a Last.fm user's top tracks into the taste
 * graph as unstarred "known" tracks. Body: { userId, username, period?, limit? }.
 * Idempotent: already-known tracks are skipped, so re-running re-syncs.
 */
router.post("/import/lastfm", async (req, res): Promise<void> => {
  const body = req.body as { userId?: unknown; username?: unknown; period?: unknown; limit?: unknown };
  const userId = Number(body.userId);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!userId || !username) { res.status(400).json({ error: "userId and username required" }); return; }

  const period = parsePeriod(body.period);
  const rawLimit = Number(body.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, IMPORT_MAX) : 100;

  try {
    const result = await importLastfmHistory({ userId, username, period, limit });
    res.json({ username, period, ...result });
  } catch (err) {
    if (isNotFound(err)) { res.status(404).json({ error: "Last.fm user not found" }); return; }
    logger.error({ err: String(err), userId, username }, "lastfm import failed");
    res.status(502).json({ error: "Import failed — try again" });
  }
});

export default router;
