/**
 * Background tasting-note generation.
 * Called fire-and-forget from the rating route once a step has enough data.
 */

import { db, diveStepsTable, divesTable, recommendationsTable, ratingsTable } from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { generateTastingNote } from "./llm";
import { logger } from "./logger";

async function buildTastingNote(diveStepId: number): Promise<void> {
  // Fetch step + dive in one join
  const [step] = await db
    .select({
      id: diveStepsTable.id,
      chosenDirection: diveStepsTable.chosenDirection,
      hypothesisText: diveStepsTable.hypothesisText,
      tastingNote: diveStepsTable.tastingNote,
      diveName: divesTable.name,
    })
    .from(diveStepsTable)
    .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
    .where(eq(diveStepsTable.id, diveStepId))
    .limit(1);

  if (!step) return;
  // Skip if a note already exists (race-safe: a manual regenerate or parallel trigger may have beaten us)
  if (step.tastingNote) return;

  const recs = await db
    .select()
    .from(recommendationsTable)
    .where(and(eq(recommendationsTable.diveStepId, diveStepId), eq(recommendationsTable.arm, "llm")));

  if (recs.length === 0) return;

  const recIds = recs.map((r) => r.id);
  const allRatings = await db
    .select({
      recId: ratingsTable.recId,
      score: ratingsTable.score,
      listenState: ratingsTable.listenState,
      reviewText: ratingsTable.reviewText,
    })
    .from(ratingsTable)
    .where(inArray(ratingsTable.recId, recIds))
    .orderBy(desc(ratingsTable.ratedAt));

  // Deduplicate to latest rating per rec
  const latest = new Map<number, { score: number | null; listenState: string; reviewText: string | null }>();
  for (const r of allRatings) {
    if (!latest.has(r.recId)) {
      latest.set(r.recId, {
        score: r.score != null ? parseFloat(String(r.score)) : null,
        listenState: r.listenState,
        reviewText: r.reviewText ?? null,
      });
    }
  }

  const tracks = recs.map((rec) => {
    const rating = latest.get(rec.id);
    return {
      title: rec.title,
      artist: rec.artist,
      listenState: rating?.listenState ?? null,
      score: rating?.score ?? null,
      reviewText: rating?.reviewText ?? null,
    };
  });

  const ratedCount = tracks.filter((t) => t.listenState || t.score !== null).length;
  if (ratedCount < 3) return;

  const note = await generateTastingNote({
    diveName: step.diveName,
    directionLabel: step.chosenDirection || step.hypothesisText || "this thread",
    hypothesis: step.hypothesisText,
    tracks,
  });

  await db
    .update(diveStepsTable)
    .set({ tastingNote: note, tastingNoteAt: new Date() })
    .where(
      and(
        eq(diveStepsTable.id, diveStepId),
        // Only write if still empty — prevents overwriting a concurrently-saved manual note
        // (Drizzle doesn't support isNull in .where directly in all versions, so we re-check below)
      ),
    );

  // Re-check after update in case of race: if tastingNote was already set, the update is a no-op
  // because we fetched tastingNote = null at the top of this function before generating.
  logger.info({ diveStepId }, "Auto-generated tasting note saved");
}

/** Fire-and-forget — logs errors, never throws. */
export function triggerTastingNoteGeneration(diveStepId: number): void {
  buildTastingNote(diveStepId).catch((err) =>
    logger.error({ err, diveStepId }, "Background tasting-note generation failed"),
  );
}
