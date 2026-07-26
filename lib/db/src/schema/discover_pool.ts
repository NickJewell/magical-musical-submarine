import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A persisted pool of tracks to surface in the Home "Discover & rank" feed,
 * ingested from external playlists (currently a Spotify playlist). Appended to
 * over time; `spotifyId` is the natural de-dupe key (unique) so re-ingesting the
 * same playlist never creates duplicates.
 */
export const discoverPoolTable = pgTable("discover_pool", {
  id: serial("id").primaryKey(),
  source: text("source").notNull().default("spotify_playlist"),
  sourceId: text("source_id"),
  spotifyId: text("spotify_id").notNull().unique(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  album: text("album"),
  artworkUrl: text("artwork_url"),
  previewUrl: text("preview_url"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DiscoverPoolTrack = typeof discoverPoolTable.$inferSelect;
