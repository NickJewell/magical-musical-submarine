import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { diveStepsTable } from "./dive_steps";

export const recommendationsTable = pgTable("recommendations", {
  id: serial("id").primaryKey(),
  diveStepId: integer("dive_step_id").notNull().references(() => diveStepsTable.id),
  type: text("type").notNull(), // track | album
  mbid: text("mbid").notNull(),
  entryTrackMbid: text("entry_track_mbid"), // for album recs
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  year: integer("year"),
  narrativeText: text("narrative_text"),
  linksJson: jsonb("links_json"),
  artworkUrl: text("artwork_url"),
  arm: text("arm").notNull().default("llm"), // llm | well_trodden
  likelyKnown: text("likely_known"), // low | medium | high
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Recommendation = typeof recommendationsTable.$inferSelect;
