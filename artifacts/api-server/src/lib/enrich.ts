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

export async function lastfmSimilarArtists(artist: string): Promise<SimilarArtist[]> {
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

export async function lastfmTagTopArtists(tag: string): Promise<SimilarArtist[]> {
  if (!LASTFM_KEY) return [];
  const url =
    `${LASTFM_BASE}/?method=tag.gettopartists&tag=${encodeURIComponent(tag)}` +
    `&api_key=${LASTFM_KEY}&format=json&limit=20`;
  try {
    interface LFMTagArtistsResp {
      topartists?: { artist?: Array<{ name: string }> };
    }
    const data = await httpGet<LFMTagArtistsResp>(url, {
      cacheKey: `lfm:tagartists:${tag.toLowerCase()}`,
      cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    });
    // tag.gettopartists is rank-ordered; synthesize a descending match score.
    const artists = data.topartists?.artist ?? [];
    return artists.map((a, i) => ({ name: a.name, match: 1 - i / Math.max(artists.length, 1) }));
  } catch (err) {
    logger.warn({ err, tag }, "Last.fm tag.gettopartists failed");
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

// ---- Top tracks for a given artist (used by well-trodden direction) ----

export async function lastfmTopTrack(
  artist: string,
): Promise<{ name: string; artist: string } | null> {
  if (!LASTFM_KEY) return null;
  const url =
    `${LASTFM_BASE}/?method=artist.gettoptracks&artist=${encodeURIComponent(artist)}` +
    `&api_key=${LASTFM_KEY}&format=json&limit=3`;
  try {
    interface LFMTopResp {
      toptracks?: { track?: Array<{ name: string }> };
    }
    const data = await httpGet<LFMTopResp>(url, {
      cacheKey: `lfm:toptracks:${artist.toLowerCase()}`,
      cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    });
    const track = data.toptracks?.track?.[0];
    return track ? { name: track.name, artist } : null;
  } catch (err) {
    logger.debug({ err, artist }, "Last.fm artist.gettoptracks failed");
    return null;
  }
}

/**
 * Aggregate Last.fm similar artists across a set of anchor artists (e.g. the
 * three tracks of a dive section), ranked by how many anchors they neighbour
 * (centrality) then summed match. Anchors themselves are excluded. Used to seed
 * a "dive deeper into this section" expedition from the section's own tracks.
 */
export async function aggregateSimilarArtists(artists: string[]): Promise<SimilarArtist[]> {
  const anchors = new Set(artists.map((a) => a.toLowerCase()));
  const lists = await Promise.all(artists.map((a) => lastfmSimilarArtists(a).catch(() => [])));
  const agg = new Map<string, { name: string; match: number; hits: number }>();
  for (const list of lists) {
    for (const a of list) {
      const key = a.name.toLowerCase();
      if (anchors.has(key)) continue;
      const cur = agg.get(key) ?? { name: a.name, match: 0, hits: 0 };
      cur.match += a.match;
      cur.hits += 1;
      agg.set(key, cur);
    }
  }
  return [...agg.values()]
    .sort((x, y) => y.hits - x.hits || y.match - x.match)
    .map((a) => ({ name: a.name, match: a.match }));
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

/** A user-chosen starting point for a focused dive. */
export interface Focus {
  kind: "genre" | "subgenre" | "artist" | "album" | "track";
  label: string;
  artist?: string | null;
  mbid?: string | null;
}

/**
 * Enrich from a single chosen focus rather than the user's seeds.
 * - genre/subgenre → Last.fm tag top artists (the tag itself is the anchor tag).
 * - artist          → similar artists + that artist's top tags.
 * - album/track     → the performing artist's similar artists (+ similar tracks
 *                     for a track focus) + top tags.
 */
export async function enrichFromFocus(focus: Focus): Promise<EnrichResult> {
  if (focus.kind === "genre" || focus.kind === "subgenre") {
    const similarArtists = await lastfmTagTopArtists(focus.label);
    return {
      similarArtists,
      similarTracks: [],
      tags: [focus.label],
      wellTroddenArtist: similarArtists[0]?.name ?? null,
    };
  }

  // artist / album / track — anchor on the performing artist.
  const anchorArtist = focus.artist?.trim() || focus.label;
  const anchorTrack = focus.kind === "track" ? focus.label : undefined;

  const [similarArtists, similarTracks, tags] = await Promise.all([
    lastfmSimilarArtists(anchorArtist),
    anchorTrack
      ? lastfmSimilarTracks(anchorArtist, anchorTrack)
      : Promise.resolve<SimilarTrack[]>([]),
    lastfmTopTags(anchorArtist),
  ]);

  return {
    similarArtists,
    similarTracks,
    tags,
    wellTroddenArtist: similarArtists[0]?.name ?? null,
  };
}
