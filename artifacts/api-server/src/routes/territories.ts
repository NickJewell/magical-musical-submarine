import { Router, type IRouter } from "express";
import { buildTerritories, getTerritories } from "../lib/territories";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** GET /territories — the cached taste map, or null if never charted. */
router.get("/territories", async (req, res): Promise<void> => {
  const userId = Number(req.query.userId);
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }
  const result = await getTerritories(userId);
  res.json(result ?? { map: null, generatedAt: null, cached: false });
});

/**
 * POST /territories/generate — chart (or re-chart) the map. Skips the
 * Last.fm + LLM work when the rankings haven't changed, unless force: true.
 * Cold generation takes ~30-60s (tag fetches + one LLM call).
 */
router.post("/territories/generate", async (req, res): Promise<void> => {
  const body = req.body as { userId?: unknown; force?: unknown };
  const userId = Number(body.userId);
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  try {
    const result = await buildTerritories(userId, { force: body.force === true });
    if (!result) {
      res.status(422).json({ error: "Not enough ranked tracks to chart a map yet — rank a few more first" });
      return;
    }
    res.json(result);
  } catch (err) {
    logger.error({ err: String(err), userId }, "territory generation failed");
    res.status(502).json({ error: "Charting failed — try again" });
  }
});

export default router;
