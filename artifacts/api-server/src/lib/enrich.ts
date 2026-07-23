/**
 * Last.fm enrichment — control arm + contrastive steering.
 * Falls back to ListenBrainz if LASTFM_API_KEY is absent.
 */

import { httpGet } from "./http";
import { logger } from "./logger";

const LASTFM_KEY = process.env.LASTFM_API_KEY;
const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0";
const LB_BASE = "https://api.listenbrainz.org/1";

export interface SimilarArtist {
  name: string;
  match: number;
}

export interface SimilarTrack {
  name: string;
  artist: string;
  match: number;
}

// ---- Last.fm ----

async function lastfmSimilarArtists(artist: string): Promise<SimilarArtist[]> {
  if (!LASTFM_KEY) return [];
  const url =
    `${LASTFM_BASE}/?method=artist.getsimilar&artist=${encodeURIComponent(artist)}` +
    `&api_key=${LASTFM_KEY}&format=json&limit=20`;
  try {
    interface LFMResp {
      similarartists?: { artist?: Array<{ name: string; match: string }> };
    }
    const data = await httpGet<LFMResp>(url, {
      cacheKey: `lfm:similar:${artist.toLowerCase()}`,
      cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    });
    return (data.similarartists?.artist ?? []).map((a) => ({
      name: a.name,
      match: parseFloat(a.match),
    }));
  } catch (err) {
    logger.warn({ err, artist }, "Last.fm artist.getsimilar failed");
    return [];
  }
}

async function lastfmSimilarTracks(artist: string, track: string): Promise<SimilarTrack[]> {
  if (!LASTFM_KEY) return [];
  const url =
    `${LASTFM_BASE}/?method=track.getsimilar` +
    `&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}` +
    `&api_key=${LASTFM_KEY}&format=json&limit=10`;
  try {
    interface LFMTrackResp {
      similartracks?: {
        track?: Array<{ name: string; artist: { name: string }; match: string }>;
      };
    }
    const data = await httpGet<LFMTrackResp>(url, {
      cacheKey: `lfm:simtrack:${artist.toLowerCase()}:${track.toLowerCase()}`,
      cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    });
    return (data.similartracks?.track ?? []).map((t) => ({
      name: t.name,
      artist: t.artist.name,
      match: parseFloat(t.match),
    }));
  } catch (err) {
    logger.warn({ err, artist, track }, "Last.fm track.getsimilar failed");
    return [];
  }
}

async function lastfmTopTags(artist: string): Promise<string[]> {
  if (!LASTFM_KEY) return [];
  const url =
    `${LASTFM_BASE}/?method=artist.gettoptags&artist=${encodeURIComponent(artist)}` +
    `&api_key=${LASTFM_KEY}&format=json&limit=5`;
  try {
    interface LFMTagResp {
      toptags?: { tag?: Array<{ name: string }> };
    }
    const data = await httpGet<LFMTagResp>(url, {
      cacheKey: `lfm:tags:${artist.toLowerCase()}`,
      cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    });
    return (data.toptags?.tag ?? []).map((t) => t.name);
  } catch (err) {
    logger.warn({ err, artist }, "Last.fm artist.gettoptags failed");
    return [];
  }
}

// ---- ListenBrainz fallback ----

async function lbSimilarArtists(artistMbid: string): Promise<SimilarArtist[]> {
  const url = `${LB_BASE}/lb-radio/similar-artists/${artistMbid}`;
  try {
    interface LBResp {
      payload?: Array<{ name: string; similarity: number }>;
    }
    const data = await httpGet<LBResp>(url, {
      cacheKey: `lb:similar:${artistMbid}`,
      cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    });
    return (data.payload ?? []).map((a) => ({ name: a.name, match: a.similarity }));
  } catch {
    return [];
  }
}

// ---- Public API ----

export interface EnrichResult {
  similarArtists: SimilarArtist[];
  similarTracks: SimilarTrack[];
  tags: string[];
  /** The top well-trodden pick (control arm) */
  wellTroddenArtist: string | null;
}

export async function enrichFromSeeds(
  seeds: Array<{ artist: string; title?: string; artistMbid?: string }>
): Promise<EnrichResult> {
  if (seeds.length === 0) {
    return { similarArtists: [], similarTracks: [], tags: [], wellTroddenArtist: null };
  }

  // Use the first seed as the anchor
  const primary = seeds[0];

  const [similarArtists, similarTracks, tags] = await Promise.all([
    lastfmSimilarArtists(primary.artist).then(async (r) => {
      if (r.length > 0) return r;
      // Fallback to ListenBrainz if we have MBID
      if (primary.artistMbid) return lbSimilarArtists(primary.artistMbid);
      return [];
    }),
    primary.title
      ? lastfmSimilarTracks(primary.artist, primary.title)
      : Promise.resolve<SimilarTrack[]>([]),
    lastfmTopTags(primary.artist),
  ]);

  const wellTroddenArtist = similarArtists.length > 0 ? similarArtists[0].name : null;

  return { similarArtists, similarTracks, tags, wellTroddenArtist };
}
