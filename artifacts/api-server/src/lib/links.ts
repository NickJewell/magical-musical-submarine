/**
 * Streaming links: Odesli primary + search-URL fallback.
 * Returns full deep-link URLs plus parsed embed IDs (§18) and artwork thumbnail.
 */

import { httpGet } from "./http";
import { logger } from "./logger";
import { db, resolvedEntitiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const ODESLI_BASE = "https://api.song.link/v1-alpha.1/links";

interface OdesliEntity {
  thumbnailUrl?: string | null;
  apiProvider?: string;
}

interface OdesliResponse {
  entityUniqueId?: string;
  entitiesByUniqueId?: Record<string, OdesliEntity>;
  linksByPlatform?: {
    spotify?:    { url: string; entityUniqueId?: string };
    youtube?:    { url: string; entityUniqueId?: string };
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
  artworkUrl:     string | null;
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

// ---- Artwork helpers ----

/** Pick the best thumbnail from an Odesli response.
 *  Prefer the Spotify entity (typically 640 px); fall back to any entity with one. */
function pickOdesliThumbnail(data: OdesliResponse): string | null {
  const entities = data.entitiesByUniqueId;
  if (!entities) return null;
  const spotifyId = data.linksByPlatform?.spotify?.entityUniqueId;
  if (spotifyId && entities[spotifyId]?.thumbnailUrl) return entities[spotifyId].thumbnailUrl!;
  for (const entity of Object.values(entities)) {
    if (entity.thumbnailUrl) return entity.thumbnailUrl;
  }
  return null;
}

/** iTunes Search API fallback — upscales artworkUrl100 to 500×500. Non-throwing. */
async function fetchItunesArtwork(artist: string, title: string): Promise<string | null> {
  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    interface ItunesResp { results?: Array<{ artworkUrl100?: string }> }
    const data = await httpGet<ItunesResp>(
      `https://itunes.apple.com/search?term=${term}&entity=song&media=music&limit=1`,
      {
        cacheKey: `itunes:art:${artist.toLowerCase()}:${title.toLowerCase()}`,
        cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
      },
    );
    const raw = data.results?.[0]?.artworkUrl100;
    if (!raw) return null;
    return raw.replace(/\d+x\d+bb/, "500x500bb");
  } catch {
    return null;
  }
}

// ---- DB cache helpers ----

async function cacheEmbedIds(
  mbid: string,
  spotifyTrackId: string | null,
  youtubeVideoId: string | null,
  artworkUrl: string | null,
): Promise<void> {
  if (!spotifyTrackId && !youtubeVideoId && !artworkUrl) return;
  try {
    await db
      .update(resolvedEntitiesTable)
      .set({
        ...(spotifyTrackId ? { spotifyUri: spotifyTrackId } : {}),
        ...(youtubeVideoId ? { youtubeId: youtubeVideoId } : {}),
        ...(artworkUrl     ? { artworkUrl }                : {}),
      })
      .where(eq(resolvedEntitiesTable.mbid, mbid));
  } catch (err) {
    logger.debug({ err, mbid }, "Failed to cache embed IDs — non-fatal");
  }
}

async function getCachedEmbedIds(mbid: string): Promise<{
  spotifyTrackId: string | null;
  youtubeVideoId: string | null;
  artworkUrl:     string | null;
} | null> {
  try {
    const [row] = await db
      .select({
        spotifyUri: resolvedEntitiesTable.spotifyUri,
        youtubeId:  resolvedEntitiesTable.youtubeId,
        artworkUrl: resolvedEntitiesTable.artworkUrl,
      })
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

    return {
      spotifyTrackId,
      youtubeVideoId: row.youtubeId  ?? null,
      artworkUrl:     row.artworkUrl ?? null,
    };
  } catch {
    return null;
  }
}

// ---- Helpers ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true for real MusicBrainz UUIDs; fake placeholder IDs (e.g. `lastfm:…`) return false. */
function isRealMbid(mbid: string): boolean {
  return UUID_RE.test(mbid);
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
  if (cached && (cached.spotifyTrackId || cached.youtubeVideoId)) {
    // Backfill artwork async if still missing
    if (!cached.artworkUrl) {
      fetchItunesArtwork(artist, title)
        .then((url) => url && cacheEmbedIds(mbid, null, null, url))
        .catch(() => null);
    }
    return {
      spotify:     cached.spotifyTrackId ? `https://open.spotify.com/track/${cached.spotifyTrackId}` : spotifySearchUrl(artist, title),
      youtube:     cached.youtubeVideoId ? `https://www.youtube.com/watch?v=${cached.youtubeVideoId}` : youtubeSearchUrl(artist, title),
      appleMusic:  null,
      source:      "odesli",
      spotifyTrackId: cached.spotifyTrackId,
      youtubeVideoId: cached.youtubeVideoId,
      artworkUrl:  cached.artworkUrl,
    };
  }

  // Fake/placeholder MBIDs (e.g. `lastfm:…`) can't be looked up via MusicBrainz URLs.
  // Skip Odesli entirely and go straight to iTunes artwork + search-URL fallback.
  if (!isRealMbid(mbid)) {
    fetchItunesArtwork(artist, title)
      .then((url) => url && cacheEmbedIds(mbid, null, null, url))
      .catch(() => null);
    return {
      spotify:        spotifySearchUrl(artist, title),
      youtube:        youtubeSearchUrl(artist, title),
      appleMusic:     null,
      source:         "search_fallback",
      spotifyTrackId: null,
      youtubeVideoId: null,
      artworkUrl:     null,
    };
  }

  // Odesli (HTTP-cached)
  try {
    const data = await httpGet<OdesliResponse>(
      `${ODESLI_BASE}?url=${encodeURIComponent(mbUrl)}&userCountry=US`,
      { cacheKey, cacheTtlMs: 7 * 24 * 60 * 60 * 1000 },
    );

    const platform      = data.linksByPlatform ?? {};
    const spotifyTrackId = platform.spotify?.url ? parseSpotifyTrackId(platform.spotify.url) : null;
    const youtubeVideoId = platform.youtube?.url ? parseYouTubeVideoId(platform.youtube.url) : null;
    const artworkUrl     = pickOdesliThumbnail(data);

    // Persist + backfill artwork asynchronously — never block the response
    (async () => {
      const finalArtwork = artworkUrl ?? await fetchItunesArtwork(artist, title);
      await cacheEmbedIds(mbid, spotifyTrackId, youtubeVideoId, finalArtwork);
    })().catch(() => null);

    return {
      spotify:     platform.spotify?.url    ?? spotifySearchUrl(artist, title),
      youtube:     platform.youtube?.url    ?? youtubeSearchUrl(artist, title),
      appleMusic:  platform.appleMusic?.url ?? null,
      source:      "odesli",
      spotifyTrackId,
      youtubeVideoId,
      artworkUrl,
    };
  } catch (err) {
    logger.warn({ err, mbid }, "Odesli failed, falling back to search URLs");
  }

  // Odesli failed — try iTunes artwork async so it's ready next time
  fetchItunesArtwork(artist, title)
    .then((url) => url && cacheEmbedIds(mbid, null, null, url))
    .catch(() => null);

  return {
    spotify:        spotifySearchUrl(artist, title),
    youtube:        youtubeSearchUrl(artist, title),
    appleMusic:     null,
    source:         "search_fallback",
    spotifyTrackId: null,
    youtubeVideoId: null,
    artworkUrl:     null,
  };
}
