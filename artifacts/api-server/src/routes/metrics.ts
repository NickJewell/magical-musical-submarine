import { Router, type IRouter } from "express";
import { db, divesTable, diveStepsTable, recommendationsTable, ratingsTable, pathRatingsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { GetMetricsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

// GET /metrics — discovery dashboard
router.get("/metrics", async (req, res): Promise<void> => {
  const parsed = GetMetricsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = parsed.data;

  const dives = await db.select().from(divesTable).where(eq(divesTable.userId, userId));
  const diveIds = dives.map((d) => d.id);

  if (diveIds.length === 0) {
    res.json({ byArm: [], byDive: [], overallDiscoveryRate: null, totalRatedRecs: 0 });
    return;
  }

  // Get all steps for this user's dives
  const allSteps = await Promise.all(
    diveIds.map((id) =>
      db.select().from(diveStepsTable).where(eq(diveStepsTable.diveId, id))
    )
  ).then((r) => r.flat());

  const stepIds = allSteps.map((s) => s.id);

  if (stepIds.length === 0) {
    res.json({ byArm: [], byDive: [], overallDiscoveryRate: null, totalRatedRecs: 0 });
    return;
  }

  // Get all recs
  const allRecs = await Promise.all(
    stepIds.map((id) =>
      db.select().from(recommendationsTable).where(eq(recommendationsTable.diveStepId, id))
    )
  ).then((r) => r.flat());

  // Get latest rating per rec
  const recRatings = await Promise.all(
    allRecs.map(async (rec) => {
      const ratings = await db
        .select()
        .from(ratingsTable)
        .where(eq(ratingsTable.recId, rec.id))
        .orderBy(desc(ratingsTable.ratedAt))
        .limit(1);
      return { rec, rating: ratings[0] ?? null };
    })
  );

  const rated = recRatings.filter((r) => r.rating !== null && r.rating.listenState !== "skipped");

  // Group by arm
  const armGroups: Record<string, { scores: number[]; newCount: number; knownCount: number }> = {};

  for (const { rec, rating } of rated) {
    if (!rating) continue;
    const arm =
      rec.arm === "well_trodden"
        ? "CF-control"
        : rec.likelyKnown === "high" || rating.listenState === "known"
        ? "LLM-known"
        : "LLM-new";

    if (!armGroups[arm]) armGroups[arm] = { scores: [], newCount: 0, knownCount: 0 };

    if (rating.score != null) {
      armGroups[arm].scores.push(parseFloat(String(rating.score)));
    }
    if (rating.listenState === "known") armGroups[arm].knownCount++;
    else armGroups[arm].newCount++;
  }

  const byArm = Object.entries(armGroups).map(([arm, g]) => {
    const total = g.newCount + g.knownCount;
    const avgScore = g.scores.length > 0 ? g.scores.reduce((a, b) => a + b, 0) / g.scores.length : null;
    return {
      arm,
      count: rated.filter((r) => {
        const a = r.rec.arm === "well_trodden" ? "CF-control" : r.rec.likelyKnown === "high" || r.rating?.listenState === "known" ? "LLM-known" : "LLM-new";
        return a === arm;
      }).length,
      avgScore: avgScore !== null ? Math.round(avgScore * 10) / 10 : null,
      discoveryRate: total > 0 ? Math.round((g.newCount / total) * 100) / 100 : null,
      knownRate: total > 0 ? Math.round((g.knownCount / total) * 100) / 100 : null,
    };
  });

  // Per-dive path ratings
  const byDive = await Promise.all(
    dives.map(async (dive) => {
      const steps = allSteps.filter((s) => s.diveId === dive.id);
      const pathRatingsList = await Promise.all(
        steps.map((s) =>
          db
            .select()
            .from(pathRatingsTable)
            .where(eq(pathRatingsTable.diveStepId, s.id))
            .orderBy(desc(pathRatingsTable.ratedAt))
            .limit(1)
        )
      ).then((r) => r.flat());

      const scores = pathRatingsList.map((r) => parseFloat(String(r.score)));
      const avgPathScore = scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;

      return {
        diveId: dive.id,
        diveName: dive.name,
        stepCount: steps.length,
        avgPathScore,
      };
    })
  );

  const llmNew = armGroups["LLM-new"];
  const totalNew = llmNew ? llmNew.newCount + llmNew.knownCount : 0;
  const overallDiscoveryRate = totalNew > 0 ? Math.round((llmNew!.newCount / totalNew) * 100) / 100 : null;

  res.json({
    byArm,
    byDive,
    overallDiscoveryRate,
    totalRatedRecs: rated.length,
  });
});

export default router;
