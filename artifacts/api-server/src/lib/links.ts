/**
 * Streaming links: Odesli primary + search-URL fallback.
 * Returns full deep-link URLs plus parsed embed IDs (§18).
 */

import { httpGet } from "./http";
import { logger } from "./logger";
import { db, resolvedEntitiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const ODESLI_BASE = "https://api.song.link/v1-alpha.1/links";

interface OdesliResponse {
  linksByPlatform?: {
    spotify?:    { url: string };
    youtube?:    { url: string };
    appleMusic?: { url: string };
  };
}

export interface StreamingLinks {
  spotify:        string | null;
  youtube:        string | null;
  appleMusic:     string | null;
  source:         "odesli" | "search_fallback";
  spotifyTrackId: string | null;
  youtubeVideoId: string | null;
}

// ---- ID parsers ----

function parseSpotifyTrackId(url: string): string | null {
  return url.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/)?.[1] ?? null;
}

function parseYouTubeVideoId(url: string): string | null {
  return (
    url.match(/[?&]v=([A-Za-z0-9_-]+)/)?.[1] ??
    url.match(/youtu\.be\/([A-Za-z0-9_-]+)/)?.[1] ??
    null
  );
}

function spotifySearchUrl(artist: string, title: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${title}`)}/tracks`;
}

function youtubeSearchUrl(artist: string, title: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${artist} ${title}`)}`;
}

// ---- Persist embed IDs to resolved_entities (best-effort) ----

async function cacheEmbedIds(
  mbid: string,
  spotifyTrackId: string | null,
  youtubeVideoId: string | null,
): Promise<void> {
  if (!spotifyTrackId && !youtubeVideoId) return;
  try {
    await db
      .update(resolvedEntitiesTable)
      .set({
        ...(spotifyTrackId ? { spotifyUri: spotifyTrackId } : {}),
        ...(youtubeVideoId ? { youtubeId: youtubeVideoId } : {}),
      })
      .where(eq(resolvedEntitiesTable.mbid, mbid));
  } catch (err) {
    logger.debug({ err, mbid }, "Failed to cache embed IDs — non-fatal");
  }
}

// ---- Check DB cache first ----

async function getCachedEmbedIds(
  mbid: string,
): Promise<{ spotifyTrackId: string | null; youtubeVideoId: string | null } | null> {
  try {
    const [row] = await db
      .select({ spotifyUri: resolvedEntitiesTable.spotifyUri, youtubeId: resolvedEntitiesTable.youtubeId })
      .from(resolvedEntitiesTable)
      .where(eq(resolvedEntitiesTable.mbid, mbid))
      .limit(1);

    if (!row) return null;

    // spotify_uri stores a raw track ID (no protocol prefix) or a full URL
    const spotifyTrackId = row.spotifyUri
      ? (row.spotifyUri.includes("open.spotify.com")
          ? parseSpotifyTrackId(row.spotifyUri)
          : row.spotifyUri)
      : null;

    return { spotifyTrackId, youtubeVideoId: row.youtubeId ?? null };
  } catch {
    return null;
  }
}

// ---- Main export ----

export async function resolveLinks(
  mbid: string,
  type: "track" | "album",
  title: string,
  artist: string,
): Promise<StreamingLinks> {
  const cacheKey   = `links:${mbid}`;
  const entityType = type === "track" ? "recording" : "release-group";
  const mbUrl      = `https://musicbrainz.org/${entityType}/${mbid}`;

  // Fast path: embed IDs already in DB
  const cached = await getCachedEmbedIds(mbid);
  if (cached?.spotifyTrackId || cached?.youtubeVideoId) {
    const spotifyTrackId = cached.spotifyTrackId;
    const youtubeVideoId = cached.youtubeVideoId;
    return {
      spotify:     spotifyTrackId ? `https://open.spotify.com/track/${spotifyTrackId}` : spotifySearchUrl(artist, title),
      youtube:     youtubeVideoId ? `https://www.youtube.com/watch?v=${youtubeVideoId}` : youtubeSearchUrl(artist, title),
      appleMusic:  null,
      source:      "odesli",
      spotifyTrackId,
      youtubeVideoId,
    };
  }

  // Odesli (HTTP-cached)
  try {
    const data = await httpGet<OdesliResponse>(
      `${ODESLI_BASE}?url=${encodeURIComponent(mbUrl)}&userCountry=US`,
      { cacheKey, cacheTtlMs: 7 * 24 * 60 * 60 * 1000 },
    );

    const platform = data.linksByPlatform ?? {};
    if (platform.spotify?.url || platform.youtube?.url) {
      const spotifyTrackId = platform.spotify?.url ? parseSpotifyTrackId(platform.spotify.url) : null;
      const youtubeVideoId = platform.youtube?.url ? parseYouTubeVideoId(platform.youtube.url) : null;

      // Persist asynchronously — don't block the response
      cacheEmbedIds(mbid, spotifyTrackId, youtubeVideoId).catch(() => null);

      return {
        spotify:     platform.spotify?.url    ?? spotifySearchUrl(artist, title),
        youtube:     platform.youtube?.url    ?? youtubeSearchUrl(artist, title),
        appleMusic:  platform.appleMusic?.url ?? null,
        source:      "odesli",
        spotifyTrackId,
        youtubeVideoId,
      };
    }
  } catch (err) {
    logger.warn({ err, mbid }, "Odesli failed, falling back to search URLs");
  }

  return {
    spotify:        spotifySearchUrl(artist, title),
    youtube:        youtubeSearchUrl(artist, title),
    appleMusic:     null,
    source:         "search_fallback",
    spotifyTrackId: null,
    youtubeVideoId: null,
  };
}
