import { pgTable, serial, timestamp, integer, text, real, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Per-user, per-track ELO rating. Every track a user has seeded or rated gets a
 * row (seeded at the 1500 baseline); head-to-head comparisons (pairwise slider
 * and canon duels) move the rating. Feeds the taste portrait and recommendation
 * steering. Track identity is `mbid` (the canonical id used across seeds and
 * recommendations); title/artist are denormalised for display and prompting.
 */
export const trackEloTable = pgTable(
  "track_elo",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id),
    mbid: text("mbid").notNull(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    rating: real("rating").notNull().default(1500),
    matches: integer("matches").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userMbidUnique: uniqueIndex("track_elo_user_mbid_unique").on(t.userId, t.mbid),
  }),
);

export type TrackElo = typeof trackEloTable.$inferSelect;
