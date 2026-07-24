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
  source:         "odesli" | "odesli_am" | "mb_relations" | "deezer" | "search_fallback";
  spotifyTrackId: string | null;
  youtubeVideoId: string | null;
  deezerId:       string | null;
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

interface ItunesData {
  artworkUrl:   string | null;
  trackViewUrl: string | null; // Apple Music URL — a first-class Odesli source
}

interface DeezerTrack { id: number; preview?: string }
interface DeezerSearchResp { data?: DeezerTrack[] }

/** Deezer search — free, no auth. Returns Deezer track ID for embeds. Non-throwing. */
async function fetchDeezerData(artist: string, title: string): Promise<{ deezerId: string | null }> {
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const data = await httpGet<DeezerSearchResp>(
      `https://api.deezer.com/search?q=${q}&limit=1`,
      { cacheKey: `deezer:${artist.toLowerCase()}:${title.toLowerCase()}`, cacheTtlMs: 30 * 24 * 60 * 60 * 1000 },
    );
    const track = data.data?.[0];
    if (!track) return { deezerId: null };
    return { deezerId: String(track.id) };
  } catch {
    return { deezerId: null };
  }
}

/** iTunes Search API — returns artwork (upscaled) and Apple Music track URL. Non-throwing. */
async function fetchItunesData(artist: string, title: string): Promise<ItunesData> {
  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    interface ItunesResp { results?: Array<{ artworkUrl100?: string; trackViewUrl?: string }> }
    const data = await httpGet<ItunesResp>(
      `https://itunes.apple.com/search?term=${term}&entity=song&media=music&limit=1`,
      {
        cacheKey: `itunes:${artist.toLowerCase()}:${title.toLowerCase()}`,
        cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
      },
    );
    const result = data.results?.[0];
    return {
      artworkUrl:   result?.artworkUrl100?.replace(/\d+x\d+bb/, "500x500bb") ?? null,
      trackViewUrl: result?.trackViewUrl ?? null,
    };
  } catch {
    return { artworkUrl: null, trackViewUrl: null };
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

/**
 * Mine Spotify / YouTube IDs out of the MusicBrainz url-rels block that is
 * already stored in resolved_entities.relationships_json.  MB records streaming
 * links as URL relationships, so for most commercially-released tracks this
 * gives us a direct track ID with zero Odesli calls.
 */
function extractEmbedIdsFromRelationships(relJson: unknown): {
  spotifyTrackId: string | null;
  youtubeVideoId: string | null;
} {
  let spotifyTrackId: string | null = null;
  let youtubeVideoId: string | null = null;
  const relations: unknown[] = (relJson as Record<string, unknown>)?.relations as unknown[] ?? [];
  for (const rel of relations) {
    const resource: string = ((rel as Record<string, unknown>)?.url as Record<string, unknown>)?.resource as string ?? "";
    if (!spotifyTrackId) {
      const m = resource.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
      if (m) spotifyTrackId = m[1];
    }
    if (!youtubeVideoId) {
      const m =
        resource.match(/youtube\.com\/watch[^?]*\?.*[?&]v=([A-Za-z0-9_-]+)/) ??
        resource.match(/youtu\.be\/([A-Za-z0-9_-]+)/);
      if (m) youtubeVideoId = m[1];
    }
    if (spotifyTrackId && youtubeVideoId) break;
  }
  return { spotifyTrackId, youtubeVideoId };
}

async function getCachedEmbedIds(mbid: string): Promise<{
  spotifyTrackId:    string | null;
  youtubeVideoId:    string | null;
  artworkUrl:        string | null;
  relationshipsJson: unknown;
} | null> {
  try {
    const [row] = await db
      .select({
        spotifyUri:        resolvedEntitiesTable.spotifyUri,
        youtubeId:         resolvedEntitiesTable.youtubeId,
        artworkUrl:        resolvedEntitiesTable.artworkUrl,
        relationshipsJson: resolvedEntitiesTable.relationshipsJson,
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
      youtubeVideoId:    row.youtubeId         ?? null,
      artworkUrl:        row.artworkUrl         ?? null,
      relationshipsJson: row.relationshipsJson  ?? null,
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
  // ── Step 1: DB fast-path ────────────────────────────────────────────────────
  // Check dedicated spotifyUri / youtubeId columns first.
  // If those are empty, mine the MusicBrainz url-rels already stored in
  // relationships_json — no Odesli call required for most released tracks.
  const cached = await getCachedEmbedIds(mbid);
  if (cached) {
    let { spotifyTrackId, youtubeVideoId, artworkUrl } = cached;

    // Promote from MB relationships if the dedicated columns are still empty
    if (!spotifyTrackId && !youtubeVideoId && cached.relationshipsJson) {
      const extracted = extractEmbedIdsFromRelationships(cached.relationshipsJson);
      spotifyTrackId = extracted.spotifyTrackId;
      youtubeVideoId = extracted.youtubeVideoId;
      if (spotifyTrackId || youtubeVideoId) {
        // Persist so next call takes the fast path
        cacheEmbedIds(mbid, spotifyTrackId, youtubeVideoId, null).catch(() => null);
      }
    }

    if (spotifyTrackId || youtubeVideoId) {
      if (!artworkUrl) {
        fetchItunesData(artist, title)
          .then(({ artworkUrl: url }) => url && cacheEmbedIds(mbid, null, null, url))
          .catch(() => null);
      }
      return {
        spotify:        spotifyTrackId ? `https://open.spotify.com/track/${spotifyTrackId}` : spotifySearchUrl(artist, title),
        youtube:        youtubeVideoId ? `https://www.youtube.com/watch?v=${youtubeVideoId}` : youtubeSearchUrl(artist, title),
        appleMusic:     null,
        source:         "mb_relations",
        spotifyTrackId,
        youtubeVideoId,
        deezerId:       null,
        artworkUrl,
      };
    }
  }

  // ── Step 2: Fake/placeholder MBIDs ──────────────────────────────────────────
  // e.g. `lastfm:lee-morgan:the-sidewinder` — no MusicBrainz row exists.
  // Await iTunes synchronously so we can return artwork immediately.
  if (!isRealMbid(mbid)) {
    const { artworkUrl, trackViewUrl } = await fetchItunesData(artist, title);
    const { deezerId } = await fetchDeezerData(artist, title);
    return {
      spotify:        spotifySearchUrl(artist, title),
      youtube:        youtubeSearchUrl(artist, title),
      appleMusic:     trackViewUrl ?? null,
      source:         deezerId ? "deezer" : "search_fallback",
      spotifyTrackId: null,
      youtubeVideoId: null,
      deezerId:       deezerId ?? null,
      artworkUrl,
    };
  }

  // ── Step 3: Odesli (one attempt via MusicBrainz URL) ────────────────────────
  // retries:1 = single attempt; on 429/failure we fall through to Deezer instantly.
  try {
    const data = await httpGet<OdesliResponse>(
      `${ODESLI_BASE}?url=${encodeURIComponent(mbUrl)}&userCountry=US`,
      { cacheKey, cacheTtlMs: 7 * 24 * 60 * 60 * 1000, retries: 1 },
    );

    const platform       = data.linksByPlatform ?? {};
    const spotifyTrackId = platform.spotify?.url ? parseSpotifyTrackId(platform.spotify.url) : null;
    const youtubeVideoId = platform.youtube?.url ? parseYouTubeVideoId(platform.youtube.url) : null;
    const artworkUrl     = pickOdesliThumbnail(data);

    // Persist + backfill artwork asynchronously
    (async () => {
      const finalArtwork = artworkUrl ?? (await fetchItunesData(artist, title)).artworkUrl;
      await cacheEmbedIds(mbid, spotifyTrackId, youtubeVideoId, finalArtwork);
    })().catch(() => null);

    return {
      spotify:     platform.spotify?.url    ?? spotifySearchUrl(artist, title),
      youtube:     platform.youtube?.url    ?? youtubeSearchUrl(artist, title),
      appleMusic:  platform.appleMusic?.url ?? null,
      source:      "odesli",
      spotifyTrackId,
      youtubeVideoId,
      deezerId:    null,
      artworkUrl,
    };
  } catch (err) {
    logger.warn({ err, mbid }, "Odesli lookup failed — returning search URLs with iTunes artwork");
  }

  // ── Step 4: Deezer — free search, no auth, reliable embed via widget ─────────
  // Fetch iTunes in parallel with Deezer so artwork is ready regardless.
  const [{ artworkUrl: itunesArtwork, trackViewUrl }, { deezerId }] = await Promise.all([
    fetchItunesData(artist, title),
    fetchDeezerData(artist, title),
  ]);
  if (itunesArtwork) cacheEmbedIds(mbid, null, null, itunesArtwork).catch(() => null);

  if (deezerId) {
    logger.info({ mbid, deezerId }, "Using Deezer embed as final fallback");
    return {
      spotify:        spotifySearchUrl(artist, title),
      youtube:        youtubeSearchUrl(artist, title),
      appleMusic:     trackViewUrl ?? null,
      source:         "deezer",
      spotifyTrackId: null,
      youtubeVideoId: null,
      deezerId,
      artworkUrl:     itunesArtwork,
    };
  }

  // ── Step 6: absolute fallback — search URLs only ────────────────────────────
  return {
    spotify:        spotifySearchUrl(artist, title),
    youtube:        youtubeSearchUrl(artist, title),
    appleMusic:     trackViewUrl ?? null,
    source:         "search_fallback",
    spotifyTrackId: null,
    youtubeVideoId: null,
    deezerId:       null,
    artworkUrl:     itunesArtwork,
  };
}
