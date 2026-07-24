import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Persistent L2 cache for HTTP enrichment responses (Last.fm, MusicBrainz).
 * The in-memory responseCache in http.ts acts as L1 (fast, process-scoped).
 * This table acts as L2 — survives server restarts.
 */
export const httpCacheTable = pgTable("http_cache", {
  key: text("key").primaryKey(),
  body: jsonb("body").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type HttpCache = typeof httpCacheTable.$inferSelect;
