/**
 * Canon Duel routes (§17).
 * GET  /api/duel/next  — return a verified A/B pair from the canon pool
 * POST /api/duel       — log outcome, apply seed promotion & discovery reservoir
 */

import { Router, type IRouter } from "express";
import { db, tasteEventsTable, seedsTable, resolvedEntitiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getNextDuelPair, type Strategy } from "../lib/canonPool";
import { applyComparison } from "../lib/elo";
import { logger } from "../lib/logger";
import { fetchDeezerData } from "../lib/links";

const router: IRouter = Router();

// GET /api/deezer-preview?title=&artist=[&artistFallback=1]
// artistFallback=1: when the exact title has no Deezer entry, fall back to any
// preview from the same artist — used by the Discover card for a taste preview.
router.get("/deezer-preview", async (req, res): Promise<void> => {
  const title          = String(req.query.title  ?? "").trim();
  const artist         = String(req.query.artist ?? "").trim();
  const artistFallback = req.query.artistFallback === "1";
  if (!title || !artist) { res.status(400).json({ error: "title and artist required" }); return; }
  const result = await fetchDeezerData(artist, title, { artistFallback });
  res.json(result); // { deezerId, previewUrl }
});

// GET /api/audio-proxy?url=<encoded-deezer-cdn-url>
// Server-side proxy for Deezer 30s preview MP3s — avoids browser CORS restrictions.
router.get("/audio-proxy", async (req, res): Promise<void> => {
  const url = String(req.query.url ?? "").trim();
  // Only proxy Deezer CDN preview URLs
  let parsed: URL;
  try { parsed = new URL(url); } catch { res.status(400).json({ error: "Invalid URL" }); return; }
  if (!parsed.hostname.endsWith("dzcdn.net")) {
    res.status(403).json({ error: "Only Deezer CDN URLs are proxied" });
    return;
  }
  try {
    const upstream = await fetch(url, { headers: { "User-Agent": "Trails/1.0" } });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }
    res.setHeader("Content-Type", upstream.headers.get("Content-Type") ?? "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!upstream.body) { res.status(502).end(); return; }
    // Stream the response
    const reader = (upstream.body as unknown as ReadableStream<Uint8Array>).getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((r) => res.once("drain", r));
        }
      }
    };
    await pump();
  } catch (err) {
    logger.warn({ err, url }, "audio-proxy fetch failed");
    if (!res.headersSent) res.status(502).end();
  }
});

// GET /api/duel/next?userId=&strategy=
router.get("/duel/next", async (req, res): Promise<void> => {
  const userId = parseInt(String(req.query.userId), 10);
  if (isNaN(userId)) { res.status(400).json({ error: "userId required" }); return; }

  const strategy = (String(req.query.strategy || "contrastive")) as Strategy;

  const pair = await getNextDuelPair(userId, strategy);
  if (!pair) {
    res.status(503).json({
      error: "canon_pool_empty",
      message: "No verified tracks available yet — run POST /api/canon/seed to build the pool.",
    });
    return;
  }

  // Fetch streaming links from resolved entities (linksJson lives in http_cache via /links route;
  // here we return what's already in resolved_entities and let the client resolve deep links lazily)
  res.json({
    aMbid: pair.a.mbid,
    aTitle: pair.a.title,
    aArtist: pair.a.artist,
    aYear: pair.a.year,
    aGenre: pair.a.primaryGenre,
    aArtworkUrl: pair.a.artworkUrl,
    bMbid: pair.b.mbid,
    bTitle: pair.b.title,
    bArtist: pair.b.artist,
    bYear: pair.b.year,
    bGenre: pair.b.primaryGenre,
    bArtworkUrl: pair.b.artworkUrl,
    strategy: pair.strategy,
  });
});

// POST /api/duel
router.post("/duel", async (req, res): Promise<void> => {
  const { userId, aMbid, bMbid, result, knewA, knewB, strategy = "contrastive" } = req.body as {
    userId: number; aMbid: string; bMbid: string;
    result: number; knewA: boolean; knewB: boolean; strategy?: string;
  };

  if (!userId || !aMbid || !bMbid || result === undefined || knewA === undefined || knewB === undefined) {
    res.status(400).json({ error: "userId, aMbid, bMbid, result, knewA, knewB required" });
    return;
  }
  if (result < -2 || result > 2 || !Number.isInteger(result)) {
    res.status(400).json({ error: "result must be integer -2..2" });
    return;
  }

  // Determine winner / loser
  // result < 0 → A wins, result > 0 → B wins, 0 → tie
  const winnerMbid = result < 0 ? aMbid : result > 0 ? bMbid : null;
  const loserMbid  = result < 0 ? bMbid : result > 0 ? aMbid : null;
  const winnerKnew = winnerMbid === aMbid ? knewA : knewB;

  // Log canon_duel taste_event
  await db.insert(tasteEventsTable).values({
    userId,
    kind: "canon_duel",
    payloadJson: {
      aMbid, bMbid, result, knewA, knewB, strategy,
      winnerMbid,
      isDiscoveryCandidate: winnerMbid !== null && !winnerKnew,
    },
  });

  // Update head-to-head ELO for both tracks (never throws).
  await applyComparison({ userId, aMbid, bMbid, result });

  const promotions: string[] = [];

  // Seed promotion: known + |result| >= 1
  if (winnerMbid && winnerKnew && Math.abs(result) >= 1) {
    const [entity] = await db
      .select()
      .from(resolvedEntitiesTable)
      .where(eq(resolvedEntitiesTable.mbid, winnerMbid))
      .limit(1);

    if (entity) {
      // Check user hasn't already seeded this
      const existing = await db
        .select()
        .from(seedsTable)
        .where(eq(seedsTable.userId, userId))
        .then((rows) => rows.find((s) => s.mbid === winnerMbid));

      if (!existing) {
        await db.insert(seedsTable).values({
          userId,
          mbid: winnerMbid,
          type: "track",
          title: entity.title ?? "",
          artist: entity.artist ?? "",
          year: entity.year ?? null,
          prompt: null, // no mood prompt — came from canon duel
          source: "canon_duel",
        }).catch((err) => logger.warn({ err }, "Seed promotion insert failed"));

        // Mirror as seed taste_event
        await db.insert(tasteEventsTable).values({
          userId,
          kind: "seed",
          payloadJson: { mbid: winnerMbid, source: "canon_duel", result, strategy },
        });

        promotions.push(winnerMbid);
      }
    }
  }

  res.status(201).json({
    ok: true,
    promotions,
    isDiscoveryCandidate: winnerMbid !== null && !winnerKnew,
  });
});

export default router;
