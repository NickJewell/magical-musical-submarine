import { Router, type IRouter } from "express";
import { db, ratingsTable, pathRatingsTable, focusRatingsTable, tasteEventsTable, recommendationsTable, diveStepsTable, divesTable } from "@workspace/db";
import { eq, desc, count, and } from "drizzle-orm";
import { RateRecBody, RateStepBody } from "@workspace/api-zod";
import { triggerPortraitRebuild } from "../lib/portraitGen";
import { triggerTastingNoteGeneration } from "../lib/tastingNoteGen";

const router: IRouter = Router();

// POST /rate — rate a recommendation
router.post("/rate", async (req, res): Promise<void> => {
  const parsed = RateRecBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId, recId, listenState, score, reviewText } = parsed.data;

  // Ownership chain: rec → step → dive → userId
  const [rec] = await db
    .select()
    .from(recommendationsTable)
    .where(eq(recommendationsTable.id, recId))
    .limit(1);
  if (!rec) {
    res.status(404).json({ error: "Recommendation not found" });
    return;
  }
  const [step] = await db
    .select()
    .from(diveStepsTable)
    .where(eq(diveStepsTable.id, rec.diveStepId))
    .limit(1);
  if (!step) {
    res.status(404).json({ error: "Dive step not found" });
    return;
  }
  const [dive] = await db
    .select()
    .from(divesTable)
    .where(eq(divesTable.id, step.diveId))
    .limit(1);
  if (!dive || dive.userId !== userId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // Validate score is 1, 2, or 3
  if (score != null) {
    if (![1, 2, 3].includes(score)) {
      res.status(400).json({ error: "Score must be 1, 2, or 3" });
      return;
    }
  }

  const [rating] = await db
    .insert(ratingsTable)
    .values({
      recId,
      listenState,
      score: score != null ? String(score) : null,
      reviewText: reviewText ?? null,
    })
    .returning();

  // Mirror to taste_events
  await db.insert(tasteEventsTable).values({
    userId,
    kind: "rating",
    payloadJson: { recId, listenState, score, reviewText: reviewText ?? null },
  });

  // Every 3rd rating — rebuild portrait in the background
  const ratingCountRows = await db
    .select({ cnt: count() })
    .from(tasteEventsTable)
    .where(eq(tasteEventsTable.userId, userId));
  const totalEvents = Number(ratingCountRows[0]?.cnt ?? 0);
  if (totalEvents > 0 && totalEvents % 3 === 0) {
    triggerPortraitRebuild(userId);
  }

  // Auto-generate tasting note once ≥3 tracks on this leg are rated (if none exists yet).
  // The helper checks the count internally and is a no-op when the note already exists.
  if (!step.tastingNote) {
    triggerTastingNoteGeneration(rec.diveStepId);
  }

  res.status(201).json({
    id: rating.id,
    recId: rating.recId,
    listenState: rating.listenState,
    score: rating.score != null ? parseFloat(String(rating.score)) : null,
    reviewText: rating.reviewText ?? null,
    ratedAt: rating.ratedAt.toISOString(),
  });
});

// POST /path-rate — rate a dive step
router.post("/path-rate", async (req, res): Promise<void> => {
  const parsed = RateStepBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId, diveStepId, score } = parsed.data;

  // Ownership chain: step → dive → userId
  const [step] = await db
    .select()
    .from(diveStepsTable)
    .where(eq(diveStepsTable.id, diveStepId))
    .limit(1);
  if (!step) {
    res.status(404).json({ error: "Dive step not found" });
    return;
  }
  const [dive] = await db
    .select()
    .from(divesTable)
    .where(eq(divesTable.id, step.diveId))
    .limit(1);
  if (!dive || dive.userId !== userId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // Validate score is 1, 2, or 3
  if (![1, 2, 3].includes(score)) {
    res.status(400).json({ error: "Score must be 1, 2, or 3" });
    return;
  }

  const [pathRating] = await db
    .insert(pathRatingsTable)
    .values({ diveStepId, score: String(score) })
    .returning();

  // Mirror to taste_events
  await db.insert(tasteEventsTable).values({
    userId,
    kind: "path_rating",
    payloadJson: { diveStepId, score },
  });

  res.status(201).json({
    id: pathRating.id,
    diveStepId: pathRating.diveStepId,
    score: parseFloat(String(pathRating.score)),
    ratedAt: pathRating.ratedAt.toISOString(),
  });
});

// GET /focus-rating — fetch an existing focus rating for a (userId, mbid) pair
router.get("/focus-rating", async (req, res): Promise<void> => {
  const userId = parseInt(String(req.query.userId ?? ""), 10);
  const mbid = String(req.query.mbid ?? "").trim();

  if (isNaN(userId) || !mbid) {
    res.status(400).json({ error: "userId and mbid are required" });
    return;
  }

  const [row] = await db
    .select()
    .from(focusRatingsTable)
    .where(and(eq(focusRatingsTable.userId, userId), eq(focusRatingsTable.mbid, mbid)))
    .orderBy(desc(focusRatingsTable.ratedAt))
    .limit(1);

  if (!row) {
    res.json(null);
    return;
  }

  res.json({
    id: row.id,
    userId: row.userId,
    mbid: row.mbid,
    title: row.title,
    artist: row.artist,
    listenState: row.listenState,
    score: row.score != null ? parseFloat(String(row.score)) : null,
    reviewText: row.reviewText ?? null,
    ratedAt: row.ratedAt.toISOString(),
  });
});

// POST /focus-rating — create or update a focus rating (upsert by userId + mbid)
router.post("/focus-rating", async (req, res): Promise<void> => {
  const { userId, mbid, title, artist, listenState, score, reviewText } = req.body as {
    userId?: unknown; mbid?: unknown; title?: unknown; artist?: unknown;
    listenState?: unknown; score?: unknown; reviewText?: unknown;
  };

  if (typeof userId !== "number" || typeof mbid !== "string" || !mbid.trim() ||
      typeof title !== "string" || typeof artist !== "string" ||
      typeof listenState !== "string" || !["listened", "skipped", "known"].includes(listenState)) {
    res.status(400).json({ error: "userId, mbid, title, artist, and a valid listenState are required" });
    return;
  }

  const parsedScore = score != null ? Number(score) : null;
  if (parsedScore != null && ![1, 2, 3].includes(parsedScore)) {
    res.status(400).json({ error: "score must be 1, 2, or 3" });
    return;
  }

  // Upsert: delete any existing row for this (userId, mbid) then insert fresh.
  await db
    .delete(focusRatingsTable)
    .where(and(eq(focusRatingsTable.userId, userId as number), eq(focusRatingsTable.mbid, mbid)));

  const [row] = await db
    .insert(focusRatingsTable)
    .values({
      userId: userId as number,
      mbid,
      title,
      artist,
      listenState,
      score: parsedScore != null ? String(parsedScore) : null,
      reviewText: typeof reviewText === "string" && reviewText.trim() ? reviewText.trim() : null,
    })
    .returning();

  // Mirror to taste_events so the portrait pipeline sees it
  await db.insert(tasteEventsTable).values({
    userId: userId as number,
    kind: "focus_rating",
    payloadJson: { mbid, title, artist, listenState, score: parsedScore, reviewText: reviewText ?? null },
  });

  // Trigger portrait rebuild on every 3rd taste event (same cadence as rec ratings)
  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(tasteEventsTable)
    .where(eq(tasteEventsTable.userId, userId as number));
  if (Number(cnt) > 0 && Number(cnt) % 3 === 0) {
    triggerPortraitRebuild(userId as number);
  }

  res.status(201).json({
    id: row.id,
    userId: row.userId,
    mbid: row.mbid,
    title: row.title,
    artist: row.artist,
    listenState: row.listenState,
    score: row.score != null ? parseFloat(String(row.score)) : null,
    reviewText: row.reviewText ?? null,
    ratedAt: row.ratedAt.toISOString(),
  });
});

export default router;
