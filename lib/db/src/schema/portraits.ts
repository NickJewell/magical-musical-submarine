import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const portraitsTable = pgTable("portraits", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  version: integer("version").notNull(),
  text: text("text").notNull(),
  source: text("source").notNull().default("llm"), // llm | user_edit
  /**
   * SHA-256 hex hash of the serialized seeds+pair-choices input.
   * Used to skip LLM regeneration when the inputs haven't changed.
   * NULL for portraits created before this column was added, or for user_edit rows.
   */
  seedsHash: text("seeds_hash"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPortraitSchema = createInsertSchema(portraitsTable).omit({ id: true, generatedAt: true });
export type InsertPortrait = z.infer<typeof insertPortraitSchema>;
export type Portrait = typeof portraitsTable.$inferSelect;
