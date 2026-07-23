/**
 * Directions pipeline — generates hypothesis + 3 themed directions for a dive step.
 * Pulls user portrait + seeds + enrich context, then calls LLM.
 */

import { db, seedsTable, portraitsTable, diveStepsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { enrichFromSeeds } from "./enrich";
import { directions as llmDirections } from "./llm";

export async function directions(opts: { userId: number; diveId: number }) {
  const { userId, diveId } = opts;

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

  // Enrich with Last.fm similar artists
  const enrichData = await enrichFromSeeds(
    seeds.map((s) => ({ artist: s.artist, title: s.title }))
  );

  const similarArtistNames = enrichData.similarArtists
    .slice(0, 15)
    .map((a) => a.name);

  // Call LLM
  const result = await llmDirections({
    portraitText,
    recap,
    seeds: seeds.map((s) => ({ title: s.title, artist: s.artist })),
    similarArtists: similarArtistNames,
  });

  return result;
}
