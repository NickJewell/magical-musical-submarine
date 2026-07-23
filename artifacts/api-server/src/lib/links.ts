/**
 * Streaming links: Odesli primary + Spotify search-URL fallback.
 * Always returns a spotify link — either direct or search fallback.
 */

import { httpGet } from "./http";
import { logger } from "./logger";

const ODESLI_BASE = "https://api.song.link/v1-alpha.1/links";

interface OdesliResponse {
  linksByPlatform?: {
    spotify?: { url: string };
    youtube?: { url: string };
    appleMusic?: { url: string };
  };
}

export interface StreamingLinks {
  spotify: string | null;
  youtube: string | null;
  appleMusic: string | null;
  source: "odesli" | "search_fallback";
}

function spotifySearchUrl(artist: string, title: string): string {
  const q = encodeURIComponent(`${artist} ${title}`);
  return `https://open.spotify.com/search/${q}`;
}

function youtubeSearchUrl(artist: string, title: string): string {
  const q = encodeURIComponent(`${artist} ${title}`);
  return `https://www.youtube.com/results?search_query=${q}`;
}

export async function resolveLinks(
  mbid: string,
  type: "track" | "album",
  title: string,
  artist: string
): Promise<StreamingLinks> {
  const cacheKey = `links:${mbid}`;
  const entityType = type === "track" ? "recording" : "release-group";
  const mbUrl = `https://musicbrainz.org/${entityType}/${mbid}`;

  try {
    const data = await httpGet<OdesliResponse>(
      `${ODESLI_BASE}?url=${encodeURIComponent(mbUrl)}&userCountry=US`,
      { cacheKey, cacheTtlMs: 7 * 24 * 60 * 60 * 1000 }
    );

    const platform = data.linksByPlatform ?? {};
    if (platform.spotify?.url || platform.youtube?.url) {
      return {
        spotify: platform.spotify?.url ?? spotifySearchUrl(artist, title),
        youtube: platform.youtube?.url ?? youtubeSearchUrl(artist, title),
        appleMusic: platform.appleMusic?.url ?? null,
        source: "odesli",
      };
    }
  } catch (err) {
    logger.warn({ err, mbid }, "Odesli failed, falling back to Spotify search URL");
  }

  // Fallback: build search URLs from verified metadata
  return {
    spotify: spotifySearchUrl(artist, title),
    youtube: youtubeSearchUrl(artist, title),
    appleMusic: null,
    source: "search_fallback",
  };
}
