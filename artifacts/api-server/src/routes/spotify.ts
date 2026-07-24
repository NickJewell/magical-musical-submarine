import { Router } from "express";
import {
  db, spotifyAccountsTable, spotifyPlaylistsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  SPOTIFY_ENABLED, generatePKCE, signState, verifyState,
  buildAuthUrl, exchangeCode, getSpotifyUserId, getValidToken, exportDivePath,
} from "../lib/spotify";
import { httpGet } from "../lib/http";
import { logger } from "../lib/logger";

const router = Router();

// Guard: all /spotify/* routes return 404 when feature is disabled
function requireSpotify(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  if (!SPOTIFY_ENABLED) return res.status(404).json({ error: "Spotify export not enabled" });
  next();
}
router.use(requireSpotify);

// Temporary in-memory PKCE store (codeVerifier keyed by state, auto-expires after 15 min)
const pkceStore = new Map<string, string>();

/**
 * GET /api/spotify/status
 * Returns { enabled, connected, spotifyUserId? }
 */
router.get("/spotify/status", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId required" });

  const rows = await db
    .select({ spotifyUserId: spotifyAccountsTable.spotifyUserId })
    .from(spotifyAccountsTable)
    .where(eq(spotifyAccountsTable.userId, userId))
    .limit(1);

  return res.json({
    enabled:      SPOTIFY_ENABLED,
    connected:    rows.length > 0,
    spotifyUserId: rows[0]?.spotifyUserId ?? null,
  });
});

/**
 * GET /api/spotify/connect?userId=<n>
 * Redirects to Spotify OAuth.
 */
router.get("/spotify/connect", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId required" });

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = signState(userId);
  pkceStore.set(state, codeVerifier);
  setTimeout(() => pkceStore.delete(state), 15 * 60 * 1000);

  return res.redirect(buildAuthUrl(codeChallenge, state));
});

/**
 * GET /api/spotify/callback?code=&state=
 * Exchanges code for tokens, stores them, redirects to app.
 */
router.get("/spotify/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    logger.warn({ error }, "Spotify OAuth denied by user");
    return res.redirect("/?spotify=denied");
  }

  const userId = verifyState(state);
  if (!userId) return res.status(400).json({ error: "Invalid or expired state" });

  const codeVerifier = pkceStore.get(state);
  if (!codeVerifier) return res.status(400).json({ error: "PKCE verifier missing — try connecting again" });
  pkceStore.delete(state);

  const tokens = await exchangeCode(code, codeVerifier);
  if (!tokens) return res.status(502).json({ error: "Token exchange failed" });

  const spotifyUserId = await getSpotifyUserId(tokens.accessToken);
  if (!spotifyUserId) return res.status(502).json({ error: "Could not fetch Spotify user ID" });

  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

  await db
    .insert(spotifyAccountsTable)
    .values({
      userId,
      spotifyUserId,
      accessToken:    tokens.accessToken,
      refreshToken:   tokens.refreshToken,
      tokenExpiresAt: expiresAt,
      scope:          tokens.scope,
    })
    .onConflictDoUpdate({
      target: spotifyAccountsTable.userId,
      set: {
        spotifyUserId,
        accessToken:    tokens.accessToken,
        refreshToken:   tokens.refreshToken,
        tokenExpiresAt: expiresAt,
        scope:          tokens.scope,
      },
    });

  logger.info({ userId, spotifyUserId }, "Spotify account connected");
  return res.redirect("/?spotify=connected");
});

/**
 * POST /api/spotify/export-path
 * Body: { userId, diveStepId, visibility? }
 */
router.post("/spotify/export-path", async (req, res) => {
  const { userId, diveStepId, visibility = "private" } = req.body as {
    userId: number; diveStepId: number; visibility?: "private" | "public";
  };
  if (!userId || !diveStepId) return res.status(400).json({ error: "userId and diveStepId required" });

  try {
    const result = await exportDivePath(userId, diveStepId, visibility);
    return res.json(result);
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string; skipped?: unknown[] };
    if (e.code === "not_connected") return res.status(409).json({ error: "not_connected" });
    if (e.code === "empty_path")    return res.status(422).json({ error: "empty_path", skipped: e.skipped });
    if (e.code === "dev_mode_allowlist") return res.status(403).json({
      error: "Your Spotify account isn't on the developer allowlist. Add your email in the Spotify developer dashboard to enable export.",
    });
    logger.error({ err, userId, diveStepId }, "Spotify export failed");
    return res.status(500).json({ error: "Export failed" });
  }
});

/**
 * DELETE /api/spotify/disconnect?userId=<n>
 * Removes stored tokens.
 */
router.delete("/spotify/disconnect", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId required" });
  await db.delete(spotifyAccountsTable).where(eq(spotifyAccountsTable.userId, userId));
  logger.info({ userId }, "Spotify account disconnected");
  return res.json({ ok: true });
});

export default router;
