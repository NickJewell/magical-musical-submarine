import { pgTable, serial, timestamp, integer, text, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * The user's taste map: their ranked tracks clustered into named "territories"
 * (scenes/textures they occupy), plus unexplored neighbouring territory
 * suggestions. One row per user — regenerated on demand; `source_hash`
 * fingerprints the rankings that produced it so unchanged rankings skip the
 * Last.fm + LLM work.
 */
export const tasteTerritoriesTable = pgTable("taste_territories", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  dataJson: jsonb("data_json").notNull(),
  sourceHash: text("source_hash").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TasteTerritories = typeof tasteTerritoriesTable.$inferSelect;
