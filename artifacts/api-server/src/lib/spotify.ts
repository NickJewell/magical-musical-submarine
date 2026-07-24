/**
 * Spotify OAuth (PKCE) helpers + playlist export.
 * Feature-gated: only active when FEATURE_SPOTIFY_EXPORT=true and credentials are set.
 */

import crypto from "node:crypto";
import {
  db, spotifyAccountsTable, spotifyPlaylistsTable,
  recommendationsTable, resolvedEntitiesTable, diveStepsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger";

export const SPOTIFY_ENABLED =
  process.env.FEATURE_SPOTIFY_EXPORT === "true" &&
  !!process.env.SPOTIFY_CLIENT_ID &&
  !!process.env.SPOTIFY_CLIENT_SECRET;

const CLIENT_ID      = process.env.SPOTIFY_CLIENT_ID     ?? "";
const CLIENT_SECRET  = process.env.SPOTIFY_CLIENT_SECRET ?? "";
const REDIRECT_URI   = process.env.SPOTIFY_REDIRECT_URI  ?? "";
const SCOPES         = "playlist-modify-private playlist-modify-public";
const SESSION_SECRET = process.env.SESSION_SECRET        ?? "dev-secret";

// ---- PKCE ----

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier  = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

// ---- State signing (CSRF) ----

export function signState(userId: number): string {
  const ts  = Date.now().toString();
  const sig = crypto.createHmac("sha256", SESSION_SECRET)
    .update(`${userId}:${ts}`).digest("hex").slice(0, 16);
  return `${userId}:${ts}:${sig}`;
}

export function verifyState(state: string): number | null {
  const parts = state.split(":");
  if (parts.length !== 3) return null;
  const [uid, ts, sig] = parts;
  if (Date.now() - Number(ts) > 15 * 60 * 1000) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET)
    .update(`${uid}:${ts}`).digest("hex").slice(0, 16);
  return expected === sig ? Number(uid) : null;
}

// ---- Token management ----

export async function getValidToken(userId: number): Promise<string | null> {
  const rows = await db
    .select()
    .from(spotifyAccountsTable)
    .where(eq(spotifyAccountsTable.userId, userId))
    .limit(1);
  if (!rows.length) return null;
  const acct = rows[0];
  if (acct.tokenExpiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    return refreshAccessToken(userId, acct.refreshToken);
  }
  return acct.accessToken;
}

async function refreshAccessToken(userId: number, token: string): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token", refresh_token: token,
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    });
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) {
      logger.warn({ userId, status: r.status }, "Spotify token refresh failed — clearing account");
      await db.delete(spotifyAccountsTable).where(eq(spotifyAccountsTable.userId, userId));
      return null;
    }
    const d = await r.json() as { access_token: string; expires_in: number; refresh_token?: string };
    const expiresAt = new Date(Date.now() + d.expires_in * 1000);
    await db.update(spotifyAccountsTable)
      .set({ accessToken: d.access_token, tokenExpiresAt: expiresAt, ...(d.refresh_token ? { refreshToken: d.refresh_token } : {}) })
      .where(eq(spotifyAccountsTable.userId, userId));
    return d.access_token;
  } catch (err) {
    logger.error({ err, userId }, "Spotify token refresh threw");
    return null;
  }
}

// ---- Auth URL ----

export function buildAuthUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code",
    redirect_uri: REDIRECT_URI, scope: SCOPES, state,
    code_challenge_method: "S256", code_challenge: codeChallenge,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

// ---- Code exchange ----

export async function exchangeCode(code: string, codeVerifier: string) {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID, code_verifier: codeVerifier,
    });
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) return null;
    const d = await r.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresIn: d.expires_in, scope: d.scope };
  } catch {
    return null;
  }
}

// ---- Spotify user ----

export async function getSpotifyUserId(token: string): Promise<string | null> {
  try {
    const r = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const d = await r.json() as { id: string };
    return d.id;
  } catch { return null; }
}

// ---- Spotify URI resolution ----

async function resolveSpotifyUriWithToken(
  rec: { mbid: string; title: string; artist: string; linksJson: unknown },
  token: string,
): Promise<string | null> {
  // 1. DB cache
  const cached = await db.select({ spotifyUri: resolvedEntitiesTable.spotifyUri })
    .from(resolvedEntitiesTable).where(eq(resolvedEntitiesTable.mbid, rec.mbid)).limit(1);
  if (cached[0]?.spotifyUri) return cached[0].spotifyUri;

  // 2. Extract from existing Odesli links JSON
  const links = rec.linksJson as Record<string, unknown> | null;
  if (links?.spotify && typeof links.spotify === "string") {
    const match = links.spotify.match(/spotify\.com\/track\/([A-Za-z0-9]+)/);
    if (match) {
      const uri = `spotify:track:${match[1]}`;
      await cacheUri(rec.mbid, uri);
      return uri;
    }
  }

  // 3. Spotify search
  try {
    const q = encodeURIComponent(`track:"${rec.title}" artist:"${rec.artist}"`);
    const r = await fetch(`https://api.spotify.com/v1/search?type=track&q=${q}&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = await r.json() as { tracks?: { items?: Array<{ uri: string }> } };
    const uri = d.tracks?.items?.[0]?.uri;
    if (uri) { await cacheUri(rec.mbid, uri); return uri; }
  } catch { /* skip */ }
  return null;
}

async function cacheUri(mbid: string, uri: string) {
  try {
    await db.update(resolvedEntitiesTable).set({ spotifyUri: uri }).where(eq(resolvedEntitiesTable.mbid, mbid));
  } catch { /* best-effort */ }
}

// ---- Playlist export ----

export interface ExportResult {
  playlistUrl: string; name: string; added: number; total: number;
  skipped: Array<{ title: string; artist: string; reason: string }>;
}

function sanitizePlaylistTitle(s: string): string {
  return s.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
}

export async function exportDivePath(
  userId: number, diveStepId: number, visibility: "private" | "public" = "private",
): Promise<ExportResult> {
  const token = await getValidToken(userId);
  if (!token) throw Object.assign(new Error("not_connected"), { code: "not_connected" });

  const recs = await db.select().from(recommendationsTable)
    .where(and(eq(recommendationsTable.diveStepId, diveStepId), eq(recommendationsTable.arm, "llm")));

  const acctRows = await db.select().from(spotifyAccountsTable)
    .where(eq(spotifyAccountsTable.userId, userId)).limit(1);
  const spotifyUserId = acctRows[0].spotifyUserId;

  const resolved: Array<{ uri: string; title: string; artist: string }> = [];
  const skipped:  Array<{ title: string; artist: string; reason: string }> = [];

  for (const rec of recs) {
    const uri = await resolveSpotifyUriWithToken(
      { mbid: rec.mbid, title: rec.title, artist: rec.artist, linksJson: rec.linksJson }, token,
    );
    if (uri) resolved.push({ uri, title: rec.title, artist: rec.artist });
    else skipped.push({ title: rec.title, artist: rec.artist, reason: "Not found on Spotify" });
  }

  if (resolved.length === 0) throw Object.assign(new Error("empty_path"), { code: "empty_path", skipped });

  // Build playlist name
  const stepRows = await db.select({ chosenDirection: diveStepsTable.chosenDirection, createdAt: diveStepsTable.createdAt })
    .from(diveStepsTable).where(eq(diveStepsTable.id, diveStepId)).limit(1);
  const step = stepRows[0];
  const dateStr = (step?.createdAt ?? new Date()).toISOString().slice(0, 10);
  const rawTitle = sanitizePlaylistTitle(step?.chosenDirection ?? "Dive");
  const playlistName = `MMS_${dateStr}_${rawTitle}`;

  // Dedup check
  const existing = await db.select().from(spotifyPlaylistsTable)
    .where(and(eq(spotifyPlaylistsTable.userId, userId), eq(spotifyPlaylistsTable.diveStepId, diveStepId)))
    .limit(1);

  if (existing.length > 0) {
    const playlistId  = existing[0].spotifyPlaylistId;
    const playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;
    const currentR = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=items(track(uri))&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const currentData = await currentR.json() as { items?: Array<{ track?: { uri: string } }> };
    const existingUris = new Set((currentData.items ?? []).map((i) => i.track?.uri).filter(Boolean));
    const newUris = resolved.filter((r) => !existingUris.has(r.uri)).map((r) => r.uri);
    if (newUris.length > 0) await addTracks(playlistId, newUris, token);
    await db.update(spotifyPlaylistsTable)
      .set({ tracksAdded: existing[0].tracksAdded + newUris.length, tracksTotal: resolved.length })
      .where(eq(spotifyPlaylistsTable.id, existing[0].id));
    return { playlistUrl, name: playlistName, added: newUris.length, total: resolved.length, skipped };
  }

  // Create playlist
  const createR = await fetch(`https://api.spotify.com/v1/users/${spotifyUserId}/playlists`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: playlistName, public: visibility === "public", description: "Created by Magical Musical Submarine" }),
  });
  if (!createR.ok) {
    if (createR.status === 403) throw Object.assign(new Error("dev_mode_allowlist"), { code: "dev_mode_allowlist" });
    throw new Error(`Spotify playlist create failed: ${createR.status}`);
  }
  const playlist = await createR.json() as { id: string; external_urls: { spotify: string } };
  await addTracks(playlist.id, resolved.map((r) => r.uri), token);
  await db.insert(spotifyPlaylistsTable).values({
    userId, diveStepId, spotifyPlaylistId: playlist.id,
    name: playlistName, tracksAdded: resolved.length, tracksTotal: resolved.length,
  });
  return { playlistUrl: playlist.external_urls.spotify, name: playlistName, added: resolved.length, total: resolved.length, skipped };
}

async function addTracks(playlistId: string, uris: string[], token: string) {
  for (let i = 0; i < uris.length; i += 100) {
    await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
  }
}
