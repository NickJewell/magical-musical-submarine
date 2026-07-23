import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const seedsTable = pgTable("seeds", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  mbid: text("mbid").notNull(),
  type: text("type").notNull(), // track | album
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  year: integer("year"),
  prompt: text("prompt"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSeedSchema = createInsertSchema(seedsTable).omit({ id: true, createdAt: true });
export type InsertSeed = z.infer<typeof insertSeedSchema>;
export type Seed = typeof seedsTable.$inferSelect;
