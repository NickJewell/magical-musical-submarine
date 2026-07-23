/**
 * GET /me — returns the local user for the authenticated Clerk session.
 * Creates a local user row (JIT provisioning) on first call.
 */
import { Router, type IRouter } from "express";
import { requireAuth, resolveLocalUser } from "../middlewares/requireAuth";
import { getAuth } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/me", requireAuth, async (req, res): Promise<void> => {
  const localUserId = req.localUserId!;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, localUserId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    name: user.name,
    clerkId: user.clerkId,
    createdAt: user.createdAt.toISOString(),
  });
});

export default router;
