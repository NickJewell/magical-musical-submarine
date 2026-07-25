/**
 * Shared helper: rebuild and persist a user's taste portrait.
 * Called by both the portrait route (manual/regenerate) and the
 * rating route (auto-trigger every 3rd rating).
 */

import { db, seedsTable, portraitsTable, tasteEventsTable, ratingsTable, recommendationsTable } from "@workspace/db";
import { eq, desc, count } from "drizzle-orm";
import { createHash } from "node:crypto";
import { generatePortrait } from "./llm";
import { getEloSignal } from "./elo";
import { logger } from "./logger";

function computeSeedsHash(
  seeds: Array<{ title: string; artist: string; year?: number | null; prompt?: string | null }>,
  pairChoices: Array<{ winner: string; loser: string; strength: number }>,
  ratingCount: number,
): string {
  const payload = JSON.stringify({
    seeds: seeds.map((s) => ({
      title: s.title.trim().toLowerCase(),
      artist: s.artist.trim().toLowerCase(),
      year: s.year ?? null,
      prompt: s.prompt ?? null,
    })),
    pairs: pairChoices.map((p) => ({
      winner: p.winner.trim().toLowerCase(),
      loser: p.loser.trim().toLowerCase(),
      strength: p.strength,
    })),
    ratingCount,
  });
  return createHash("sha256").update(payload).digest("hex");
}

async function loadPairChoices(userId: number, seeds: typeof seedsTable.$inferSelect[]) {
  const pairEvents = await db
    .select()
    .from(tasteEventsTable)
    .where(eq(tasteEventsTable.userId, userId))
    .then((rows) => rows.filter((r) => r.kind === "pair_choice"));

  return pairEvents.map((e) => {
    const p = e.payloadJson as { aMbid?: string; bMbid?: string; result?: number };
    const aSeed = seeds.find((s) => s.mbid === p.aMbid);
    const bSeed = seeds.find((s) => s.mbid === p.bMbid);
    const result = p.result ?? 0;
    return {
      winner: result <= 0 ? (aSeed?.artist ?? "") : (bSeed?.artist ?? ""),
      loser:  result <= 0 ? (bSeed?.artist ?? "") : (aSeed?.artist ?? ""),
      strength: Math.abs(result),
    };
  });
}

async function loadRecentRatings(userId: number, limit = 30) {
  // Fetch recent taste_events of kind "rating" for this user, join to rec for track info
  const events = await db
    .select()
    .from(tasteEventsTable)
    .where(eq(tasteEventsTable.userId, userId))
    .orderBy(desc(tasteEventsTable.ts))
    .limit(limit * 3); // overfetch, filter below

  const ratingEvents = events.filter((e) => e.kind === "rating").slice(0, limit);

  const results: Array<{ title: string; artist: string; listenState: string; score: number | null; reviewText?: string | null }> = [];
  for (const ev of ratingEvents) {
    const payload = ev.payloadJson as { recId?: number; listenState?: string; score?: number | null; reviewText?: string | null };
    if (!payload.recId || !payload.listenState) continue;
    const [rec] = await db
      .select({ title: recommendationsTable.title, artist: recommendationsTable.artist })
      .from(recommendationsTable)
      .where(eq(recommendationsTable.id, payload.recId))
      .limit(1);
    if (!rec) continue;
    results.push({
      title: rec.title,
      artist: rec.artist,
      listenState: payload.listenState,
      score: payload.score != null ? Number(payload.score) : null,
      reviewText: payload.reviewText ?? null,
    });
  }
  return results;
}

export interface RebuildResult {
  text: string;
  version: number;
  seedsHash: string;
  cached: boolean;
}

export async function rebuildPortrait(userId: number, { force = false } = {}): Promise<RebuildResult | null> {
  const seeds = await db.select().from(seedsTable).where(eq(seedsTable.userId, userId));
  if (seeds.length === 0) return null; // nothing to portrait yet

  const pairChoices    = await loadPairChoices(userId, seeds);
  const recentRatings  = await loadRecentRatings(userId);

  const [ratingCountRow] = await db
    .select({ cnt: count() })
    .from(tasteEventsTable)
    .where(eq(tasteEventsTable.userId, userId));
  const ratingCount = Number(ratingCountRow?.cnt ?? 0);

  const seedsHash = computeSeedsHash(
    seeds.map((s) => ({ title: s.title, artist: s.artist, year: s.year, prompt: s.prompt })),
    pairChoices,
    ratingCount,
  );

  const existing = await db
    .select()
    .from(portraitsTable)
    .where(eq(portraitsTable.userId, userId))
    .orderBy(desc(portraitsTable.version))
    .limit(1);

  const latest = existing[0];

  if (!force && latest && latest.source === "llm" && latest.seedsHash === seedsHash) {
    return { text: latest.text, version: latest.version, seedsHash, cached: true };
  }

  // Head-to-head ELO signal: the tracks they've ranked strongest and weakest
  // in direct comparisons — the sharpest preference signal we have.
  const eloSignal = await getEloSignal(userId, 6);

  const text = await generatePortrait({
    seeds: seeds.map((s) => ({
      title: s.title,
      artist: s.artist,
      year: s.year ?? null,
      prompt: s.prompt ?? null,
    })),
    pairChoices,
    recentRatings,
    eloTop: eloSignal.top.map((t) => ({ title: t.title, artist: t.artist, rating: t.rating })),
    eloBottom: eloSignal.bottom.map((t) => ({ title: t.title, artist: t.artist, rating: t.rating })),
    priorPortrait: latest?.text ?? null,
  });

  const nextVersion = latest ? latest.version + 1 : 1;
  await db.insert(portraitsTable).values({ userId, version: nextVersion, text, source: "llm", seedsHash });
  return { text, version: nextVersion, seedsHash, cached: false };
}

/** Fire-and-forget — logs errors, never throws. */
export function triggerPortraitRebuild(userId: number): void {
  rebuildPortrait(userId, { force: true }).catch((err) =>
    logger.error({ err, userId }, "Background portrait rebuild failed"),
  );
}
