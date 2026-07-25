import { Router, type IRouter } from "express";
import { db, seedsTable, tasteEventsTable, recommendationsTable, ratingsTable, diveStepsTable, divesTable } from "@workspace/db";
import { eq, desc, and, inArray } from "drizzle-orm";
import { GetNextPairQueryParams, SubmitPairBody } from "@workspace/api-zod";
import { applyComparison } from "../lib/elo";

const router: IRouter = Router();

// GET /onboarding/next-pair — discriminative pair selection
router.get("/onboarding/next-pair", async (req, res): Promise<void> => {
  const parsed = GetNextPairQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = parsed.data;

  const seeds = await db.select().from(seedsTable).where(eq(seedsTable.userId, userId));
  if (seeds.length < 2) {
    res.json({ done: true, aMbid: null, aTitle: null, aArtist: null, bMbid: null, bTitle: null, bArtist: null, pairIndex: null, totalPairs: null });
    return;
  }

  // Get already-submitted pairs
  const events = await db
    .select()
    .from(tasteEventsTable)
    .where(eq(tasteEventsTable.userId, userId))
    .then((rows) => rows.filter((r) => r.kind === "pair_choice"));

  const donePairs = new Set<string>(
    events.map((e) => {
      const p = e.payloadJson as { aMbid?: string; bMbid?: string };
      return `${p.aMbid}:${p.bMbid}`;
    })
  );

  // Build candidate pairs (up to 10 total)
  const maxPairs = Math.min(10, Math.floor(seeds.length * (seeds.length - 1) / 2));
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < seeds.length && pairs.length < maxPairs; i++) {
    for (let j = i + 1; j < seeds.length && pairs.length < maxPairs; j++) {
      const key = `${seeds[i].mbid}:${seeds[j].mbid}`;
      if (!donePairs.has(key)) {
        pairs.push([i, j]);
      }
    }
  }

  if (pairs.length === 0) {
    res.json({ done: true, aMbid: null, aTitle: null, aArtist: null, bMbid: null, bTitle: null, bArtist: null, pairIndex: null, totalPairs: null });
    return;
  }

  const [i, j] = pairs[0];
  const a = seeds[i];
  const b = seeds[j];
  const pairIndex = donePairs.size;
  const totalPairs = Math.min(maxPairs, donePairs.size + pairs.length);

  res.json({
    done: false,
    aMbid: a.mbid,
    aTitle: a.title,
    aArtist: a.artist,
    bMbid: b.mbid,
    bTitle: b.title,
    bArtist: b.artist,
    pairIndex,
    totalPairs,
  });
});

// GET /taste-pair — random pair from post-onboarding rated recs (continuous taste refinement)
router.get("/taste-pair", async (req, res): Promise<void> => {
  const parsed = GetNextPairQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = parsed.data;

  // Previously compared pairs
  const events = await db.select().from(tasteEventsTable)
    .where(eq(tasteEventsTable.userId, userId));
  const donePairs = new Set<string>(
    events
      .filter(r => r.kind === "pair_choice")
      .map(e => {
        const p = e.payloadJson as { aMbid?: string; bMbid?: string };
        return `${p.aMbid}:${p.bMbid}`;
      })
  );

  // Rated recs (listened / known) for this user
  const ratedRows = await db
    .select({
      mbid: recommendationsTable.mbid,
      title: recommendationsTable.title,
      artist: recommendationsTable.artist,
      ratedAt: ratingsTable.ratedAt,
    })
    .from(recommendationsTable)
    .innerJoin(ratingsTable, eq(ratingsTable.recId, recommendationsTable.id))
    .innerJoin(diveStepsTable, eq(diveStepsTable.id, recommendationsTable.diveStepId))
    .innerJoin(divesTable, and(eq(divesTable.id, diveStepsTable.diveId), eq(divesTable.userId, userId)))
    .where(inArray(ratingsTable.listenState, ["listened", "known"]))
    .orderBy(desc(ratingsTable.ratedAt));

  // Deduplicate by mbid
  const seen = new Set<string>();
  const candidates: Array<{ mbid: string; title: string; artist: string }> = [];
  for (const r of ratedRows) {
    if (!seen.has(r.mbid)) { seen.add(r.mbid); candidates.push(r); }
  }

  // Fall back to seeds if fewer than 2 rated recs
  if (candidates.length < 2) {
    const seeds = await db.select().from(seedsTable).where(eq(seedsTable.userId, userId));
    for (const s of seeds) {
      if (!seen.has(s.mbid)) { seen.add(s.mbid); candidates.push(s); }
    }
  }

  const done = { done: true, aMbid: null, aTitle: null, aArtist: null, bMbid: null, bTitle: null, bArtist: null, pairIndex: null, totalPairs: null };
  if (candidates.length < 2) { res.json(done); return; }

  // Shuffle and pick first unpaired pair
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  let a: typeof candidates[0] | null = null;
  let b: typeof candidates[0] | null = null;
  outer: for (let i = 0; i < shuffled.length; i++) {
    for (let j = i + 1; j < shuffled.length; j++) {
      const key = `${shuffled[i].mbid}:${shuffled[j].mbid}`;
      const rev = `${shuffled[j].mbid}:${shuffled[i].mbid}`;
      if (!donePairs.has(key) && !donePairs.has(rev)) { a = shuffled[i]; b = shuffled[j]; break outer; }
    }
  }

  if (!a || !b) { res.json(done); return; }

  res.json({ done: false, aMbid: a.mbid, aTitle: a.title, aArtist: a.artist, bMbid: b.mbid, bTitle: b.title, bArtist: b.artist, pairIndex: null, totalPairs: null });
});

// POST /pair — record pair choice
router.post("/pair", async (req, res): Promise<void> => {
  const parsed = SubmitPairBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId, aMbid, bMbid, result } = parsed.data;

  await db.insert(tasteEventsTable).values({
    userId,
    kind: "pair_choice",
    payloadJson: { aMbid, bMbid, result },
  });

  // Update head-to-head ELO for both tracks (never throws).
  await applyComparison({ userId, aMbid, bMbid, result });

  res.json({ ok: true });
});

export default router;
