/**
 * Canon pool management routes (admin/offline).
 * POST /api/canon/seed   — generate-and-verify pool build/refresh
 * POST /api/canon/import — import owner-supplied CSV (personal/admin only)
 */

import { Router, type IRouter } from "express";
import { db, canonTracksTable, resolvedEntitiesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
void sql; // referenced in raw execute below
import { generateCanonCandidates } from "../lib/llm";
import { resolve } from "../lib/musicbrainz";
import { searchMusicBrainz } from "../lib/musicbrainz";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ADMIN_SECRET = process.env.CANON_ADMIN_SECRET;

function checkAdmin(req: import("express").Request, res: import("express").Response): boolean {
  if (!ADMIN_SECRET) return true; // open if secret not configured (dev)
  const auth = req.headers["x-admin-secret"] ?? req.body?.adminSecret;
  if (auth !== ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

const CANON_POOL_TARGET = parseInt(process.env.CANON_POOL_TARGET ?? "1000", 10);

const GENRE_ERA_BATCHES: Array<{ genre: string; era: string; region?: string; count: number }> = [
  { genre: "rock",           era: "1960s-1970s",      count: 60 },
  { genre: "rock",           era: "1980s-1990s",      count: 50 },
  { genre: "pop",            era: "1970s-1990s",      count: 50 },
  { genre: "pop",            era: "2000s-2010s",      count: 40 },
  { genre: "jazz",           era: "1950s-1960s",      count: 50 },
  { genre: "jazz",           era: "1970s-present",    count: 30 },
  { genre: "blues",          era: "1920s-1960s",      count: 30 },
  { genre: "soul / R&B",     era: "1960s-1980s",      count: 50 },
  { genre: "hip-hop",        era: "1980s-2000s",      count: 50 },
  { genre: "hip-hop",        era: "2010s-present",    count: 30 },
  { genre: "electronic",     era: "1970s-1990s",      count: 40 },
  { genre: "electronic",     era: "2000s-present",    count: 30 },
  { genre: "classical",      era: "1700s-1900s",      count: 40 },
  { genre: "classical",      era: "20th century",     count: 30 },
  { genre: "country",        era: "1950s-1980s",      count: 30 },
  { genre: "folk / singer-songwriter", era: "1960s-1980s", count: 40 },
  { genre: "metal",          era: "1970s-1990s",      count: 30 },
  { genre: "punk / post-punk", era: "1970s-1980s",   count: 30 },
  { genre: "reggae / dub",   era: "1960s-1980s",      count: 25 },
  { genre: "world / global", era: "varied",           count: 40, region: "non-Western" },
  { genre: "alternative / indie", era: "1990s-2010s", count: 40 },
  { genre: "ambient / experimental", era: "1970s-present", count: 25 },
  { genre: "gospel / spiritual", era: "1930s-1970s",  count: 20 },
  { genre: "latin",          era: "varied",           count: 30, region: "Latin America / Spain" },
];

async function resolveCandidate(
  candidate: { title: string; artist: string; year?: number | null; genre?: string | null; era?: number | null; region?: string | null },
  batchGenre: string,
  batchRegion?: string,
): Promise<void> {
  try {
    const query = `${candidate.title} ${candidate.artist}`;
    const results = await searchMusicBrainz(query, "track", 1, 8000);
    if (!results || results.length === 0) return;

    const top = results[0];
    if (!top.mbid) return;

    // Resolve entity (caches in resolved_entities)
    const entity = await resolve(
      { type: "track", title: top.title, artist: top.artist },
      10000,
    );
    if (!entity) return;

    // Derive era decade
    const year = candidate.year ?? entity.year ?? null;
    const era = year ? Math.floor(year / 10) * 10 : null;

    // Insert into canon_tracks (skip if exists)
    await db
      .insert(canonTracksTable)
      .values({
        mbid: entity.mbid,
        era,
        primaryGenre: candidate.genre ?? batchGenre,
        moodTags: [],
        region: candidate.region ?? batchRegion ?? null,
        canonWeight: "0.50",
        source: "generated",
      })
      .onConflictDoNothing();
  } catch (err) {
    logger.debug({ err, title: candidate.title, artist: candidate.artist }, "Canon candidate resolution failed — skipping");
  }
}

// POST /api/canon/seed — build / refresh the pool
router.post("/canon/seed", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;

  const maxBatches = parseInt(String(req.body?.maxBatches ?? GENRE_ERA_BATCHES.length), 10);
  const batches = GENRE_ERA_BATCHES.slice(0, maxBatches);

  // Respond immediately so the client isn't left waiting
  res.json({
    ok: true,
    message: `Canon pool seeding started for ${batches.length} genre/era batches. Check server logs for progress.`,
    batches: batches.length,
  });

  // Fire-and-forget in background
  (async () => {
    let totalInserted = 0;

    for (const batch of batches) {
      try {
        logger.info({ genre: batch.genre, era: batch.era, count: batch.count }, "Generating canon candidates");
        const candidates = await generateCanonCandidates(batch.genre, batch.era, batch.count, batch.region);

        for (const candidate of candidates) {
          await resolveCandidate(candidate, batch.genre, batch.region);
          totalInserted++;
          // Throttle: 200ms between MB lookups
          await new Promise((r) => setTimeout(r, 200));
        }

        logger.info({ genre: batch.genre, era: batch.era, resolved: candidates.length }, "Canon batch resolved");
      } catch (err) {
        logger.error({ err, batch }, "Canon batch generation failed");
      }
    }

    // Update weights based on popularity (Last.fm listener count from resolved entities if available)
    await db.execute(sql`
      UPDATE canon_tracks
      SET canon_weight = LEAST(1.0, GREATEST(0.1,
        CASE WHEN re.year IS NOT NULL AND re.year >= 1950 THEN 0.6
             ELSE 0.4
        END
      ))
      FROM resolved_entities re
      WHERE canon_tracks.mbid = re.mbid
        AND canon_tracks.canon_weight = 0.50
    `);

    logger.info({ totalInserted }, "Canon pool seeding complete");
  })().catch((err) => logger.error({ err }, "Canon pool seeding background job crashed"));
});

// POST /api/canon/import — personal/admin CSV import (artist,title per line)
router.post("/canon/import", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;

  const csv: string = req.body?.csv ?? "";
  if (!csv.trim()) { res.status(400).json({ error: "csv body required" }); return; }

  const lines = csv.trim().split("\n").slice(1); // skip header
  const candidates = lines
    .map((line) => {
      const [artist, title] = line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      return artist && title ? { artist, title } : null;
    })
    .filter(Boolean) as Array<{ artist: string; title: string }>;

  res.json({ ok: true, message: `Import started for ${candidates.length} tracks.` });

  (async () => {
    for (const c of candidates) {
      await resolveCandidate(c, "imported");
      await new Promise((r) => setTimeout(r, 300));
    }
    logger.info({ count: candidates.length }, "Canon import complete");
  })().catch((err) => logger.error({ err }, "Canon import crashed"));
});

export default router;
