import { Router, type IRouter } from "express";
import { db, ratingsTable, pathRatingsTable, tasteEventsTable, recommendationsTable, diveStepsTable, divesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { RateRecBody, RateStepBody } from "@workspace/api-zod";

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

export default router;
