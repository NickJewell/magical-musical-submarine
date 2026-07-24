/**
 * MusicBrainz resolver gate — the anti-hallucination core.
 * Every LLM candidate must pass through resolve() before being shown to the user.
 */

import { httpGet } from "./http";
import { db, resolvedEntitiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const MB_BASE = "https://musicbrainz.org/ws/2";

// ---- String similarity (Dice coefficient on bigrams) ----

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 && bb.size === 0) return 1;
  if (ba.size === 0 || bb.size === 0) return 0;

  let intersection = 0;
  for (const g of ba) {
    if (bb.has(g)) intersection++;
  }

  return (2 * intersection) / (ba.size + bb.size);
}

// ---- MusicBrainz search types ----

interface MBRecording {
  id: string;
  title: string;
  score: number;
  "artist-credit"?: Array<{ name?: string; artist?: { name: string } }>;
  releases?: Array<{ title?: string; date?: string }>;
  genres?: Array<{ name: string }>;
}

interface MBSearchResponse {
  recordings?: MBRecording[];
  "release-groups"?: Array<{
    id: string;
    title: string;
    score: number;
    "artist-credit"?: Array<{ name?: string; artist?: { name: string } }>;
    "first-release-date"?: string;
    genres?: Array<{ name: string }>;
  }>;
}

export interface MBCandidate {
  artist: string;
  title: string;
  type: "track" | "album";
  year_guess?: number;
  rationale?: string;
  likely_known?: "low" | "medium" | "high";
}

export interface ResolvedEntity {
  mbid: string;
  type: string;
  title: string;
  artist: string;
  year: number | null;
  relationships: unknown;
}

function extractYear(dateStr?: string): number | null {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function extractArtist(credits?: Array<{ name?: string; artist?: { name: string } }>): string {
  if (!credits || credits.length === 0) return "";
  return credits.map((c) => c.name ?? c.artist?.name ?? "").join(" & ");
}

// ---- decide() — pick best candidate and check thresholds ----

interface DecideResult {
  mbid: string;
  title: string;
  artist: string;
  year: number | null;
  titleSim: number;
  artistSim: number;
  accepted: boolean;
}

export function decide(
  candidates: Array<{ id: string; title: string; artist: string; year: number | null }>,
  queryTitle: string,
  queryArtist: string,
  minTitleSim = 0.55,
  minArtistSim = 0.45
): DecideResult | null {
  let best: DecideResult | null = null;
  let bestScore = -1;

  for (const c of candidates) {
    const titleSim = similarity(c.title, queryTitle);
    const artistSim = similarity(c.artist, queryArtist);
    const score = titleSim * 0.6 + artistSim * 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = {
        mbid: c.id,
        title: c.title,
        artist: c.artist,
        year: c.year,
        titleSim,
        artistSim,
        accepted: titleSim >= minTitleSim && artistSim >= minArtistSim,
      };
    }
  }

  return best;
}

// ---- resolve() — the anti-hallucination gate ----

/** Default per-request timeout for MusicBrainz HTTP calls (ms). */
export const MB_REQUEST_TIMEOUT_MS = 8_000;

export async function resolveRecording(
  candidate: MBCandidate,
  timeoutMs = MB_REQUEST_TIMEOUT_MS
): Promise<ResolvedEntity | null> {
  const query = encodeURIComponent(
    `recording:"${candidate.title}" AND artist:"${candidate.artist}"`
  );
  const url = `${MB_BASE}/recording?query=${query}&limit=5&fmt=json`;
  const cacheKey = `mb:recording:${normalize(candidate.title)}:${normalize(candidate.artist)}`;

  let data: MBSearchResponse;
  try {
    data = await httpGet<MBSearchResponse>(url, { cacheKey, timeoutMs });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
    if (isTimeout) {
      logger.warn({ candidate, timeoutMs }, "MusicBrainz resolveRecording timed out");
    } else {
      logger.warn({ err, candidate }, "MusicBrainz search failed");
    }
    return null;
  }

  const recordings = data.recordings ?? [];
  const mapped = recordings.map((r) => ({
    id: r.id,
    title: r.title,
    artist: extractArtist(r["artist-credit"]),
    year: extractYear(r.releases?.[0]?.date),
  }));

  const result = decide(mapped, candidate.title, candidate.artist);
  if (!result || !result.accepted) {
    logger.info(
      { candidate, result },
      "MusicBrainz reject: similarity below threshold"
    );
    return null;
  }

  // Enrich with relationships
  return enrichEntity(result.mbid, "recording", result.title, result.artist, result.year, timeoutMs);
}

export async function resolveReleaseGroup(
  candidate: MBCandidate,
  timeoutMs = MB_REQUEST_TIMEOUT_MS
): Promise<ResolvedEntity | null> {
  const query = encodeURIComponent(
    `release:"${candidate.title}" AND artist:"${candidate.artist}"`
  );
  const url = `${MB_BASE}/release-group?query=${query}&limit=5&fmt=json`;
  const cacheKey = `mb:rg:${normalize(candidate.title)}:${normalize(candidate.artist)}`;

  let data: MBSearchResponse;
  try {
    data = await httpGet<MBSearchResponse>(url, { cacheKey, timeoutMs });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
    if (isTimeout) {
      logger.warn({ candidate, timeoutMs }, "MusicBrainz resolveReleaseGroup timed out");
    } else {
      logger.warn({ err, candidate }, "MusicBrainz search failed");
    }
    return null;
  }

  const groups = data["release-groups"] ?? [];
  const mapped = groups.map((r) => ({
    id: r.id,
    title: r.title,
    artist: extractArtist(r["artist-credit"]),
    year: extractYear(r["first-release-date"]),
  }));

  const result = decide(mapped, candidate.title, candidate.artist);
  if (!result || !result.accepted) {
    logger.info({ candidate, result }, "MusicBrainz reject: similarity below threshold");
    return null;
  }

  return enrichEntity(result.mbid, "release-group", result.title, result.artist, result.year, timeoutMs);
}

async function enrichEntity(
  mbid: string,
  type: string,
  title: string,
  artist: string,
  year: number | null,
  timeoutMs = MB_REQUEST_TIMEOUT_MS
): Promise<ResolvedEntity> {
  // Check DB cache first
  const existing = await db
    .select()
    .from(resolvedEntitiesTable)
    .where(eq(resolvedEntitiesTable.mbid, mbid))
    .limit(1);

  if (existing.length > 0) {
    return {
      mbid: existing[0].mbid,
      type: existing[0].type,
      title: existing[0].title,
      artist: existing[0].artist,
      year: existing[0].year,
      relationships: existing[0].relationshipsJson,
    };
  }

  // Fetch full entity with relationships
  const entityType = type === "recording" ? "recording" : "release-group";
  const inc = "artist-credits+artist-rels+work-rels+genres+url-rels";
  const url = `${MB_BASE}/${entityType}/${mbid}?inc=${inc}&fmt=json`;

  let enriched: unknown = {};
  try {
    enriched = await httpGet(url, { cacheKey: `mb:enrich:${mbid}`, timeoutMs });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
    if (isTimeout) {
      logger.warn({ mbid, timeoutMs }, "MusicBrainz enrich timed out, using search result");
    } else {
      logger.warn({ err, mbid }, "MusicBrainz enrich failed, using search result");
    }
  }

  // Store in DB cache
  try {
    await db
      .insert(resolvedEntitiesTable)
      .values({
        mbid,
        type,
        title,
        artist,
        year,
        relationshipsJson: enriched,
      })
      .onConflictDoNothing();
  } catch (err) {
    logger.warn({ err }, "Failed to cache resolved entity");
  }

  return { mbid, type, title, artist, year, relationships: enriched };
}

export async function resolve(
  candidate: MBCandidate,
  timeoutMs = MB_REQUEST_TIMEOUT_MS
): Promise<ResolvedEntity | null> {
  if (candidate.type === "track") {
    return resolveRecording(candidate, timeoutMs);
  } else {
    return resolveReleaseGroup(candidate, timeoutMs);
  }
}

// ---- MusicBrainz search (for seeding UI) ----

const LASTFM_KEY = process.env.LASTFM_API_KEY;
const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0";

interface LastFmTrackMatch {
  name: string;
  artist: string;
  mbid: string;
  listeners: string;
}

interface LastFmSearchResponse {
  results?: {
    trackmatches?: { track?: LastFmTrackMatch[] };
  };
}

export async function searchMusicBrainz(
  query: string,
  type: "track" | "album" | "artist" = "track",
  page = 1
): Promise<Array<{ mbid: string; type: "track" | "album" | "artist"; title: string; artist: string; year: number | null; release: string | null; disambiguation: string | null; score: number }>> {
  const encoded = encodeURIComponent(query);

  if (type === "track") {
    // Last.fm track.search returns results sorted by listeners (popularity)
    if (LASTFM_KEY) {
      const lfUrl =
        `${LASTFM_BASE}/?method=track.search&track=${encoded}` +
        `&api_key=${LASTFM_KEY}&format=json&limit=10&page=${page}`;
      const lfData = await httpGet<LastFmSearchResponse>(lfUrl, {});
      const tracks = lfData.results?.trackmatches?.track ?? [];

      type Candidate = { mbid: string; title: string; artist: string };
      const candidates: Candidate[] = tracks.map((t) => ({
        mbid: t.mbid ?? "",
        title: t.name,
        artist: t.artist,
      }));

      // Resolve missing MBIDs via MusicBrainz in parallel
      const missing = candidates.filter((c) => !c.mbid);
      if (missing.length > 0) {
        await Promise.all(
          missing.map(async (c) => {
            const q = encodeURIComponent(
              `recording:"${c.title}" AND artist:"${c.artist}"`
            );
            const mbUrl = `${MB_BASE}/recording?query=${q}&limit=1&fmt=json`;
            const mbData = await httpGet<MBSearchResponse>(mbUrl, {});
            const rec = mbData.recordings?.[0];
            if (rec) c.mbid = rec.id;
          })
        );
      }

      return candidates
        .filter((c) => c.mbid)
        .map((c, i) => ({
          mbid: c.mbid,
          type: "track" as const,
          title: c.title,
          artist: c.artist,
          year: null,
          release: null,
          disambiguation: null,
          score: 1 - i * 0.01, // preserve popularity order
        }));
    }

    // Fallback: MusicBrainz text search (no popularity order)
    const url = `${MB_BASE}/recording?query=${encoded}&limit=10&offset=${(page - 1) * 10}&fmt=json`;
    const data = await httpGet<MBSearchResponse>(url, {});
    return (data.recordings ?? []).map((r) => ({
      mbid: r.id,
      type: "track" as const,
      title: r.title,
      artist: extractArtist(r["artist-credit"]),
      year: extractYear(r.releases?.[0]?.date),
      release: r.releases?.[0]?.title ?? null,
      disambiguation: null,
      score: r.score / 100,
    }));
  }

  if (type === "album") {
    const url = `${MB_BASE}/release-group?query=${encoded}&limit=10&offset=${(page - 1) * 10}&fmt=json`;
    const data = await httpGet<MBSearchResponse>(url, {});
    return (data["release-groups"] ?? []).map((r) => ({
      mbid: r.id,
      type: "album" as const,
      title: r.title,
      artist: extractArtist(r["artist-credit"]),
      year: extractYear(r["first-release-date"]),
      release: r.title,
      disambiguation: null,
      score: r.score / 100,
    }));
  }

  // artist search
  const url = `${MB_BASE}/artist?query=${encoded}&limit=10&offset=${(page - 1) * 10}&fmt=json`;
  interface MBArtistSearch { artists?: Array<{ id: string; name: string; score: number; disambiguation?: string }> }
  const data = await httpGet<MBArtistSearch>(url, {});
  return (data.artists ?? []).map((a) => ({
    mbid: a.id,
    type: "artist" as const,
    title: a.name,
    artist: a.name,
    year: null,
    release: null,
    disambiguation: a.disambiguation ?? null,
    score: a.score / 100,
  }));
}
