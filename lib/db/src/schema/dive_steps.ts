import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { divesTable } from "./dives";

export const diveStepsTable = pgTable("dive_steps", {
  id: serial("id").primaryKey(),
  diveId: integer("dive_id").notNull().references(() => divesTable.id),
  seq: integer("seq").notNull(),
  hypothesisText: text("hypothesis_text"),
  directionsJson: jsonb("directions_json"),
  chosenDirection: text("chosen_direction"),
  // Cached "what we tasted here" note — a critic's paragraph on this leg of the
  // dive, generated on demand from the leg's tracks + ratings. Null until asked for.
  tastingNote: text("tasting_note"),
  tastingNoteAt: timestamp("tasting_note_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DiveStep = typeof diveStepsTable.$inferSelect;
