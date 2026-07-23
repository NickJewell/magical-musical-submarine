import { Router, type IRouter } from "express";
import { db, seedsTable, tasteEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetNextPairQueryParams, SubmitPairBody } from "@workspace/api-zod";

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

  res.json({ ok: true });
});

export default router;
