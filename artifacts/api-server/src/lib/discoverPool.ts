/**
 * Ingests external playlists into the `discover_pool` table that feeds the Home
 * "Discover & rank" feed. Prefers the official Spotify Web API (client-
 * credentials — no user auth needed for public playlists) when credentials are
 * configured, and falls back to scraping the public embed page's `__NEXT_DATA__`
 * blob, which needs no credentials at all.
 *
 * De-dupe is by Spotify track id (a UNIQUE column), so re-ingesting the same
 * playlist — or appending another — never creates duplicates.
 */

import { db, discoverPoolTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/** The playlist to seed the pool from. */
export const DEFAULT_DISCOVER_PLAYLIST = "5kPryhMGw5XFRhtR0O17Lr";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET ?? "";

interface PoolTrack {
  spotifyId: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  previewUrl: string | null;
}

// ---- Official Web API (client-credentials) ----

async function getAppToken(): Promise<string | null> {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchViaApi(playlistId: string, token: string): Promise<PoolTrack[]> {
  const out: PoolTrack[] = [];
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks` +
    `?fields=next,items(track(id,name,preview_url,artists(name),album(name,images(url))))&limit=100`;

  let guard = 0;
  while (url && guard++ < 20) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const data = (await res.json()) as {
      next: string | null;
      items: Array<{
        track: {
          id: string | null;
          name: string;
          preview_url: string | null;
          artists: Array<{ name: string }>;
          album: { name: string; images: Array<{ url: string }> };
        } | null;
      }>;
    };
    for (const item of data.items ?? []) {
      const t = item.track;
      if (!t?.id) continue;
      out.push({
        spotifyId: t.id,
        title: t.name,
        artist: t.artists.map((a) => a.name).join(", ") || "Unknown artist",
        album: t.album?.name ?? null,
        artworkUrl: t.album?.images?.[0]?.url ?? null,
        previewUrl: t.preview_url ?? null,
      });
    }
    url = data.next;
  }
  return out;
}

// ---- Public embed scrape (no auth) ----

/** Recursively find the first `trackList` array anywhere in the parsed blob. */
function findTrackList(node: unknown): unknown[] | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTrackList(child);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.trackList) && obj.trackList.length > 0) return obj.trackList as unknown[];
  for (const v of Object.values(obj)) {
    const found = findTrackList(v);
    if (found) return found;
  }
  return null;
}

function idFromUri(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  const m = uri.match(/spotify:track:([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

async function fetchViaEmbed(playlistId: string): Promise<PoolTrack[]> {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];

  let blob: unknown;
  try {
    blob = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const list = findTrackList(blob);
  if (!list) return [];

  const out: PoolTrack[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const spotifyId = idFromUri(item.uri);
    if (!spotifyId) continue;
    const title = typeof item.title === "string" ? item.title : null;
    const artist =
      typeof item.subtitle === "string" && item.subtitle.trim()
        ? item.subtitle
        : Array.isArray(item.artists)
          ? (item.artists as Array<{ name?: string }>).map((a) => a.name).filter(Boolean).join(", ")
          : null;
    if (!title || !artist) continue;
    const audioPreview = item.audioPreview as { url?: string } | undefined;
    out.push({
      spotifyId,
      title,
      artist,
      album: null,
      artworkUrl: null,
      previewUrl: typeof audioPreview?.url === "string" ? audioPreview.url : null,
    });
  }
  return out;
}

async function fetchPlaylistTracks(playlistId: string): Promise<PoolTrack[]> {
  const token = await getAppToken();
  if (token) {
    const viaApi = await fetchViaApi(playlistId, token).catch(() => []);
    if (viaApi.length > 0) return viaApi;
  }
  return fetchViaEmbed(playlistId).catch(() => []);
}

// ---- Ingest ----

export async function ingestSpotifyPlaylist(
  playlistId: string = DEFAULT_DISCOVER_PLAYLIST,
): Promise<{ added: number; fetched: number }> {
  const tracks = await fetchPlaylistTracks(playlistId);
  if (tracks.length === 0) {
    logger.warn({ playlistId }, "discover pool: fetched 0 tracks from playlist");
    return { added: 0, fetched: 0 };
  }

  // De-dupe within this batch (a single INSERT can't touch the same conflict row twice).
  const seen = new Set<string>();
  const rows = tracks
    .filter((t) => (seen.has(t.spotifyId) ? false : (seen.add(t.spotifyId), true)))
    .map((t) => ({
      source: "spotify_playlist",
      sourceId: playlistId,
      spotifyId: t.spotifyId,
      title: t.title,
      artist: t.artist,
      album: t.album,
      artworkUrl: t.artworkUrl,
      previewUrl: t.previewUrl,
    }));

  const inserted = await db
    .insert(discoverPoolTable)
    .values(rows)
    .onConflictDoNothing({ target: discoverPoolTable.spotifyId })
    .returning({ id: discoverPoolTable.id })
    .catch((err) => {
      logger.error({ err, playlistId }, "discover pool: insert failed");
      return [] as Array<{ id: number }>;
    });

  logger.info({ playlistId, fetched: rows.length, added: inserted.length }, "discover pool: ingested");
  return { added: inserted.length, fetched: rows.length };
}

// ---- Lazy first-time seeding ----

let seedAttempted = false;

/**
 * Fire-and-forget: if the pool is empty, ingest the default playlist once per
 * process. Called opportunistically from the discover feed so the pool
 * self-populates after deploy without a manual trigger. Never throws.
 */
export function ensurePoolSeeded(): void {
  if (seedAttempted) return;
  seedAttempted = true;
  (async () => {
    try {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(discoverPoolTable);
      if (Number(count) > 0) return;
      await ingestSpotifyPlaylist();
    } catch (err) {
      logger.warn({ err: String(err) }, "discover pool: lazy seed failed");
    }
  })();
}
