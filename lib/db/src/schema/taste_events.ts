import { pgTable, serial, timestamp, text, integer } from "drizzle-orm/pg-core";
import { jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const tasteEventsTable = pgTable("taste_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  kind: text("kind").notNull(), // seed | choice | rating | skip | edit | pair_choice
  payloadJson: jsonb("payload_json").notNull().default({}),
});

export type TasteEvent = typeof tasteEventsTable.$inferSelect;
