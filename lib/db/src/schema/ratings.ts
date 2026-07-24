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

export type Rating = typeof ratingsTable.$inferSelect;
export type PathRating = typeof pathRatingsTable.$inferSelect;
