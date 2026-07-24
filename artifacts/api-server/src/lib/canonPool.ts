/**
 * Canon pool management — pair selection for Canon Duels (§17).
 */

import { db, canonTracksTable, resolvedEntitiesTable, tasteEventsTable, seedsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export type Strategy = "random" | "contrastive" | "coverage-adaptive";

const CANON_DUEL_STRATEGY = (process.env.CANON_DUEL_STRATEGY ?? "contrastive") as Strategy;

export interface DuelTrack {
  mbid: string;
  title: string;
  artist: string;
  year: number | null;
  primaryGenre: string | null;
  era: number | null;
  canonWeight: number;
}

export interface DuelPair {
  a: DuelTrack;
  b: DuelTrack;
  strategy: Strategy;
}

// ---- Helpers ----

async function getExcludeSet(userId: number): Promise<Set<string>> {
  const [seeds, events] = await Promise.all([
    db.select({ mbid: seedsTable.mbid }).from(seedsTable).where(eq(seedsTable.userId, userId)),
    db.select({ payloadJson: tasteEventsTable.payloadJson })
      .from(tasteEventsTable)
      .where(eq(tasteEventsTable.userId, userId))
      .orderBy(sql`${tasteEventsTable.id} DESC`)
      .limit(120), // cover last 40 duels (3 events each: duel + maybe 2 promotions)
  ]);

  const exclude = new Set(seeds.map((s) => s.mbid));

  let duelsScanned = 0;
  for (const ev of events) {
    const p = ev.payloadJson as { aMbid?: string; bMbid?: string; kind?: string };
    if (p.aMbid && p.bMbid) {
      // This looks like a duel payload
      if (duelsScanned < 40) {
        exclude.add(p.aMbid);
        exclude.add(p.bMbid);
        duelsScanned++;
      }
    }
  }

  return exclude;
}

async function loadPool(): Promise<DuelTrack[]> {
  const rows = await db
    .select({
      mbid: canonTracksTable.mbid,
      title: resolvedEntitiesTable.title,
      artist: resolvedEntitiesTable.artist,
      year: resolvedEntitiesTable.year,
      primaryGenre: canonTracksTable.primaryGenre,
      era: canonTracksTable.era,
      canonWeight: canonTracksTable.canonWeight,
    })
    .from(canonTracksTable)
    .innerJoin(resolvedEntitiesTable, eq(canonTracksTable.mbid, resolvedEntitiesTable.mbid));

  return rows.map((r) => ({
    mbid: r.mbid,
    title: r.title ?? "",
    artist: r.artist ?? "",
    year: r.year ?? null,
    primaryGenre: r.primaryGenre,
    era: r.era,
    canonWeight: parseFloat(String(r.canonWeight ?? "0.5")),
  }));
}

function weightedPick(items: DuelTrack[]): DuelTrack {
  const total = items.reduce((s, t) => s + t.canonWeight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.canonWeight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Strategies ----

function selectRandom(pool: DuelTrack[]): [DuelTrack, DuelTrack] | null {
  if (pool.length < 2) return null;
  const a = weightedPick(pool);
  const rest = pool.filter((t) => t.mbid !== a.mbid);
  const b = weightedPick(rest);
  return [a, b];
}

function selectContrastive(pool: DuelTrack[]): [DuelTrack, DuelTrack] | null {
  if (pool.length < 2) return null;

  // Group by genre first, then era as fallback
  const byGenre = new Map<string, DuelTrack[]>();
  const byEra   = new Map<number, DuelTrack[]>();

  for (const t of pool) {
    const g = t.primaryGenre ?? "other";
    if (!byGenre.has(g)) byGenre.set(g, []);
    byGenre.get(g)!.push(t);

    if (t.era != null) {
      if (!byEra.has(t.era)) byEra.set(t.era, []);
      byEra.get(t.era)!.push(t);
    }
  }

  // Try genre contrast
  const genres = shuffle(Array.from(byGenre.keys()));
  if (genres.length >= 2) {
    const [gA, gB] = genres;
    return [weightedPick(byGenre.get(gA)!), weightedPick(byGenre.get(gB)!)];
  }

  // Fall back to era contrast
  const eras = shuffle(Array.from(byEra.keys()));
  if (eras.length >= 2) {
    const [eA, eB] = eras;
    return [weightedPick(byEra.get(eA)!), weightedPick(byEra.get(eB)!)];
  }

  return selectRandom(pool);
}

async function selectCoverageAdaptive(
  pool: DuelTrack[],
  userId: number,
): Promise<[DuelTrack, DuelTrack] | null> {
  if (pool.length < 2) return null;

  // Which genres has this user already encountered in duels?
  const events = await db
    .select({ payloadJson: tasteEventsTable.payloadJson })
    .from(tasteEventsTable)
    .where(eq(tasteEventsTable.userId, userId));

  const seenMbids = new Set<string>();
  for (const ev of events) {
    const p = ev.payloadJson as { aMbid?: string; bMbid?: string };
    if (p.aMbid) seenMbids.add(p.aMbid);
    if (p.bMbid) seenMbids.add(p.bMbid);
  }

  const seenGenres = new Set<string>(
    pool
      .filter((t) => seenMbids.has(t.mbid) && t.primaryGenre)
      .map((t) => t.primaryGenre!),
  );

  // Prefer tracks from genres not yet seen
  const novel = pool.filter((t) => t.primaryGenre && !seenGenres.has(t.primaryGenre));
  const source = novel.length >= 2 ? novel : pool;

  return selectContrastive(source);
}

// ---- Public ----

export async function getNextDuelPair(
  userId: number,
  strategy: Strategy = CANON_DUEL_STRATEGY,
): Promise<DuelPair | null> {
  const [allPool, exclude] = await Promise.all([
    loadPool(),
    getExcludeSet(userId),
  ]);

  const pool = allPool.filter((t) => !exclude.has(t.mbid));

  if (pool.length < 2) {
    logger.warn({ userId, poolSize: pool.length }, "Canon pool too small for duel — try POST /api/canon/seed");
    return null;
  }

  let pair: [DuelTrack, DuelTrack] | null = null;

  if (strategy === "coverage-adaptive") {
    pair = await selectCoverageAdaptive(pool, userId);
  } else if (strategy === "contrastive") {
    pair = selectContrastive(pool);
  } else {
    pair = selectRandom(pool);
  }

  if (!pair) return null;
  return { a: pair[0], b: pair[1], strategy };
}
