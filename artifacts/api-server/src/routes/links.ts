import { Router, type IRouter } from "express";
import { ResolveLinksQueryParams } from "@workspace/api-zod";
import { resolveLinks } from "../lib/links";

const router: IRouter = Router();

// GET /links — streaming links for an MBID
router.get("/links", async (req, res): Promise<void> => {
  const parsed = ResolveLinksQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { mbid, type = "track", title = "", artist = "" } = parsed.data;

  const links = await resolveLinks(mbid, type as "track" | "album", title, artist);

  res.json({
    ...links,
    mbid,
  });
});

export default router;
