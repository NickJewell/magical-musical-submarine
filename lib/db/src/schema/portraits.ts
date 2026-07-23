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
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPortraitSchema = createInsertSchema(portraitsTable).omit({ id: true, generatedAt: true });
export type InsertPortrait = z.infer<typeof insertPortraitSchema>;
export type Portrait = typeof portraitsTable.$inferSelect;
