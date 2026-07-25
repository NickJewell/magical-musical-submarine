/**
 * Per-user, per-track ELO.
 *
 * Head-to-head comparisons (the pairwise slider `POST /pair` and canon duels
 * `POST /duel`) move a track's rating; every seeded or rated track is anchored
 * at the 1500 baseline. The resulting ranking feeds the taste portrait and the
 * recommendation steering.
 *
 * Comparison result convention (shared by both flows): an integer in [-2, 2]
 *   result < 0  → track A wins   (magnitude = margin: 1 normal, 2 strong)
 *   result > 0  → track B wins
 *   result === 0 → draw
 */

import {
  db,
  trackEloTable,
  seedsTable,
  recommendationsTable,
  focusRatingsTable,
  resolvedEntitiesTable,
  ratingsTable,
  diveStepsTable,
  divesTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { logger } from "./logger";

export const BASE_RATING = 1500;
const K_BASE = 24;

/** Standard ELO expected score for A against B. */
function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * Compute the two new ratings from a comparison outcome.
 * `scoreA` is A's score for the game: 1 = A won, 0 = A lost, 0.5 = draw.
 * `marginMult` scales K for decisive ("much more") preferences.
 */
export function computeElo(
  ratingA: number,
  ratingB: number,
  scoreA: number,
  marginMult = 1,
): { newA: number; newB: number } {
  const k = K_BASE * marginMult;
  const expectedA = expectedScore(ratingA, ratingB);
  const newA = ratingA + k * (scoreA - expectedA);
  const newB = ratingB + k * ((1 - scoreA) - (1 - expectedA));
  return { newA: Math.round(newA), newB: Math.round(newB) };
}

interface TrackMeta {
  title: string;
  artist: string;
}

/**
 * Resolve a track's title/artist by mbid from whatever table knows it —
 * the user's seeds, any recommendation, their focus ratings, or the shared
 * resolved-entities cache (canon tracks). Returns null if nothing knows it.
 */
async function resolveTrackMeta(userId: number, mbid: string): Promise<TrackMeta | null> {
  const [seed] = await db
    .select({ title: seedsTable.title, artist: seedsTable.artist })
    .from(seedsTable)
    .where(and(eq(seedsTable.userId, userId), eq(seedsTable.mbid, mbid)))
    .limit(1)
    .catch(() => []);
  if (seed) return seed;

  const [rec] = await db
    .select({ title: recommendationsTable.title, artist: recommendationsTable.artist })
    .from(recommendationsTable)
    .where(eq(recommendationsTable.mbid, mbid))
    .limit(1)
    .catch(() => []);
  if (rec) return rec;

  const [focus] = await db
    .select({ title: focusRatingsTable.title, artist: focusRatingsTable.artist })
    .from(focusRatingsTable)
    .where(and(eq(focusRatingsTable.userId, userId), eq(focusRatingsTable.mbid, mbid)))
    .limit(1)
    .catch(() => []);
  if (focus) return focus;

  const [ent] = await db
    .select({ title: resolvedEntitiesTable.title, artist: resolvedEntitiesTable.artist })
    .from(resolvedEntitiesTable)
    .where(eq(resolvedEntitiesTable.mbid, mbid))
    .limit(1)
    .catch(() => []);
  if (ent?.title && ent?.artist) return { title: ent.title, artist: ent.artist };

  return null;
}

/** Ensure a track_elo row exists for (userId, mbid); no-op if it already does. */
async function ensureRow(userId: number, mbid: string, meta: TrackMeta): Promise<void> {
  await db
    .insert(trackEloTable)
    .values({ userId, mbid, title: meta.title, artist: meta.artist, rating: BASE_RATING })
    .onConflictDoNothing({ target: [trackEloTable.userId, trackEloTable.mbid] })
    .catch(() => undefined);
}

async function getRow(userId: number, mbid: string) {
  const [row] = await db
    .select()
    .from(trackEloTable)
    .where(and(eq(trackEloTable.userId, userId), eq(trackEloTable.mbid, mbid)))
    .limit(1);
  return row ?? null;
}

/**
 * Apply one head-to-head comparison to both tracks' ELO. Resolves and creates
 * missing rows, computes new ratings, and persists win/loss/draw tallies.
 * Fire-and-forget safe: logs and swallows errors so it never breaks the
 * comparison request that triggered it.
 */
export async function applyComparison(opts: {
  userId: number;
  aMbid: string;
  bMbid: string;
  result: number;
}): Promise<void> {
  const { userId, aMbid, bMbid, result } = opts;
  if (!aMbid || !bMbid || aMbid === bMbid) return;

  try {
    const [aMeta, bMeta] = await Promise.all([
      resolveTrackMeta(userId, aMbid),
      resolveTrackMeta(userId, bMbid),
    ]);
    if (!aMeta || !bMeta) {
      logger.debug({ userId, aMbid, bMbid }, "ELO: could not resolve both tracks — skipping");
      return;
    }

    await ensureRow(userId, aMbid, aMeta);
    await ensureRow(userId, bMbid, bMeta);

    const [aRow, bRow] = await Promise.all([getRow(userId, aMbid), getRow(userId, bMbid)]);
    if (!aRow || !bRow) return;

    // result < 0 → A wins, > 0 → B wins, 0 → draw. Magnitude 2 = decisive.
    const scoreA = result < 0 ? 1 : result > 0 ? 0 : 0.5;
    const marginMult = Math.abs(result) >= 2 ? 1.5 : 1;
    const { newA, newB } = computeElo(aRow.rating, bRow.rating, scoreA, marginMult);

    const aWin = scoreA === 1;
    const draw = scoreA === 0.5;

    await Promise.all([
      db
        .update(trackEloTable)
        .set({
          rating: newA,
          matches: aRow.matches + 1,
          wins: aRow.wins + (aWin ? 1 : 0),
          losses: aRow.losses + (!aWin && !draw ? 1 : 0),
          draws: aRow.draws + (draw ? 1 : 0),
          updatedAt: new Date(),
        })
        .where(eq(trackEloTable.id, aRow.id)),
      db
        .update(trackEloTable)
        .set({
          rating: newB,
          matches: bRow.matches + 1,
          wins: bRow.wins + (!aWin && !draw ? 1 : 0),
          losses: bRow.losses + (aWin ? 1 : 0),
          draws: bRow.draws + (draw ? 1 : 0),
          updatedAt: new Date(),
        })
        .where(eq(trackEloTable.id, bRow.id)),
    ]);
  } catch (err) {
    logger.warn({ err: String(err), userId, aMbid, bMbid }, "ELO: applyComparison failed");
  }
}

/**
 * Backfill: make sure every track the user has seeded, rated, or focus-rated
 * has a track_elo row anchored at the baseline, so "all seeded/rated tracks"
 * carry a ranking even before they're compared.
 */
export async function ensureUserTracksSeeded(userId: number): Promise<void> {
  try {
    const seeds = await db
      .select({ mbid: seedsTable.mbid, title: seedsTable.title, artist: seedsTable.artist })
      .from(seedsTable)
      .where(eq(seedsTable.userId, userId))
      .catch(() => []);

    const ratedRecs = await db
      .selectDistinct({
        mbid: recommendationsTable.mbid,
        title: recommendationsTable.title,
        artist: recommendationsTable.artist,
      })
      .from(ratingsTable)
      .innerJoin(recommendationsTable, eq(ratingsTable.recId, recommendationsTable.id))
      .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
      .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
      .where(eq(divesTable.userId, userId))
      .catch(() => []);

    const focus = await db
      .select({ mbid: focusRatingsTable.mbid, title: focusRatingsTable.title, artist: focusRatingsTable.artist })
      .from(focusRatingsTable)
      .where(eq(focusRatingsTable.userId, userId))
      .catch(() => []);

    const byMbid = new Map<string, TrackMeta>();
    for (const t of [...seeds, ...ratedRecs, ...focus]) {
      if (t.mbid && !byMbid.has(t.mbid)) byMbid.set(t.mbid, { title: t.title, artist: t.artist });
    }
    if (byMbid.size === 0) return;

    await db
      .insert(trackEloTable)
      .values([...byMbid.entries()].map(([mbid, m]) => ({
        userId,
        mbid,
        title: m.title,
        artist: m.artist,
        rating: BASE_RATING,
      })))
      .onConflictDoNothing({ target: [trackEloTable.userId, trackEloTable.mbid] })
      .catch(() => undefined);
  } catch (err) {
    logger.warn({ err: String(err), userId }, "ELO: ensureUserTracksSeeded failed");
  }
}

export interface RankedTrack {
  mbid: string;
  title: string;
  artist: string;
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
}

/** All of a user's ranked tracks, highest ELO first. */
export async function getRankedTracks(userId: number): Promise<RankedTrack[]> {
  const rows = await db
    .select()
    .from(trackEloTable)
    .where(eq(trackEloTable.userId, userId))
    .orderBy(desc(trackEloTable.rating))
    .catch(() => []);
  return rows.map((r) => ({
    mbid: r.mbid,
    title: r.title,
    artist: r.artist,
    rating: r.rating,
    matches: r.matches,
    wins: r.wins,
    losses: r.losses,
    draws: r.draws,
  }));
}

/**
 * The user's strongest and weakest tracks *by head-to-head signal* (matches>0),
 * for steering the portrait and recommendations. Uncompared baseline tracks are
 * excluded because a 1500 carries no preference signal.
 */
export async function getEloSignal(userId: number, n = 5): Promise<{ top: RankedTrack[]; bottom: RankedTrack[] }> {
  const rows = await db
    .select()
    .from(trackEloTable)
    .where(and(eq(trackEloTable.userId, userId), sql`${trackEloTable.matches} > 0`))
    .orderBy(desc(trackEloTable.rating))
    .catch(() => []);
  const ranked: RankedTrack[] = rows.map((r) => ({
    mbid: r.mbid,
    title: r.title,
    artist: r.artist,
    rating: r.rating,
    matches: r.matches,
    wins: r.wins,
    losses: r.losses,
    draws: r.draws,
  }));
  return {
    top: ranked.slice(0, n),
    bottom: ranked.length > n ? ranked.slice(-n).reverse() : [],
  };
}
