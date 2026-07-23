import { Router, type IRouter } from "express";
import { db, divesTable, diveStepsTable, recommendationsTable, ratingsTable, pathRatingsTable, portraitsTable, seedsTable, tasteEventsTable } from "@workspace/db";
import { eq, desc, count, and } from "drizzle-orm";
import {
  CreateDiveBody,
  ListDivesQueryParams,
  GetDirectionsBody,
  ChooseStepBody,
  GetRecommendationsBody,
  LoadRecapQueryParams,
} from "@workspace/api-zod";
import { directions } from "../lib/directions";
import { recommend } from "../lib/recommend";

const router: IRouter = Router();

function formatDive(d: typeof divesTable.$inferSelect, stepCount: number) {
  return {
    id: d.id,
    userId: d.userId,
    name: d.name,
    status: d.status,
    stepCount,
    createdAt: d.createdAt.toISOString(),
  };
}

// POST /dive
router.post("/dive", async (req, res): Promise<void> => {
  const parsed = CreateDiveBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId, name } = parsed.data;

  // Archive any existing active dives
  const activeDives = await db
    .select()
    .from(divesTable)
    .where(and(eq(divesTable.userId, userId), eq(divesTable.status, "active")));

  for (const d of activeDives) {
    await db.update(divesTable).set({ status: "archived" }).where(eq(divesTable.id, d.id));
  }

  const [dive] = await db.insert(divesTable).values({ userId, name, status: "active" }).returning();
  res.status(201).json(formatDive(dive, 0));
});

// GET /dive — list dives
router.get("/dive", async (req, res): Promise<void> => {
  const parsed = ListDivesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = parsed.data;

  const dives = await db
    .select()
    .from(divesTable)
    .where(eq(divesTable.userId, userId))
    .orderBy(desc(divesTable.createdAt));

  const result = await Promise.all(
    dives.map(async (d) => {
      const [sc] = await db.select({ count: count() }).from(diveStepsTable).where(eq(diveStepsTable.diveId, d.id));
      return formatDive(d, Number(sc.count));
    })
  );

  res.json(result);
});

// GET /dive/detail — dive detail (query params: diveId + userId, both required)
// NOTE: Must be registered BEFORE any wildcard /dive/:id routes to avoid shadowing.
router.get("/dive/detail", async (req, res): Promise<void> => {
  const rawDiveId = req.query.diveId;
  const rawUserId = req.query.userId;

  if (!rawDiveId || !rawUserId) {
    res.status(400).json({ error: "diveId and userId query parameters are required" });
    return;
  }
  const diveId = parseInt(String(rawDiveId), 10);
  const requestUserId = parseInt(String(rawUserId), 10);
  if (isNaN(diveId) || isNaN(requestUserId)) {
    res.status(400).json({ error: "Invalid diveId or userId" });
    return;
  }

  const [dive] = await db.select().from(divesTable).where(eq(divesTable.id, diveId)).limit(1);
  if (!dive) {
    res.status(404).json({ error: "Dive not found" });
    return;
  }
  if (dive.userId !== requestUserId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const steps = await db
    .select()
    .from(diveStepsTable)
    .where(eq(diveStepsTable.diveId, diveId))
    .orderBy(diveStepsTable.seq);

  const stepsWithRecs = await Promise.all(
    steps.map(async (step) => {
      const recs = await db
        .select()
        .from(recommendationsTable)
        .where(eq(recommendationsTable.diveStepId, step.id));

      const recsWithRatings = await Promise.all(
        recs.map(async (rec) => {
          const ratings = await db
            .select()
            .from(ratingsTable)
            .where(eq(ratingsTable.recId, rec.id))
            .orderBy(desc(ratingsTable.ratedAt))
            .limit(1);
          const latestRating = ratings[0] ?? null;
          return {
            id: rec.id,
            diveStepId: rec.diveStepId,
            type: rec.type,
            mbid: rec.mbid,
            title: rec.title,
            artist: rec.artist,
            year: rec.year ?? null,
            narrativeText: rec.narrativeText ?? null,
            linksJson: rec.linksJson ?? null,
            artworkUrl: rec.artworkUrl ?? null,
            arm: rec.arm,
            likelyKnown: rec.likelyKnown ?? null,
            latestRating: latestRating
              ? {
                  id: latestRating.id,
                  recId: latestRating.recId,
                  listenState: latestRating.listenState,
                  score: latestRating.score != null ? parseFloat(String(latestRating.score)) : null,
                  ratedAt: latestRating.ratedAt.toISOString(),
                }
              : null,
            createdAt: rec.createdAt.toISOString(),
          };
        })
      );

      const [pathRating] = await db
        .select()
        .from(pathRatingsTable)
        .where(eq(pathRatingsTable.diveStepId, step.id))
        .orderBy(desc(pathRatingsTable.ratedAt))
        .limit(1);

      return {
        id: step.id,
        diveId: step.diveId,
        seq: step.seq,
        hypothesisText: step.hypothesisText ?? null,
        directionsJson: step.directionsJson ?? null,
        chosenDirection: step.chosenDirection ?? null,
        recommendations: recsWithRatings,
        pathRating: pathRating
          ? {
              id: pathRating.id,
              diveStepId: pathRating.diveStepId,
              score: parseFloat(String(pathRating.score)),
              ratedAt: pathRating.ratedAt.toISOString(),
            }
          : null,
        createdAt: step.createdAt.toISOString(),
      };
    })
  );

  res.json({
    id: dive.id,
    userId: dive.userId,
    name: dive.name,
    status: dive.status,
    steps: stepsWithRecs,
    createdAt: dive.createdAt.toISOString(),
  });
});

// GET /recap — previously-on recap
router.get("/recap", async (req, res): Promise<void> => {
  const parsed = LoadRecapQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { diveId, userId } = parsed.data;

  // Ownership check: verify the dive belongs to this user
  const [dive] = await db.select().from(divesTable).where(eq(divesTable.id, diveId)).limit(1);
  if (!dive) {
    res.status(404).json({ error: "Dive not found" });
    return;
  }
  if (dive.userId !== userId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const steps = await db
    .select()
    .from(diveStepsTable)
    .where(eq(diveStepsTable.diveId, diveId))
    .orderBy(diveStepsTable.seq);

  if (steps.length === 0) {
    res.json({ recap: "This is the start of your dive.", stepCount: 0, avgScore: null });
    return;
  }

  // Build recap from prior steps
  const stepSummaries: string[] = [];
  let totalScore = 0;
  let scoreCount = 0;

  for (const step of steps) {
    const recs = await db
      .select()
      .from(recommendationsTable)
      .where(and(eq(recommendationsTable.diveStepId, step.id), eq(recommendationsTable.arm, "llm")));

    const ratings = await Promise.all(
      recs.map(async (rec) => {
        const r = await db
          .select()
          .from(ratingsTable)
          .where(eq(ratingsTable.recId, rec.id))
          .orderBy(desc(ratingsTable.ratedAt))
          .limit(1);
        return { rec, rating: r[0] ?? null };
      })
    );

    const ratedRecs = ratings.filter((r) => r.rating !== null);
    const scored = ratedRecs.filter((r) => r.rating?.score != null);
    for (const r of scored) {
      totalScore += parseFloat(String(r.rating!.score));
      scoreCount++;
    }

    const dirName = step.chosenDirection ?? "unknown direction";
    const recSummary = ratedRecs
      .map((r) => {
        const state = r.rating?.listenState ?? "unrated";
        const score = r.rating?.score != null ? ` (${r.rating.score}/5)` : "";
        return `"${r.rec.title}" by ${r.rec.artist} — ${state}${score}`;
      })
      .join(", ");

    stepSummaries.push(`Step ${step.seq}: explored "${dirName}". Heard: ${recSummary || "nothing rated yet"}.`);
  }

  const avgScore = scoreCount > 0 ? Math.round((totalScore / scoreCount) * 10) / 10 : null;
  const recap = `Previously on your dive:\n${stepSummaries.join("\n")}`;

  res.json({ recap, stepCount: steps.length, avgScore });
});

// POST /directions — generate LLM directions
router.post("/directions", async (req, res): Promise<void> => {
  const parsed = GetDirectionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId, diveId } = parsed.data;

  // Ownership check: diveId must belong to userId
  const [dirDive] = await db.select().from(divesTable).where(eq(divesTable.id, diveId)).limit(1);
  if (!dirDive) {
    res.status(404).json({ error: "Dive not found" });
    return;
  }
  if (dirDive.userId !== userId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const result = await directions({ userId, diveId });
  res.json(result);
});

// POST /step — record chosen direction
router.post("/step", async (req, res): Promise<void> => {
  const parsed = ChooseStepBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId: stepUserId, diveId, chosenDirection, hypothesisText, directionsJson } = parsed.data;

  // Ownership check: userId is now required in the validated body schema
  const [ownerDive] = await db.select().from(divesTable).where(eq(divesTable.id, diveId)).limit(1);
  if (!ownerDive) {
    res.status(404).json({ error: "Dive not found" });
    return;
  }
  if (ownerDive.userId !== stepUserId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const existingSteps = await db
    .select({ count: count() })
    .from(diveStepsTable)
    .where(eq(diveStepsTable.diveId, diveId));

  const seq = Number(existingSteps[0].count) + 1;

  const [step] = await db
    .insert(diveStepsTable)
    .values({
      diveId,
      seq,
      chosenDirection,
      hypothesisText,
      directionsJson: directionsJson as Record<string, unknown>,
    })
    .returning();

  res.status(201).json({
    id: step.id,
    diveId: step.diveId,
    seq: step.seq,
    hypothesisText: step.hypothesisText ?? null,
    directionsJson: step.directionsJson ?? null,
    chosenDirection: step.chosenDirection ?? null,
    recommendations: [],
    pathRating: null,
    createdAt: step.createdAt.toISOString(),
  });
});

// POST /recommend — run pipeline
router.post("/recommend", async (req, res): Promise<void> => {
  const parsed = GetRecommendationsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { stepId, userId } = parsed.data;

  // Ownership check: verify step→dive→userId chain
  const [step] = await db.select().from(diveStepsTable).where(eq(diveStepsTable.id, stepId)).limit(1);
  if (!step) {
    res.status(404).json({ error: "Step not found" });
    return;
  }
  const [stepDive] = await db.select().from(divesTable).where(eq(divesTable.id, step.diveId)).limit(1);
  if (!stepDive || stepDive.userId !== userId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const recs = await recommend({ stepId, userId });
  res.json(recs);
});

export default router;
