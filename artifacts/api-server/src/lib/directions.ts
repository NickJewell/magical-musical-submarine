/**
 * Directions pipeline — generates hypothesis + 3 themed directions for a dive step.
 * Pulls user portrait + seeds + enrich context, then calls LLM.
 */

import { db, seedsTable, portraitsTable, diveStepsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { enrichFromSeeds, enrichFromFocus, aggregateSimilarArtists, type Focus } from "./enrich";
import { directions as llmDirections, sparkDirections as llmSparkDirections } from "./llm";
import { getEloSignal } from "./elo";

export async function directions(opts: { userId: number; diveId: number; focus?: Focus | null }) {
  const { userId, diveId, focus } = opts;

  // Get user's seeds
  const seeds = await db.select().from(seedsTable).where(eq(seedsTable.userId, userId));

  // Get latest portrait
  const portraits = await db
    .select()
    .from(portraitsTable)
    .where(eq(portraitsTable.userId, userId))
    .orderBy(desc(portraitsTable.version))
    .limit(1);

  const portraitText =
    portraits[0]?.text ?? "A music lover exploring new sounds.";

  // Build prior step recap
  const priorSteps = await db
    .select()
    .from(diveStepsTable)
    .where(eq(diveStepsTable.diveId, diveId))
    .orderBy(diveStepsTable.seq);

  const recap =
    priorSteps.length > 0
      ? priorSteps
          .map(
            (s) =>
              `Step ${s.seq}: chose direction "${s.chosenDirection ?? "unknown"}"`
          )
          .join("; ")
      : "";

  // Enrich either from the chosen focus (focused dive) or the user's seeds.
  const enrichData = focus
    ? await enrichFromFocus(focus)
    : await enrichFromSeeds(seeds.map((s) => ({ artist: s.artist, title: s.title })));

  const similarArtistNames = enrichData.similarArtists
    .slice(0, 15)
    .map((a) => a.name);

  // Head-to-head ELO signal steers taste-based dives. A focused dive
  // deliberately ignores the user's taste, so we skip it there.
  const eloTop = focus
    ? []
    : (await getEloSignal(userId, 6)).top.map((t) => `"${t.title}" by ${t.artist}`);

  // Call LLM. On a focused dive we pass the focus through and the LLM
  // generates paths from that selection alone (portrait ignored).
  const result = await llmDirections({
    portraitText,
    recap,
    seeds: seeds.map((s) => ({ title: s.title, artist: s.artist })),
    similarArtists: similarArtistNames,
    eloTop,
    focus: focus ?? null,
  });

  return result;
}

/** A dive started from a nugget the user found, rather than their portrait alone. */
export type SparkSource =
  | { type: "track"; mbid?: string | null; title: string; artist: string }
  | { type: "session"; label: string; tracks: Array<{ title: string; artist: string }>; notes?: string | null };

/**
 * Directions for a "spark" dive. Unlike a focused dive (which explores a
 * selection in isolation), a spark blends the nugget with the user's taste
 * graph — the paths should feel like this listener exploring from this thing.
 */
export async function spark(opts: { userId: number; source: SparkSource }) {
  const { userId, source } = opts;

  const portraits = await db
    .select()
    .from(portraitsTable)
    .where(eq(portraitsTable.userId, userId))
    .orderBy(desc(portraitsTable.version))
    .limit(1);
  const portraitText = portraits[0]?.text ?? "A music lover exploring new sounds.";

  const eloTop = (await getEloSignal(userId, 6)).top.map((t) => `"${t.title}" by ${t.artist}`);

  if (source.type === "session") {
    const artists = [...new Set(source.tracks.map((t) => t.artist).filter(Boolean))];
    const similar = await aggregateSimilarArtists(artists);
    return llmSparkDirections({
      mode: "session",
      portraitText,
      eloTop,
      similarArtists: similar.slice(0, 15).map((a) => a.name),
      session: { label: source.label, tracks: source.tracks, notes: source.notes ?? null },
    });
  }

  // track spark — anchor enrichment on the track's performing artist.
  const enrichData = await enrichFromFocus({
    kind: "track",
    label: source.title,
    artist: source.artist,
    mbid: source.mbid ?? null,
  });
  return llmSparkDirections({
    mode: "track",
    portraitText,
    eloTop,
    similarArtists: enrichData.similarArtists.slice(0, 15).map((a) => a.name),
    track: { title: source.title, artist: source.artist },
  });
}
