import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { divesTable } from "./dives";

export const diveStepsTable = pgTable("dive_steps", {
  id: serial("id").primaryKey(),
  diveId: integer("dive_id").notNull().references(() => divesTable.id),
  seq: integer("seq").notNull(),
  hypothesisText: text("hypothesis_text"),
  directionsJson: jsonb("directions_json"),
  chosenDirection: text("chosen_direction"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DiveStep = typeof diveStepsTable.$inferSelect;
