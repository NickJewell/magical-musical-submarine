import { Router, type IRouter } from "express";
import { GetEloQueryParams } from "@workspace/api-zod";
import { getRankedTracks, ensureUserTracksSeeded } from "../lib/elo";

const router: IRouter = Router();

// GET /elo — the user's tracks ranked by head-to-head ELO, highest first.
router.get("/elo", async (req, res): Promise<void> => {
  const parsed = GetEloQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = parsed.data;

  // Backfill first so every seeded/rated track has a (baseline) ranking, even
  // if it has never been compared.
  await ensureUserTracksSeeded(userId);
  const tracks = await getRankedTracks(userId);
  res.json(tracks);
});

export default router;
