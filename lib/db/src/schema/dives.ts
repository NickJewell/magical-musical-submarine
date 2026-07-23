import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const divesTable = pgTable("dives", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"), // active | archived
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDiveSchema = createInsertSchema(divesTable).omit({ id: true, createdAt: true });
export type InsertDive = z.infer<typeof insertDiveSchema>;
export type Dive = typeof divesTable.$inferSelect;
