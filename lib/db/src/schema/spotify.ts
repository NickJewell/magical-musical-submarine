import { pgTable, text, integer, serial, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { diveStepsTable } from "./dive_steps";

/** One row per user who has connected their Spotify account. */
export const spotifyAccountsTable = pgTable("spotify_accounts", {
  userId: integer("user_id").primaryKey().references(() => usersTable.id),
  spotifyUserId: text("spotify_user_id").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  scope: text("scope").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Record of playlists exported so re-export can append rather than duplicate. */
export const spotifyPlaylistsTable = pgTable("spotify_playlists", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  diveStepId: integer("dive_step_id").notNull().references(() => diveStepsTable.id),
  spotifyPlaylistId: text("spotify_playlist_id").notNull(),
  name: text("name").notNull(),
  tracksAdded: integer("tracks_added").notNull(),
  tracksTotal: integer("tracks_total").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SpotifyAccount = typeof spotifyAccountsTable.$inferSelect;
export type SpotifyPlaylist = typeof spotifyPlaylistsTable.$inferSelect;
