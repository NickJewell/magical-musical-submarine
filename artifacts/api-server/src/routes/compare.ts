import { Router, type IRouter } from "express";
import { db, tasteEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ensureUserTracksSeeded, getRankedTracks } from "../lib/elo";

const router: IRouter = Router();

const DONE = {
  done: true, aMbid: null, aTitle: null, aArtist: null,
  bMbid: null, bTitle: null, bArtist: null,
};

/**
 * GET /compare/pair — the next head-to-head from the user's rankings, chosen to
 * converge ELO fast: anchor on the least-compared track (it needs data most),
 * pair it with the closest-rated partner (an uncertain outcome is the most
 * informative), and avoid pairs already compared. This is a continuous feed —
 * once every fresh pair is exhausted it re-serves the closest match-ups (further
 * comparisons still sharpen a tight ranking), so it never runs dry while the
 * user stays on the tab. `lastA`/`lastB` skip an immediate repeat of the pair
 * just submitted.
 */
router.get("/compare/pair", async (req, res): Promise<void> => {
  const userId = Number(req.query.userId);
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  await ensureUserTracksSeeded(userId);
  const ranked = await getRankedTracks(userId);
  if (ranked.length < 2) { res.json(DONE); return; }

  const lastA = typeof req.query.lastA === "string" ? req.query.lastA : null;
  const lastB = typeof req.query.lastB === "string" ? req.query.lastB : null;
  const isLastPair = (m1: string, m2: string) =>
    !!lastA && !!lastB && ((m1 === lastA && m2 === lastB) || (m1 === lastB && m2 === lastA));

  // Previously-compared pairs
  const events = await db
    .select()
    .from(tasteEventsTable)
    .where(eq(tasteEventsTable.userId, userId));
  const donePairs = new Set<string>(
    events
      .filter((r) => r.kind === "pair_choice")
      .map((e) => {
        const p = e.payloadJson as { aMbid?: string; bMbid?: string };
        return `${p.aMbid}:${p.bMbid}`;
      }),
  );
  const isDone = (m1: string, m2: string) =>
    donePairs.has(`${m1}:${m2}`) || donePairs.has(`${m2}:${m1}`);

  // Least-compared first, random tie-break for variety.
  const pool = [...ranked].sort((x, y) => x.matches - y.matches || Math.random() - 0.5);

  const closestPartner = (anchor: typeof pool[number], allowDone: boolean) => {
    let best: typeof pool[number] | null = null;
    let bestGap = Infinity;
    for (const other of pool) {
      if (other.mbid === anchor.mbid) continue;
      if (isLastPair(anchor.mbid, other.mbid)) continue;
      if (!allowDone && isDone(anchor.mbid, other.mbid)) continue;
      const gap = Math.abs(anchor.rating - other.rating);
      if (gap < bestGap) { bestGap = gap; best = other; }
    }
    return best;
  };

  // Prefer a genuinely new, informative pair; fall back to re-serving the
  // closest match-up when every fresh pair is exhausted.
  for (const allowDone of [false, true]) {
    for (const anchor of pool) {
      const partner = closestPartner(anchor, allowDone);
      if (partner) {
        res.json({
          done: false,
          aMbid: anchor.mbid, aTitle: anchor.title, aArtist: anchor.artist,
          bMbid: partner.mbid, bTitle: partner.title, bArtist: partner.artist,
        });
        return;
      }
    }
  }

  res.json(DONE);
});

export default router;
