import { Router, type IRouter } from "express";
import { db, portraitsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  GetPortraitQueryParams,
  UpdatePortraitBody,
  GeneratePortraitBody,
} from "@workspace/api-zod";
import { rebuildPortrait } from "../lib/portraitGen";

const router: IRouter = Router();

function formatPortrait(p: typeof portraitsTable.$inferSelect) {
  return {
    id: p.id,
    userId: p.userId,
    version: p.version,
    text: p.text,
    source: p.source,
    generatedAt: p.generatedAt.toISOString(),
  };
}

// GET /portrait
router.get("/portrait", async (req, res): Promise<void> => {
  const parsed = GetPortraitQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = parsed.data;

  const portraits = await db
    .select()
    .from(portraitsTable)
    .where(eq(portraitsTable.userId, userId))
    .orderBy(desc(portraitsTable.version))
    .limit(1);

  if (portraits.length === 0) {
    res.status(404).json({ error: "No portrait yet" });
    return;
  }

  res.json(formatPortrait(portraits[0]));
});

// PUT /portrait — save user-edited portrait
router.put("/portrait", async (req, res): Promise<void> => {
  const parsed = UpdatePortraitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId, text } = parsed.data;

  const existing = await db
    .select()
    .from(portraitsTable)
    .where(eq(portraitsTable.userId, userId))
    .orderBy(desc(portraitsTable.version))
    .limit(1);

  const nextVersion = existing.length > 0 ? existing[0].version + 1 : 1;

  const [portrait] = await db
    .insert(portraitsTable)
    .values({ userId, version: nextVersion, text, source: "user_edit" })
    .returning();

  // Log as taste event
  await db.insert(tasteEventsTable).values({
    userId,
    kind: "edit",
    payloadJson: { portraitVersion: nextVersion },
  });

  res.json(formatPortrait(portrait));
});

// POST /portrait/generate — LLM-generate portrait
router.post("/portrait/generate", async (req, res): Promise<void> => {
  const parsed = GeneratePortraitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = parsed.data;

  const result = await rebuildPortrait(userId);
  if (!result) {
    res.status(422).json({ error: "No seeds yet — add some tracks first" });
    return;
  }

  // Fetch the persisted row so we return the full portrait object
  const [portrait] = await db
    .select()
    .from(portraitsTable)
    .where(eq(portraitsTable.userId, userId))
    .orderBy(desc(portraitsTable.version))
    .limit(1);

  res.json({ ...formatPortrait(portrait), cached: result.cached });
});

export default router;
