import { Router, type IRouter } from "express";
import { db, seedsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { AddSeedBody, SearchMusicQueryParams, ListSeedsQueryParams } from "@workspace/api-zod";
import { searchMusicBrainz } from "../lib/musicbrainz";

const router: IRouter = Router();

// GET /search — MusicBrainz search
router.get("/search", async (req, res): Promise<void> => {
  const parsed = SearchMusicQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { q, type = "track", page = 1 } = parsed.data;

  try {
    const results = await searchMusicBrainz(q, type as "track" | "album" | "artist", page);
    res.json(results);
  } catch (err) {
    res.status(503).json({ error: "Search timed out, please try again" });
  }
});

// POST /seed — add a seed
router.post("/seed", async (req, res): Promise<void> => {
  const parsed = AddSeedBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId, mbid, type, title, artist, year, prompt } = parsed.data;

  // Dedup: don't add same mbid twice for same user
  const existing = await db
    .select()
    .from(seedsTable)
    .where(eq(seedsTable.userId, userId))
    .then((rows) => rows.find((r) => r.mbid === mbid));

  if (existing) {
    res.status(201).json({
      id: existing.id,
      userId: existing.userId,
      mbid: existing.mbid,
      type: existing.type,
      title: existing.title,
      artist: existing.artist,
      year: existing.year ?? null,
      prompt: existing.prompt ?? null,
      createdAt: existing.createdAt.toISOString(),
    });
    return;
  }

  const [seed] = await db
    .insert(seedsTable)
    .values({ userId, mbid, type, title, artist, year: year ?? null, prompt: prompt ?? null })
    .returning();

  res.status(201).json({
    id: seed.id,
    userId: seed.userId,
    mbid: seed.mbid,
    type: seed.type,
    title: seed.title,
    artist: seed.artist,
    year: seed.year ?? null,
    prompt: seed.prompt ?? null,
    createdAt: seed.createdAt.toISOString(),
  });
});

// GET /seeds — list seeds for user
router.get("/seeds", async (req, res): Promise<void> => {
  const parsed = ListSeedsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = parsed.data;

  const seeds = await db.select().from(seedsTable).where(eq(seedsTable.userId, userId));
  res.json(
    seeds.map((s) => ({
      id: s.id,
      userId: s.userId,
      mbid: s.mbid,
      type: s.type,
      title: s.title,
      artist: s.artist,
      year: s.year ?? null,
      prompt: s.prompt ?? null,
      createdAt: s.createdAt.toISOString(),
    }))
  );
});

export default router;
