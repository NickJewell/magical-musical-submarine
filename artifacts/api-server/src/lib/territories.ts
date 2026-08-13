/**
 * Taste territories — cluster the user's ranked tracks into named regions of
 * their taste, plus "beyond the map" suggestions for adjacent scenes they
 * haven't entered.
 *
 * Pipeline: rankings → Last.fm artist top-tags (cached 30d, parallel) →
 * deterministic tag clustering (greedy pick with overlap penalty, so
 * "indie" / "indie rock" / "indie pop" don't become three territories) →
 * ONE LLM call that names each territory and writes its texture line.
 *
 * The LLM never sees a number: per-territory affinity is pre-verbalized here
 * (from stars + ELO) into qualitative labels, and the rendered map carries no
 * scores — territories are textures, not leaderboards.
 */

import { createHash } from "node:crypto";
import { db, tasteTerritoriesTable, focusRatingsTable, ratingsTable, recommendationsTable, diveStepsTable, divesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { getRankedTracks, ensureUserTracksSeeded, BASE_RATING } from "./elo";
import { lastfmArtistTopTags, type ArtistTag } from "./enrich";
import { nameTerritories } from "./llm";
import { logger } from "./logger";

// ---- Types ----

export interface MapTrack {
  mbid: string;
  title: string;
  artist: string;
}

export interface Territory {
  key: string;
  tag: string;            // the underlying Last.fm tag (kept for provenance)
  name: string;           // LLM coinage, e.g. "Rebellious Chamber Pop"
  blurb: string;          // one texture line, number-free
  artists: string[];      // representative artists
  tracks: MapTrack[];     // representative tracks (dive-in fuel)
  trackCount: number;     // structural size, used for ordering only
}

export interface BeyondSuggestion {
  name: string;
  blurb: string;          // the dare
  tracks: Array<{ title: string; artist: string }>; // exemplar entry points
}

export interface TerritoryMap {
  territories: Territory[];
  beyond: BeyondSuggestion[];
}

// ---- Pure clustering (unit-tested) ----

/** Non-genre junk that pollutes Last.fm tags. */
const TAG_STOPLIST = new Set([
  "seen live", "favorites", "favourites", "favorite", "favourite", "spotify",
  "my music", "awesome", "beautiful", "check out", "love", "loved", "good",
  "great", "amazing", "epic", "cool", "best", "under 2000 listeners",
  "female vocalists", "male vocalists", "singer-songwriter", // too broad to map
  "all", "misc", "other", "music", "usa", "uk", "british", "american",
]);

const isUsableTag = (name: string) =>
  !TAG_STOPLIST.has(name) && !/^\d{4}$/.test(name) && name.length >= 3 && name.length <= 30;

export interface TaggedTrack {
  track: MapTrack;
  /** Preference signal: 1..3 stars when the user starred it, else null. */
  stars: number | null;
  /** Head-to-head rating (BASE_RATING when uncompared). */
  elo: number;
  matches: number;
  tags: ArtistTag[];
}

/** How loudly one track votes for its tags. Loved tracks shape the map most. */
export function trackWeight(t: { stars: number | null; elo: number; matches: number }): number {
  let w = 1;
  if (t.stars === 3) w += 0.6;
  else if (t.stars === 2) w += 0.2;
  if (t.matches > 0 && t.elo > BASE_RATING + 40) w += 0.3;
  return w;
}

export interface Cluster {
  tag: string;
  tracks: TaggedTrack[];
}

/**
 * Pick up to `maxClusters` territory tags and assign each track to its
 * strongest one. Greedy selection with an overlap penalty: a tag whose track
 * set is >60% contained in already-picked territory is skipped, so sibling
 * tags ("indie", "indie rock") collapse into one region instead of three.
 * Tracks matching no picked tag land in an "outlands" cluster (tag = null →
 * returned separately).
 */
export function clusterTracks(
  tracks: TaggedTrack[],
  maxClusters = 7,
): { clusters: Cluster[]; outlands: TaggedTrack[] } {
  // Aggregate tag scores + per-tag track sets
  const tagScore = new Map<string, number>();
  const tagTracks = new Map<string, Set<number>>();
  tracks.forEach((t, idx) => {
    const w = trackWeight(t);
    for (const tag of t.tags) {
      if (!isUsableTag(tag.name)) continue;
      tagScore.set(tag.name, (tagScore.get(tag.name) ?? 0) + (tag.weight / 100) * w);
      let set = tagTracks.get(tag.name);
      if (!set) { set = new Set(); tagTracks.set(tag.name, set); }
      set.add(idx);
    }
  });

  const minSize = tracks.length >= 24 ? 3 : 2;
  const candidates = [...tagScore.entries()]
    .filter(([tag]) => (tagTracks.get(tag)?.size ?? 0) >= minSize)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  const picked: string[] = [];
  const covered = new Set<number>();
  for (const tag of candidates) {
    if (picked.length >= maxClusters) break;
    const set = tagTracks.get(tag)!;
    let overlap = 0;
    for (const idx of set) if (covered.has(idx)) overlap++;
    if (picked.length > 0 && overlap / set.size > 0.6) continue; // sibling tag — already mapped
    picked.push(tag);
    for (const idx of set) covered.add(idx);
  }

  // Assign each track to its strongest picked tag
  const byTag = new Map<string, TaggedTrack[]>(picked.map((t) => [t, []]));
  const outlands: TaggedTrack[] = [];
  for (const t of tracks) {
    let best: string | null = null;
    let bestWeight = 0;
    for (const tag of t.tags) {
      if (!byTag.has(tag.name)) continue;
      if (tag.weight > bestWeight) { best = tag.name; bestWeight = tag.weight; }
    }
    if (best) byTag.get(best)!.push(t);
    else outlands.push(t);
  }

  const clusters = picked
    .map((tag) => ({ tag, tracks: byTag.get(tag)! }))
    .filter((c) => c.tracks.length >= 2)
    .sort((a, b) => b.tracks.length - a.tracks.length);

  return { clusters, outlands };
}

/**
 * Pre-verbalize a cluster's private stats so the LLM (and the page) never see
 * numbers. Purely qualitative: where this territory sits in their affections.
 */
export function affinityLabel(tracks: TaggedTrack[]): string {
  const starred = tracks.filter((t) => t.stars !== null);
  const threes = starred.filter((t) => t.stars === 3).length;
  const compared = tracks.filter((t) => t.matches > 0);
  const above = compared.filter((t) => t.elo > BASE_RATING + 25).length;

  if (starred.length === 0 && compared.length === 0) return "unsettled — barely explored yet";
  // Judge only on the signals that exist — an absent signal must not vote.
  const loveShare = starred.length > 0 ? threes / starred.length : null;
  const winShare = compared.length > 0 ? above / compared.length : null;
  if ((loveShare ?? 0) >= 0.5 || (winShare ?? 0) >= 0.6) return "lights them up — a stronghold";
  if ((loveShare ?? 0) >= 0.25 || (winShare ?? 0) >= 0.4) return "solid ground — reliably enjoyed";
  return "respected, not loved — they keep it at arm's length";
}

// ---- Orchestration ----

const ARTIST_CAP = 120;
const TAG_FETCH_CONCURRENCY = 10;

async function loadStarMap(userId: number): Promise<Map<string, number>> {
  // Highest star per mbid, from both write paths (dive recs + focus ratings).
  const stars = new Map<string, number>();
  const note = (mbid: string | null, raw: unknown) => {
    if (!mbid) return;
    const s = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(s) || s < 1) return;
    const prev = stars.get(mbid);
    if (prev === undefined || s > prev) stars.set(mbid, s);
  };

  const focus = await db
    .select({ mbid: focusRatingsTable.mbid, score: focusRatingsTable.score })
    .from(focusRatingsTable)
    .where(eq(focusRatingsTable.userId, userId))
    .catch(() => []);
  for (const f of focus) note(f.mbid, f.score);

  const recRated = await db
    .select({ mbid: recommendationsTable.mbid, score: ratingsTable.score })
    .from(ratingsTable)
    .innerJoin(recommendationsTable, eq(ratingsTable.recId, recommendationsTable.id))
    .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
    .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
    .where(eq(divesTable.userId, userId))
    .catch(() => []);
  for (const r of recRated) note(r.mbid, r.score);

  return stars;
}

function computeSourceHash(rows: Array<{ mbid: string; stars: number | null; elo: number }>): string {
  const payload = rows
    .map((r) => `${r.mbid}:${r.stars ?? "-"}:${Math.round(r.elo / 25)}`) // bucket ELO so tiny drifts don't bust the cache
    .sort()
    .join("|");
  return createHash("sha256").update(payload).digest("hex");
}

export interface BuildResult {
  map: TerritoryMap;
  generatedAt: string;
  cached: boolean;
}

export async function buildTerritories(userId: number, { force = false } = {}): Promise<BuildResult | null> {
  await ensureUserTracksSeeded(userId);
  const [ranked, starMap] = await Promise.all([getRankedTracks(userId), loadStarMap(userId)]);
  if (ranked.length < 8) return null; // not enough land to map

  const rows = ranked.map((t) => ({
    mbid: t.mbid, title: t.title, artist: t.artist,
    stars: starMap.get(t.mbid) ?? null, elo: t.rating, matches: t.matches,
  }));
  const sourceHash = computeSourceHash(rows);

  const [existing] = await db
    .select()
    .from(tasteTerritoriesTable)
    .where(eq(tasteTerritoriesTable.userId, userId))
    .orderBy(desc(tasteTerritoriesTable.generatedAt))
    .catch(() => []);

  if (!force && existing && existing.sourceHash === sourceHash) {
    return { map: existing.dataJson as unknown as TerritoryMap, generatedAt: existing.generatedAt.toISOString(), cached: true };
  }

  // ---- Tag the artists (deduped, strongest-signal first, capped) ----
  const byArtist = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.artist.toLowerCase();
    const list = byArtist.get(key) ?? [];
    list.push(r);
    byArtist.set(key, list);
  }
  const artists = [...byArtist.values()]
    .map((tracks) => ({ name: tracks[0].artist, tracks, signal: Math.max(...tracks.map((t) => trackWeight(t))) }))
    .sort((a, b) => b.signal - a.signal)
    .slice(0, ARTIST_CAP);

  const tagsByArtist = new Map<string, ArtistTag[]>();
  for (let i = 0; i < artists.length; i += TAG_FETCH_CONCURRENCY) {
    const chunk = artists.slice(i, i + TAG_FETCH_CONCURRENCY);
    const results = await Promise.all(chunk.map((a) => lastfmArtistTopTags(a.name).catch(() => [])));
    chunk.forEach((a, j) => tagsByArtist.set(a.name.toLowerCase(), results[j]));
  }

  const tagged: TaggedTrack[] = [];
  for (const a of artists) {
    const tags = tagsByArtist.get(a.name.toLowerCase()) ?? [];
    if (tags.length === 0) continue;
    for (const r of a.tracks) {
      tagged.push({
        track: { mbid: r.mbid, title: r.title, artist: r.artist },
        stars: r.stars, elo: r.elo, matches: r.matches, tags,
      });
    }
  }
  if (tagged.length < 6) return null;

  const { clusters } = clusterTracks(tagged);
  if (clusters.length === 0) return null;

  // ---- Representative slices + private affinity, then one naming call ----
  const forNaming = clusters.map((c, i) => {
    const repTracks = [...c.tracks]
      .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || b.elo - a.elo)
      .slice(0, 6);
    const repArtists = [...new Set(repTracks.map((t) => t.track.artist))].slice(0, 5);
    return {
      key: `t${i}`,
      tag: c.tag,
      artists: repArtists,
      tracks: repTracks.map((t) => `"${t.track.title}" by ${t.track.artist}`),
      affinity: affinityLabel(c.tracks),
    };
  });

  const named = await nameTerritories({ clusters: forNaming });

  const territories: Territory[] = clusters.map((c, i) => {
    const n = named.territories.find((t) => t.key === `t${i}`);
    const repTracks = [...c.tracks]
      .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || b.elo - a.elo)
      .slice(0, 8)
      .map((t) => t.track);
    return {
      key: `t${i}`,
      tag: c.tag,
      name: n?.name ?? c.tag,
      blurb: n?.blurb ?? "",
      artists: [...new Set(repTracks.map((t) => t.artist))].slice(0, 5),
      tracks: repTracks,
      trackCount: c.tracks.length,
    };
  });

  const map: TerritoryMap = { territories, beyond: named.beyond.slice(0, 3) };

  // Upsert: keep exactly one row per user.
  await db.delete(tasteTerritoriesTable).where(eq(tasteTerritoriesTable.userId, userId)).catch(() => undefined);
  const [row] = await db
    .insert(tasteTerritoriesTable)
    .values({ userId, dataJson: map as unknown as Record<string, unknown>, sourceHash })
    .returning();

  logger.info({ userId, territories: territories.length, tracks: tagged.length }, "taste territories generated");
  return { map, generatedAt: row.generatedAt.toISOString(), cached: false };
}

/** The latest cached map without regenerating; null if never charted. */
export async function getTerritories(userId: number): Promise<BuildResult | null> {
  const [existing] = await db
    .select()
    .from(tasteTerritoriesTable)
    .where(eq(tasteTerritoriesTable.userId, userId))
    .orderBy(desc(tasteTerritoriesTable.generatedAt))
    .catch(() => []);
  if (!existing) return null;
  return { map: existing.dataJson as unknown as TerritoryMap, generatedAt: existing.generatedAt.toISOString(), cached: true };
}
