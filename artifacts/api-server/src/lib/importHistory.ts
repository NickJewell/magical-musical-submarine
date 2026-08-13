/**
 * Listening-history import — bootstrap the taste graph from a Last.fm profile.
 *
 * Last.fm listening data is public per-username (no OAuth), so the flow is just:
 * fetch the user's top tracks for a period, de-dupe against everything already
 * in their taste graph, and land the rest in `focus_ratings` as unstarred
 * "known" tracks. Everything downstream then comes free:
 *   - ensureUserTracksSeeded gives them ELO rows → visible in Rankings and
 *     served by the Compare tab (the fast-ranking loop).
 *   - The Discover feed excludes ranked tracks → never re-recommends them.
 *   - Dive exclusion reads focus_ratings → imports won't be re-served.
 *   - The portrait only hears a track once it's compared/starred, so a bulk
 *     import can't drown it.
 */

import { db, focusRatingsTable, seedsTable, recommendationsTable, ratingsTable, diveStepsTable, divesTable, tasteEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { httpGet } from "./http";
import { ensureUserTracksSeeded } from "./elo";
import { logger } from "./logger";

const LASTFM_KEY = process.env.LASTFM_API_KEY;
const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0";

export const LASTFM_PERIODS = ["overall", "12month", "6month", "3month", "1month"] as const;
export type LastfmPeriod = (typeof LASTFM_PERIODS)[number];

/** Hard cap on how many tracks one import can pull. */
export const IMPORT_MAX = 500;
const PAGE_SIZE = 100;

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const trackKey = (title: string, artist: string) => `${normalize(title)}|${normalize(artist)}`;

/** Same synthetic-mbid convention as the discover/recommend fallbacks. */
const syntheticMbid = (artist: string, title: string) =>
  `lastfm:${artist.toLowerCase().replace(/[^\w]/g, "-")}:${title.toLowerCase().replace(/[^\w]/g, "-")}`;

export interface LastfmTopTrack {
  title: string;
  artist: string;
  mbid: string | null; // MusicBrainz recording id when Last.fm has one
  playcount: number;
}

interface LFMTopTracksResp {
  toptracks?: {
    track?: Array<{
      name: string;
      mbid?: string;
      playcount?: string;
      artist?: { name?: string; mbid?: string };
    }>;
    "@attr"?: { user?: string; total?: string; totalPages?: string };
  };
  error?: number;
  message?: string;
}

/**
 * Fetch a user's top tracks from Last.fm, paged. Throws on unknown user
 * (Last.fm answers HTTP 404) or missing API key.
 */
export async function fetchLastfmTopTracks(
  username: string,
  period: LastfmPeriod,
  limit: number,
): Promise<{ user: string; total: number; tracks: LastfmTopTrack[] }> {
  if (!LASTFM_KEY) throw new Error("LASTFM_API_KEY is not configured");

  const capped = Math.min(Math.max(1, limit), IMPORT_MAX);
  const tracks: LastfmTopTrack[] = [];
  let canonicalUser = username;
  let total = 0;

  const pages = Math.ceil(capped / PAGE_SIZE);
  for (let page = 1; page <= pages; page++) {
    const url =
      `${LASTFM_BASE}/?method=user.gettoptracks&user=${encodeURIComponent(username)}` +
      `&api_key=${LASTFM_KEY}&format=json&period=${period}&limit=${PAGE_SIZE}&page=${page}`;
    const data = await httpGet<LFMTopTracksResp>(url, {
      // User data moves, so keep the cache short — just enough to make
      // preview-then-import and accidental double-clicks free.
      cacheKey: `lfm:usertop:${username.toLowerCase()}:${period}:${page}`,
      cacheTtlMs: 60 * 60 * 1000,
    });
    if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message ?? "unknown"}`);

    const attr = data.toptracks?.["@attr"];
    if (attr?.user) canonicalUser = attr.user;
    total = Number(attr?.total ?? 0);

    const pageTracks = data.toptracks?.track ?? [];
    for (const t of pageTracks) {
      const artist = t.artist?.name?.trim();
      const title = t.name?.trim();
      if (!artist || !title) continue;
      tracks.push({
        title,
        artist,
        mbid: t.mbid?.trim() || null,
        playcount: Number(t.playcount ?? 0),
      });
      if (tracks.length >= capped) break;
    }
    if (tracks.length >= capped || pageTracks.length < PAGE_SIZE) break;
  }

  return { user: canonicalUser, total, tracks };
}

/**
 * Identity sets for everything already in the user's taste graph — seeds,
 * rated dive recs, and focus ratings — keyed by mbid AND by normalized
 * "title|artist" (the same track can live under a real MusicBrainz id in one
 * place and a synthetic lastfm:/spotify: key in another).
 */
async function loadExistingIdentity(userId: number): Promise<{ mbids: Set<string>; keys: Set<string> }> {
  const [focus, seeds, ratedRecs] = await Promise.all([
    db
      .select({ mbid: focusRatingsTable.mbid, title: focusRatingsTable.title, artist: focusRatingsTable.artist })
      .from(focusRatingsTable)
      .where(eq(focusRatingsTable.userId, userId))
      .catch(() => []),
    db
      .select({ mbid: seedsTable.mbid, title: seedsTable.title, artist: seedsTable.artist })
      .from(seedsTable)
      .where(eq(seedsTable.userId, userId))
      .catch(() => []),
    db
      .selectDistinct({ mbid: recommendationsTable.mbid, title: recommendationsTable.title, artist: recommendationsTable.artist })
      .from(ratingsTable)
      .innerJoin(recommendationsTable, eq(ratingsTable.recId, recommendationsTable.id))
      .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
      .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
      .where(eq(divesTable.userId, userId))
      .catch(() => []),
  ]);

  const mbids = new Set<string>();
  const keys = new Set<string>();
  for (const r of [...focus, ...seeds, ...ratedRecs]) {
    if (r.mbid) mbids.add(r.mbid);
    if (r.title && r.artist) keys.add(trackKey(r.title, r.artist));
  }
  return { mbids, keys };
}

export interface ImportResult {
  fetched: number;
  imported: number;
  skipped: number;
}

/**
 * Import a Last.fm user's top tracks into the taste graph as "known" tracks.
 * Idempotent: re-running skips everything already present (by mbid or by
 * normalized title|artist), so it doubles as a re-sync.
 */
export async function importLastfmHistory(opts: {
  userId: number;
  username: string;
  period?: LastfmPeriod;
  limit?: number;
}): Promise<ImportResult> {
  const { userId, username, period = "overall", limit = 100 } = opts;

  const { tracks } = await fetchLastfmTopTracks(username, period, limit);
  if (tracks.length === 0) return { fetched: 0, imported: 0, skipped: 0 };

  const existing = await loadExistingIdentity(userId);

  const batchKeys = new Set<string>();
  const rows: Array<typeof focusRatingsTable.$inferInsert> = [];
  for (const t of tracks) {
    const key = trackKey(t.title, t.artist);
    const mbid = t.mbid ?? syntheticMbid(t.artist, t.title);
    if (existing.keys.has(key) || existing.mbids.has(mbid) || batchKeys.has(key)) continue;
    batchKeys.add(key);
    rows.push({
      userId,
      mbid,
      title: t.title,
      artist: t.artist,
      // "known" with no stars: it's part of their listening life, but the
      // preference signal comes later, from comparing/starring — not from us
      // guessing at playcounts.
      listenState: "known",
      score: null,
      reviewText: null,
    });
  }

  if (rows.length > 0) {
    await db.insert(focusRatingsTable).values(rows);

    // One summary taste-event (not one per track — the portrait's recent-
    // ratings block filters by kind, so a bulk import never drowns it).
    await db
      .insert(tasteEventsTable)
      .values({
        userId,
        kind: "history_import",
        payloadJson: { source: "lastfm", username, period, imported: rows.length, skipped: tracks.length - rows.length },
      })
      .catch(() => undefined);

    // Give the imports ELO rows right away so Rankings and Compare see them
    // without waiting for the next lazy backfill.
    await ensureUserTracksSeeded(userId);
  }

  const imported = rows.length;
  logger.info({ userId, username, period, fetched: tracks.length, imported }, "lastfm history import complete");
  return { fetched: tracks.length, imported, skipped: tracks.length - imported };
}
