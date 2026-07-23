import { Router, type IRouter } from "express";
import { db, usersTable, seedsTable, portraitsTable, divesTable } from "@workspace/db";
import { eq, count, desc } from "drizzle-orm";
import { CreateUserBody, GetStateQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

// POST /user — create or return user by name
router.post("/user", async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { name } = parsed.data;

  // Find existing user by name (case-insensitive)
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.name, name))
    .limit(1);

  let user: typeof usersTable.$inferSelect;
  if (existing.length > 0) {
    user = existing[0];
  } else {
    const [created] = await db.insert(usersTable).values({ name }).returning();
    user = created;
  }

  const [seeds] = await db
    .select({ count: count() })
    .from(seedsTable)
    .where(eq(seedsTable.userId, user.id));

  const portraits = await db
    .select()
    .from(portraitsTable)
    .where(eq(portraitsTable.userId, user.id))
    .orderBy(desc(portraitsTable.version))
    .limit(1);

  res.json({
    id: user.id,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    seedCount: Number(seeds.count),
    hasPortrait: portraits.length > 0,
  });
});

// GET /state — app state for userId
router.get("/state", async (req, res): Promise<void> => {
  const parsed = GetStateQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = parsed.data;

  const [seedCount] = await db
    .select({ count: count() })
    .from(seedsTable)
    .where(eq(seedsTable.userId, userId));

  const portraits = await db
    .select()
    .from(portraitsTable)
    .where(eq(portraitsTable.userId, userId))
    .orderBy(desc(portraitsTable.version))
    .limit(1);

  const activeDives = await db
    .select()
    .from(divesTable)
    .where(eq(divesTable.userId, userId))
    .orderBy(desc(divesTable.createdAt))
    .limit(1);

  const [diveCount] = await db
    .select({ count: count() })
    .from(divesTable)
    .where(eq(divesTable.userId, userId));

  const sc = Number(seedCount.count);
  const onboarded = sc >= 5 && portraits.length > 0;
  const portrait = portraits[0] ?? null;
  const activeDive = activeDives.find((d) => d.status === "active") ?? activeDives[0] ?? null;

  res.json({
    userId,
    seedCount: sc,
    onboarded,
    hasPortrait: portrait !== null,
    portraitText: portrait?.text ?? null,
    portraitVersion: portrait?.version ?? null,
    activeDiveId: activeDive?.id ?? null,
    activeDiveName: activeDive?.name ?? null,
    diveCount: Number(diveCount.count),
  });
});

export default router;
