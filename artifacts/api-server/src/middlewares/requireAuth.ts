/**
 * Clerk auth middleware + JIT local-user provisioning.
 *
 * Reads the Clerk session via @clerk/express getAuth(), maps the Clerk userId
 * to the local integer userId in the users table (creating a row on first use),
 * and attaches req.localUserId so downstream route handlers can use it without
 * repeating the lookup.
 */

import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { clerkClient } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      localUserId?: number;
    }
  }
}

/** Look up (or create) a local user row for the given Clerk userId. */
export async function resolveLocalUser(clerkId: string): Promise<number> {
  // Try to find existing local user
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId))
    .limit(1);

  if (existing) return existing.id;

  // JIT provision: fetch Clerk user to get display name
  let name = "Anonymous";
  try {
    const clerkUser = await clerkClient.users.getUser(clerkId);
    name =
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ").trim() ||
      clerkUser.emailAddresses[0]?.emailAddress?.split("@")[0] ||
      "Anonymous";
  } catch {
    // If Clerk fetch fails, still create the row with a placeholder name
  }

  const [created] = await db
    .insert(usersTable)
    .values({ name, clerkId })
    .onConflictDoUpdate({
      target: usersTable.clerkId,
      set: { name },
    })
    .returning({ id: usersTable.id });

  return created.id;
}

/** Express middleware — attaches req.localUserId (integer) from Clerk session. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  resolveLocalUser(auth.userId)
    .then((localUserId) => {
      req.localUserId = localUserId;
      next();
    })
    .catch((err) => {
      next(err);
    });
}

/** Soft auth — attaches req.localUserId if signed in, does NOT reject if signed out. */
export function softAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    next();
    return;
  }

  resolveLocalUser(auth.userId)
    .then((localUserId) => {
      req.localUserId = localUserId;
      next();
    })
    .catch(() => next());
}
