import { Router } from "express";
import {
  db, divesTable, diveStepsTable, recommendationsTable, ratingsTable,
} from "@workspace/db";
import { eq, and, lt, gte, desc, inArray } from "drizzle-orm";

const router = Router();

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

      return {
        diveStepId: step.diveStepId,
        diveName:   step.diveName,
        title,
        summary: { count: songs.length, avgScore, newCount },
        songs,
        wellTrodden,
      };
    });

    return { date: dateKey, label: formatLabel(dateKey, today), paths };
  });

  // nextCursor = ISO string of the oldest date in this page (exclusive)
  const oldestDate = dayEntries[0]?.[0];
  const nextCursor = oldestDate ?? null;

  return res.json({ days: result, nextCursor });
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
