import { Router, type IRouter } from "express";
import {
  db, trackEloTable, ratingsTable, recommendationsTable,
  diveStepsTable, divesTable, focusRatingsTable, seedsTable,
} from "@workspace/db";
import { eq, desc, and, inArray } from "drizzle-orm";
import { ensureUserTracksSeeded } from "../lib/elo";

const router: IRouter = Router();

interface StarSource {
  score: number | null;
  listenState: string | null;
  reviewText: string | null;
  ratedAt: Date;
}

/**
 * GET /rankings — every track the user has seeded, rated, or compared, with both
 * signals side by side: their latest star rating and its head-to-head ELO. The
 * star is the most recent of two write paths (dive-rec ratings and focus ratings)
 * so an adjustment from either surface is reflected here. Rec metadata (type,
 * links, artwork, a recId) rides along so each row can offer an inline preview
 * and be re-rated in place.
 */
router.get("/rankings", async (req, res): Promise<void> => {
  const userId = Number(req.query.userId);
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  // Backfill so every seeded/rated track carries a baseline ELO row (the spine).
  await ensureUserTracksSeeded(userId);

  const eloRows = await db
    .select()
    .from(trackEloTable)
    .where(eq(trackEloTable.userId, userId))
    .orderBy(desc(trackEloTable.rating))
    .catch(() => []);

  // Latest rec per mbid (for type / links / artwork / a re-ratable recId).
  const recRows = await db
    .select({
      mbid: recommendationsTable.mbid,
      type: recommendationsTable.type,
      linksJson: recommendationsTable.linksJson,
      artworkUrl: recommendationsTable.artworkUrl,
      recId: recommendationsTable.id,
      createdAt: recommendationsTable.createdAt,
    })
    .from(recommendationsTable)
    .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
    .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
    .where(eq(divesTable.userId, userId))
    .orderBy(desc(recommendationsTable.createdAt))
    .catch(() => []);

  const recByMbid = new Map<string, typeof recRows[number]>();
  for (const r of recRows) if (!recByMbid.has(r.mbid)) recByMbid.set(r.mbid, r);

  // Latest dive-rec star per mbid.
  const ratingRows = await db
    .select({
      mbid: recommendationsTable.mbid,
      score: ratingsTable.score,
      listenState: ratingsTable.listenState,
      reviewText: ratingsTable.reviewText,
      ratedAt: ratingsTable.ratedAt,
    })
    .from(ratingsTable)
    .innerJoin(recommendationsTable, eq(ratingsTable.recId, recommendationsTable.id))
    .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
    .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
    .where(eq(divesTable.userId, userId))
    .orderBy(desc(ratingsTable.ratedAt))
    .catch(() => []);

  const ratingByMbid = new Map<string, StarSource>();
  for (const r of ratingRows) {
    if (ratingByMbid.has(r.mbid)) continue;
    ratingByMbid.set(r.mbid, {
      score: r.score != null ? parseFloat(String(r.score)) : null,
      listenState: r.listenState,
      reviewText: r.reviewText ?? null,
      ratedAt: r.ratedAt,
    });
  }

  // Focus-rating star per mbid (the mbid-keyed write path).
  const focusRows = await db
    .select()
    .from(focusRatingsTable)
    .where(eq(focusRatingsTable.userId, userId))
    .orderBy(desc(focusRatingsTable.ratedAt))
    .catch(() => []);

  const focusByMbid = new Map<string, StarSource>();
  for (const f of focusRows) {
    if (focusByMbid.has(f.mbid)) continue;
    focusByMbid.set(f.mbid, {
      score: f.score != null ? parseFloat(String(f.score)) : null,
      listenState: f.listenState,
      reviewText: f.reviewText ?? null,
      ratedAt: f.ratedAt,
    });
  }

  const rows = eloRows.map((e) => {
    const rec = recByMbid.get(e.mbid) ?? null;
    const recStar = ratingByMbid.get(e.mbid) ?? null;
    const focusStar = focusByMbid.get(e.mbid) ?? null;

    // Most-recent star wins so adjustments from either surface show through.
    let star: StarSource | null = null;
    if (recStar && focusStar) {
      star = focusStar.ratedAt >= recStar.ratedAt ? focusStar : recStar;
    } else {
      star = recStar ?? focusStar;
    }

    return {
      mbid: e.mbid,
      type: rec?.type ?? "track",
      title: e.title,
      artist: e.artist,
      stars: star?.score ?? null,
      listenState: star?.listenState ?? null,
      reviewText: star?.reviewText ?? null,
      ratedAt: star?.ratedAt.toISOString() ?? null,
      elo: {
        rating: e.rating,
        matches: e.matches,
        wins: e.wins,
        losses: e.losses,
        draws: e.draws,
      },
      recId: rec?.recId ?? null,
      linksJson: rec?.linksJson ?? null,
      artworkUrl: rec?.artworkUrl ?? null,
    };
  });

  res.json({ tracks: rows });
});

/**
 * DELETE /rankings/track?userId=&mbid=
 * Permanently remove a track from the user's rankings. Clears every write path
 * so ensureUserTracksSeeded won't resurrect the ELO row on the next load:
 *   • track_elo        — the ELO spine
 *   • focus_ratings    — star adjustments via the focus-rating path
 *   • seeds            — user-seeded tracks
 *   • ratings          — dive-rec star ratings for this user's dives
 */
router.delete("/rankings/track", async (req, res): Promise<void> => {
  const userId = Number(req.query.userId);
  const mbid   = String(req.query.mbid ?? "").trim();
  if (!userId || !mbid) {
    res.status(400).json({ error: "userId and mbid required" });
    return;
  }

  // Find all recommendation IDs for this mbid belonging to this user's dives.
  const userRecIds = await db
    .select({ id: recommendationsTable.id })
    .from(recommendationsTable)
    .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
    .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
    .where(and(eq(divesTable.userId, userId), eq(recommendationsTable.mbid, mbid)))
    .catch(() => []);

  const recIds = userRecIds.map((r) => r.id);

  await Promise.all([
    // Dive-rec ratings
    recIds.length > 0
      ? db.delete(ratingsTable).where(inArray(ratingsTable.recId, recIds)).catch(() => {})
      : Promise.resolve(),
    // Focus ratings (mbid-keyed write path)
    db.delete(focusRatingsTable)
      .where(and(eq(focusRatingsTable.userId, userId), eq(focusRatingsTable.mbid, mbid)))
      .catch(() => {}),
    // Seeds
    db.delete(seedsTable)
      .where(and(eq(seedsTable.userId, userId), eq(seedsTable.mbid, mbid)))
      .catch(() => {}),
    // ELO spine
    db.delete(trackEloTable)
      .where(and(eq(trackEloTable.userId, userId), eq(trackEloTable.mbid, mbid)))
      .catch(() => {}),
  ]);

  res.json({ deleted: true, mbid });
});

export default router;
