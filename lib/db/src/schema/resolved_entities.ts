import { pgTable, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

export const resolvedEntitiesTable = pgTable("resolved_entities", {
  mbid: text("mbid").primaryKey(),
  type: text("type").notNull(), // recording | release-group
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  year: integer("year"),
  relationshipsJson: jsonb("relationships_json"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ResolvedEntity = typeof resolvedEntitiesTable.$inferSelect;
