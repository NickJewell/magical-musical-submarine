import { pgTable, text, integer, numeric, jsonb, timestamp } from "drizzle-orm/pg-core";
import { resolvedEntitiesTable } from "./resolved_entities";

export const canonTracksTable = pgTable("canon_tracks", {
  mbid: text("mbid").primaryKey().references(() => resolvedEntitiesTable.mbid),
  era: integer("era"), // decade, e.g. 1970
  primaryGenre: text("primary_genre"),
  moodTags: jsonb("mood_tags").$type<string[]>(),
  region: text("region"),
  canonWeight: numeric("canon_weight", { precision: 3, scale: 2 }).default("0.50"),
  source: text("source").notNull().default("generated"), // generated | imported
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CanonTrack = typeof canonTracksTable.$inferSelect;
