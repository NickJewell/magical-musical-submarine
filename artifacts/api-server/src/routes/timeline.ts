import { Router } from "express";
import {
  db, divesTable, diveStepsTable, recommendationsTable, ratingsTable,
} from "@workspace/db";
import { eq, and, lt, gte, desc, inArray } from "drizzle-orm";
import { generateTastingNote } from "../lib/llm";
import { logger } from "../lib/logger";

const router = Router();

/**
 * Load cached tasting notes for a set of dive steps. Guarded: the tasting_note
 * columns require a `drizzle-kit push`, so if they don't exist yet we degrade to
 * "no notes" rather than 500-ing the whole timeline.
 */
async function loadTastingNotes(
  stepIds: number[],
): Promise<Map<number, { note: string; at: string | null }>> {
  const out = new Map<number, { note: string; at: string | null }>();
  if (stepIds.length === 0) return out;
  try {
    const rows = await db
      .select({
        id: diveStepsTable.id,
        tastingNote: diveStepsTable.tastingNote,
        tastingNoteAt: diveStepsTable.tastingNoteAt,
      })
      .from(diveStepsTable)
      .where(inArray(diveStepsTable.id, stepIds));
    for (const r of rows) {
      if (r.tastingNote) {
        out.set(r.id, { note: r.tastingNote, at: r.tastingNoteAt?.toISOString() ?? null });
      }
    }
  } catch (err) {
    logger.warn({ err }, "tasting_note columns unavailable — run drizzle-kit push");
  }
  return out;
}

router.get("/timeline", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId required" });

  const days = Math.min(Number(req.query.days) || 14, 60);
  const before = req.query.before
    ? new Date(req.query.before as string)
    : new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow so "today" is included

  const from = new Date(before);
  from.setDate(from.getDate() - days);

  // ---- Load dive steps for this user in the date range ----
  const steps = await db
    .select({
      diveStepId: diveStepsTable.id,
      diveId:     diveStepsTable.diveId,
      chosenDirection: diveStepsTable.chosenDirection,
      hypothesisText:  diveStepsTable.hypothesisText,
      createdAt:  diveStepsTable.createdAt,
      diveName:   divesTable.name,
    })
    .from(diveStepsTable)
    .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
    .where(
      and(
        eq(divesTable.userId, userId),
        lt(diveStepsTable.createdAt, before),
        gte(diveStepsTable.createdAt, from),
      )
    )
    .orderBy(desc(diveStepsTable.createdAt));

  if (steps.length === 0) {
    return res.json({ days: [], nextCursor: null });
  }

  const stepIds = steps.map((s) => s.diveStepId);

  // ---- Recommendations for those steps ----
  const recs = await db
    .select()
    .from(recommendationsTable)
    .where(inArray(recommendationsTable.diveStepId, stepIds))
    .orderBy(recommendationsTable.id);

  // ---- Latest rating per rec ----
  const recIds = recs.map((r) => r.id);
  const allRatings = recIds.length
    ? await db
        .select({
          recId:       ratingsTable.recId,
          score:       ratingsTable.score,
          listenState: ratingsTable.listenState,
          reviewText:  ratingsTable.reviewText,
        })
        .from(ratingsTable)
        .where(inArray(ratingsTable.recId, recIds))
        .orderBy(desc(ratingsTable.ratedAt))
    : [];

  const latestRating = new Map<number, { score: number | null; listenState: string; reviewText: string | null }>();
  for (const r of allRatings) {
    if (!latestRating.has(r.recId)) {
      latestRating.set(r.recId, {
        score: r.score != null ? parseFloat(String(r.score)) : null,
        listenState: r.listenState,
        reviewText: r.reviewText ?? null,
      });
    }
  }

  // ---- Group recs by stepId ----
  const recsByStep = new Map<number, typeof recs>();
  for (const rec of recs) {
    const list = recsByStep.get(rec.diveStepId) ?? [];
    list.push(rec);
    recsByStep.set(rec.diveStepId, list);
  }

  // ---- Cached tasting notes per step (guarded) ----
  const tastingNotes = await loadTastingNotes(stepIds);

  // ---- Group steps by date (UTC date key YYYY-MM-DD) ----
  const dayMap = new Map<string, typeof steps>();
  for (const step of steps) {
    const key = step.createdAt.toISOString().slice(0, 10);
    const list = dayMap.get(key) ?? [];
    list.push(step);
    dayMap.set(key, list);
  }

  const today = new Date().toISOString().slice(0, 10);

  // ---- Build response (oldest → newest) ----
  const dayEntries = Array.from(dayMap.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  const result = dayEntries.map(([dateKey, daySteps]) => {
    const paths = daySteps.map((step) => {
      const title =
        step.chosenDirection ||
        truncate(step.hypothesisText || "Dive path", 45);

      const stepRecs = recsByStep.get(step.diveStepId) ?? [];
      const llmRecs  = stepRecs.filter((r) => r.arm === "llm");
      const ctrlRec  = stepRecs.find((r) => r.arm === "well_trodden") ?? null;

      const songs = llmRecs.map((rec) => {
        const rating = latestRating.get(rec.id);
        return {
          recId:         rec.id,
          mbid:          rec.mbid,
          type:          rec.type,
          title:         rec.title,
          artist:        rec.artist,
          artworkUrl:    rec.artworkUrl ?? null,
          score:         rating?.score ?? null,
          listenState:   rating?.listenState ?? null,
          reviewText:    rating?.reviewText ?? null,
          arm:           rec.arm,
          linksJson:     rec.linksJson ?? null,
          narrativeText: rec.narrativeText ?? null,
        };
      });

      const wellTrodden = ctrlRec
        ? {
            recId:        ctrlRec.id,
            mbid:         ctrlRec.mbid,
            type:         ctrlRec.type,
            title:        ctrlRec.title,
            artist:       ctrlRec.artist,
            artworkUrl:   ctrlRec.artworkUrl ?? null,
            score:        latestRating.get(ctrlRec.id)?.score ?? null,
            listenState:  latestRating.get(ctrlRec.id)?.listenState ?? null,
            reviewText:   latestRating.get(ctrlRec.id)?.reviewText ?? null,
            linksJson:    ctrlRec.linksJson ?? null,
            narrativeText: ctrlRec.narrativeText ?? null,
          }
        : null;

      const ratedSongs    = songs.filter((s) => s.score !== null);
      const avgScore      = ratedSongs.length
        ? ratedSongs.reduce((sum, s) => sum + s.score!, 0) / ratedSongs.length
        : null;
      const newCount = songs.filter(
        (s) => s.listenState == null || s.listenState === "new"
      ).length;

      const tasting = tastingNotes.get(step.diveStepId) ?? null;

      return {
        diveStepId: step.diveStepId,
        diveId:     step.diveId,
        diveName:   step.diveName,
        title,
        summary: { count: songs.length, avgScore, newCount },
        songs,
        wellTrodden,
        tastingNote:   tasting?.note ?? null,
        tastingNoteAt: tasting?.at ?? null,
      };
    });

    return { date: dateKey, label: formatLabel(dateKey, today), paths };
  });

  // nextCursor = ISO string of the oldest date in this page (exclusive)
  const oldestDate = dayEntries[0]?.[0];
  const nextCursor = oldestDate ?? null;

  return res.json({ days: result, nextCursor });
});

// POST /timeline/tasting-note — generate + cache a critic's note for one dive leg
router.post("/timeline/tasting-note", async (req, res) => {
  const userId = Number((req.body as { userId?: unknown })?.userId);
  const diveStepId = Number((req.body as { diveStepId?: unknown })?.diveStepId);
  if (!userId || !diveStepId) {
    return res.status(400).json({ error: "userId and diveStepId required" });
  }

  // Ownership: step → dive → user
  const [step] = await db
    .select({
      id: diveStepsTable.id,
      chosenDirection: diveStepsTable.chosenDirection,
      hypothesisText: diveStepsTable.hypothesisText,
      diveName: divesTable.name,
      userId: divesTable.userId,
    })
    .from(diveStepsTable)
    .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
    .where(eq(diveStepsTable.id, diveStepId))
    .limit(1);

  if (!step) return res.status(404).json({ error: "Dive step not found" });
  if (step.userId !== userId) return res.status(403).json({ error: "Access denied" });

  // Gather the leg's LLM tracks + latest ratings
  const recs = await db
    .select()
    .from(recommendationsTable)
    .where(and(eq(recommendationsTable.diveStepId, diveStepId), eq(recommendationsTable.arm, "llm")));

  if (recs.length === 0) {
    return res.status(422).json({ error: "No tracks on this leg yet" });
  }

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
  if (ratedCount === 0) {
    return res.status(422).json({ error: "Rate a few tracks on this leg first" });
  }

  let note: string;
  try {
    note = await generateTastingNote({
      diveName: step.diveName,
      directionLabel: step.chosenDirection || step.hypothesisText || "this thread",
      hypothesis: step.hypothesisText,
      tracks,
    });
  } catch (err) {
    logger.error({ err, diveStepId }, "tasting-note generation failed");
    return res.status(502).json({ error: "Could not generate a note — try again" });
  }

  const now = new Date();
  try {
    await db
      .update(diveStepsTable)
      .set({ tastingNote: note, tastingNoteAt: now })
      .where(eq(diveStepsTable.id, diveStepId));
  } catch (err) {
    // Column may not exist pre-push — still return the note so the UI can show it.
    logger.warn({ err }, "could not persist tasting note — run drizzle-kit push");
  }

  return res.json({ tastingNote: note, tastingNoteAt: now.toISOString() });
});

// ---- helpers ----

function formatLabel(dateKey: string, today: string): string {
  if (dateKey === today) return "Today";
  const d   = new Date(dateKey + "T12:00:00Z");
  const day = d.getUTCDate();
  const month  = d.toLocaleString("en-GB", { month: "long",  timeZone: "UTC" });
  const year   = d.getUTCFullYear();
  const nowYear = new Date().getUTCFullYear();
  const ord = ordinal(day);
  return year === nowYear ? `${day}${ord} ${month}` : `${day}${ord} ${month} ${year}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) + "…" : s;
}

export default router;
