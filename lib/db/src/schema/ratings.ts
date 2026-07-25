import { pgTable, serial, timestamp, integer, text, numeric } from "drizzle-orm/pg-core";
import { recommendationsTable } from "./recommendations";

export const ratingsTable = pgTable("ratings", {
  id: serial("id").primaryKey(),
  recId: integer("rec_id").notNull().references(() => recommendationsTable.id),
  listenState: text("listen_state").notNull(), // listened | skipped | known
  score: numeric("score", { precision: 2, scale: 1 }),
  reviewText: text("review_text"),
  ratedAt: timestamp("rated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pathRatingsTable = pgTable("path_ratings", {
  id: serial("id").primaryKey(),
  diveStepId: integer("dive_step_id").notNull(),
  score: numeric("score", { precision: 2, scale: 1 }).notNull(),
  ratedAt: timestamp("rated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Standalone ratings for a user's chosen focus track (the starting point of a
 * focused dive). These are not tied to a recommendation or dive step — they
 * capture taste signal for tracks the user already knows and has picked as an
 * anchor. One row per (userId, mbid) — upserted on re-rating.
 */
export const focusRatingsTable = pgTable("focus_ratings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  mbid: text("mbid").notNull(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  listenState: text("listen_state").notNull(), // listened | skipped | known
  score: numeric("score", { precision: 2, scale: 1 }),
  reviewText: text("review_text"),
  ratedAt: timestamp("rated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Rating = typeof ratingsTable.$inferSelect;
export type PathRating = typeof pathRatingsTable.$inferSelect;
export type FocusRating = typeof focusRatingsTable.$inferSelect;
