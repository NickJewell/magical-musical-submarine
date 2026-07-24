/**
 * Canon Duel routes (§17).
 * GET  /api/duel/next  — return a verified A/B pair from the canon pool
 * POST /api/duel       — log outcome, apply seed promotion & discovery reservoir
 */

import { Router, type IRouter } from "express";
import { db, tasteEventsTable, seedsTable, resolvedEntitiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getNextDuelPair, type Strategy } from "../lib/canonPool";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// GET /api/duel/next?userId=&strategy=
router.get("/duel/next", async (req, res): Promise<void> => {
  const userId = parseInt(String(req.query.userId), 10);
  if (isNaN(userId)) { res.status(400).json({ error: "userId required" }); return; }

  const strategy = (String(req.query.strategy || "contrastive")) as Strategy;

  const pair = await getNextDuelPair(userId, strategy);
  if (!pair) {
    res.status(503).json({
      error: "canon_pool_empty",
      message: "No verified tracks available yet — run POST /api/canon/seed to build the pool.",
    });
    return;
  }

  // Fetch streaming links from resolved entities (linksJson lives in http_cache via /links route;
  // here we return what's already in resolved_entities and let the client resolve deep links lazily)
  res.json({
    aMbid: pair.a.mbid,
    aTitle: pair.a.title,
    aArtist: pair.a.artist,
    aYear: pair.a.year,
    aGenre: pair.a.primaryGenre,
    bMbid: pair.b.mbid,
    bTitle: pair.b.title,
    bArtist: pair.b.artist,
    bYear: pair.b.year,
    bGenre: pair.b.primaryGenre,
    strategy: pair.strategy,
  });
});

// POST /api/duel
router.post("/duel", async (req, res): Promise<void> => {
  const { userId, aMbid, bMbid, result, knewA, knewB, strategy = "contrastive" } = req.body as {
    userId: number; aMbid: string; bMbid: string;
    result: number; knewA: boolean; knewB: boolean; strategy?: string;
  };

  if (!userId || !aMbid || !bMbid || result === undefined || knewA === undefined || knewB === undefined) {
    res.status(400).json({ error: "userId, aMbid, bMbid, result, knewA, knewB required" });
    return;
  }
  if (result < -2 || result > 2 || !Number.isInteger(result)) {
    res.status(400).json({ error: "result must be integer -2..2" });
    return;
  }

  // Determine winner / loser
  // result < 0 → A wins, result > 0 → B wins, 0 → tie
  const winnerMbid = result < 0 ? aMbid : result > 0 ? bMbid : null;
  const loserMbid  = result < 0 ? bMbid : result > 0 ? aMbid : null;
  const winnerKnew = winnerMbid === aMbid ? knewA : knewB;

  // Log canon_duel taste_event
  await db.insert(tasteEventsTable).values({
    userId,
    kind: "canon_duel",
    payloadJson: {
      aMbid, bMbid, result, knewA, knewB, strategy,
      winnerMbid,
      isDiscoveryCandidate: winnerMbid !== null && !winnerKnew,
    },
  });

  const promotions: string[] = [];

  // Seed promotion: known + |result| >= 1
  if (winnerMbid && winnerKnew && Math.abs(result) >= 1) {
    const [entity] = await db
      .select()
      .from(resolvedEntitiesTable)
      .where(eq(resolvedEntitiesTable.mbid, winnerMbid))
      .limit(1);

    if (entity) {
      // Check user hasn't already seeded this
      const existing = await db
        .select()
        .from(seedsTable)
        .where(eq(seedsTable.userId, userId))
        .then((rows) => rows.find((s) => s.mbid === winnerMbid));

      if (!existing) {
        await db.insert(seedsTable).values({
          userId,
          mbid: winnerMbid,
          type: "track",
          title: entity.title ?? "",
          artist: entity.artist ?? "",
          year: entity.year ?? null,
          prompt: null, // no mood prompt — came from canon duel
          source: "canon_duel",
        }).catch((err) => logger.warn({ err }, "Seed promotion insert failed"));

        // Mirror as seed taste_event
        await db.insert(tasteEventsTable).values({
          userId,
          kind: "seed",
          payloadJson: { mbid: winnerMbid, source: "canon_duel", result, strategy },
        });

        promotions.push(winnerMbid);
      }
    }
  }

  res.status(201).json({
    ok: true,
    promotions,
    isDiscoveryCandidate: winnerMbid !== null && !winnerKnew,
  });
});

export default router;
