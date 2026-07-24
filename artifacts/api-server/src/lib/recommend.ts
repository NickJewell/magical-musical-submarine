/**
 * Recommend pipeline — Propose → Resolve → Narrate → Control arm.
 * Only verified tracks (passed MusicBrainz gate) get shown.
 * A well_trodden control-arm record is ALWAYS inserted for every step (A/B comparison).
 */

import { db, seedsTable, portraitsTable, diveStepsTable, recommendationsTable, ratingsTable, tasteEventsTable, divesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { enrichFromSeeds, type EnrichResult } from "./enrich";
import { resolve, MB_REQUEST_TIMEOUT_MS } from "./musicbrainz";
import { resolveLinks } from "./links";
import { propose, narrate } from "./llm";
import { logger } from "./logger";

const MAX_CANDIDATES = 7;
const TARGET_RECS = 3;

/** Total time budget for the full Propose→Resolve pipeline (ms). */
const PIPELINE_BUDGET_MS = 30_000;

export async function recommend(opts: { stepId: number; userId: number }) {
  const { stepId, userId } = opts;

  // Guard: return cached recs if already run for this step
  const existing = await db
    .select()
    .from(recommendationsTable)
    .where(eq(recommendationsTable.diveStepId, stepId));

  if (existing.length > 0) {
    return formatRecs(existing);
  }

  // Load step + dive context
  const [step] = await db.select().from(diveStepsTable).where(eq(diveStepsTable.id, stepId)).limit(1);
  if (!step) throw new Error(`Dive step ${stepId} not found`);

  const seeds = await db.select().from(seedsTable).where(eq(seedsTable.userId, userId));

  const portraits = await db
    .select()
    .from(portraitsTable)
    .where(eq(portraitsTable.userId, userId))
    .orderBy(desc(portraitsTable.version))
    .limit(1);

  const portraitText = portraits[0]?.text ?? "A music lover exploring new sounds.";

  // Build prior ratings context
  const priorRatings = await db
    .select({
      recId: recommendationsTable.id,
      title: recommendationsTable.title,
      artist: recommendationsTable.artist,
      listenState: ratingsTable.listenState,
      score: ratingsTable.score,
    })
    .from(ratingsTable)
    .innerJoin(recommendationsTable, eq(ratingsTable.recId, recommendationsTable.id))
    .where(eq(recommendationsTable.diveStepId, stepId))
    .orderBy(desc(ratingsTable.ratedAt))
    .limit(20)
    .catch(() => []);

  const priorRatingsFormatted = priorRatings.map((r) => ({
    title: r.title,
    artist: r.artist,
    listenState: r.listenState,
    score: r.score != null ? parseFloat(String(r.score)) : null,
  }));

  // Enrich with Last.fm
  const enrichData = await enrichFromSeeds(
    seeds.map((s) => ({ artist: s.artist, title: s.title }))
  );
  const similarArtistNames = enrichData.similarArtists.slice(0, 15).map((a) => a.name);

  const directionLabel = step.chosenDirection ?? "explore";
  const directionsJson = step.directionsJson as {
    directions?: Array<{ label: string; rationale: string }>;
    hypothesis?: string;
    wellTroddenDirection?: { label: string; rationale: string };
  } | null;

  const chosenDir = directionsJson?.directions?.find((d) => d.label === directionLabel);
  const directionRationale = chosenDir?.rationale ?? "Explore new territory.";
  const hypothesisText = directionsJson?.hypothesis ?? "";
  const recap = hypothesisText;
  const wtDir = directionsJson?.wellTroddenDirection;

  // ---- Build LLM recs (Propose → Resolve → Narrate) ----
  const llmRecs: Array<{
    diveStepId: number;
    type: string;
    mbid: string;
    title: string;
    artist: string;
    year: number | null;
    narrativeText: string;
    linksJson: unknown;
    arm: string;
    likelyKnown: string;
  }> = [];

  // ---- Propose → Resolve loop; retries once with broader prompt if all candidates fail ----
  type VerifiedRec = {
    mbid: string;
    type: string;
    title: string;
    artist: string;
    year: number | null;
    relationships: unknown;
    likelyKnown: string;
  };

  const pipelineStart = Date.now();

  function remainingBudgetMs(): number {
    return PIPELINE_BUDGET_MS - (Date.now() - pipelineStart);
  }

  async function runProposalRound(broader: boolean): Promise<VerifiedRec[]> {
    const candidates = await propose({
      portraitText,
      recap,
      directionLabel,
      directionRationale,
      similarArtists: similarArtistNames,
      count: MAX_CANDIDATES,
      broader,
    });

    const roundVerified: VerifiedRec[] = [];
    for (const c of candidates) {
      if (roundVerified.length >= TARGET_RECS) break;

      const budget = remainingBudgetMs();
      if (budget <= 0) {
        logger.warn({ stepId, verified: roundVerified.length }, "Pipeline budget exhausted — stopping resolve loop early");
        break;
      }

      // Use whichever is smaller: the per-request default or whatever budget remains
      const effectiveTimeout = Math.min(MB_REQUEST_TIMEOUT_MS, budget);
      const resolved = await resolve(c, effectiveTimeout);
      if (!resolved) {
        // Similarity-gate rejections and timeout errors are both logged inside musicbrainz.ts
        continue;
      }
      roundVerified.push({
        mbid: resolved.mbid,
        type: resolved.type === "recording" ? "track" : "album",
        title: resolved.title,
        artist: resolved.artist,
        year: resolved.year,
        relationships: resolved.relationships,
        likelyKnown: c.likely_known,
      });
    }
    return roundVerified;
  }

  let verified = await runProposalRound(false);

  if (verified.length === 0) {
    logger.warn({ stepId }, "No LLM candidates passed MusicBrainz gate on first round — retrying with broader prompt");
    if (remainingBudgetMs() > 0) {
      verified = await runProposalRound(true);
      if (verified.length === 0) {
        logger.warn({ stepId }, "No LLM candidates passed MusicBrainz gate after broader retry — step will have only control-arm rec");
      } else {
        logger.info({ stepId, count: verified.length }, "Broader retry succeeded");
      }
    } else {
      logger.warn({ stepId }, "Pipeline budget exhausted before broader retry — step will have only control-arm rec");
    }
  }

  if (verified.length > 0) {
    const narrated = await Promise.all(
      verified.map(async (v) => {
        const [narrative, links] = await Promise.all([
          narrate({
            portraitText,
            rec: { title: v.title, artist: v.artist, year: v.year, relationships: v.relationships },
            directionLabel,
            priorRatings: priorRatingsFormatted,
          }),
          resolveLinks(v.mbid, v.type as "track" | "album", v.title, v.artist),
        ]);
        return {
          diveStepId: stepId,
          type: v.type,
          mbid: v.mbid,
          title: v.title,
          artist: v.artist,
          year: v.year,
          narrativeText: narrative,
          linksJson: links,
          arm: "llm",
          likelyKnown: v.likelyKnown,
        };
      })
    );
    llmRecs.push(...narrated);
  }

  // ---- Control arm: ALWAYS inserted regardless of LLM outcome ----
  // Source: Last.fm (verified external dataset); MB resolution attempted but not required.
  const wtRec = await buildWellTroddenRec({ stepId, enrichData, wtDir, seeds, directionLabel });

  // ---- Persist all recs ----
  const allRecs = [...llmRecs, wtRec];
  const inserted = await Promise.all(
    allRecs.map((rec) =>
      db
        .insert(recommendationsTable)
        .values({
          diveStepId: rec.diveStepId,
          type: rec.type,
          mbid: rec.mbid,
          title: rec.title,
          artist: rec.artist,
          year: rec.year ?? null,
          narrativeText: rec.narrativeText,
          linksJson: rec.linksJson as unknown as Record<string, unknown>,
          arm: rec.arm,
          likelyKnown: rec.likelyKnown,
        })
        .returning()
    )
  ).then((r) => r.flat());

  // Mirror to taste events
  await db.insert(tasteEventsTable).values({
    userId,
    kind: "choice",
    payloadJson: {
      stepId,
      direction: directionLabel,
      llmCount: llmRecs.length,
      recs: inserted.map((r) => ({ mbid: r.mbid, arm: r.arm })),
    },
  });

  return formatRecs(inserted);
}

async function buildWellTroddenRec(opts: {
  stepId: number;
  enrichData: EnrichResult;
  wtDir: { label: string; rationale: string } | undefined;
  seeds: Array<{ artist: string; title: string }>;
  directionLabel: string;
}): Promise<{
  diveStepId: number;
  type: string;
  mbid: string;
  title: string;
  artist: string;
  year: number | null;
  narrativeText: string;
  linksJson: unknown;
  arm: string;
  likelyKnown: string;
}> {
  const { stepId, enrichData, wtDir, seeds } = opts;

  // Determine candidate from Last.fm similar-track → similar-artist → primary seed
  let wtTitle: string;
  let wtArtist: string;

  if (enrichData.similarTracks.length > 0) {
    const st = enrichData.similarTracks[0];
    wtTitle = st.name;
    wtArtist = st.artist;
  } else if (enrichData.similarArtists.length > 0) {
    wtArtist = enrichData.similarArtists[0].name;
    wtTitle = seeds[0]?.title ?? "a popular track";
  } else {
    // Last resort: use primary seed
    wtArtist = seeds[0]?.artist ?? "Unknown artist";
    wtTitle = seeds[0]?.title ?? "a popular track";
  }

  const narrative =
    `The well-trodden road: "${wtTitle}" by ${wtArtist} is the obvious conventional pick. ` +
    (wtDir?.rationale ?? "A reliable recommendation based on listening patterns similar to yours.");

  // Attempt MB resolution — not gated for control arm
  let mbid = `lastfm:${wtArtist.toLowerCase().replace(/[^\w]/g, "-")}:${wtTitle.toLowerCase().replace(/[^\w]/g, "-")}`;
  let resolvedTitle = wtTitle;
  let resolvedArtist = wtArtist;
  let resolvedYear: number | null = null;

  try {
    const wtResolved = await resolve({ artist: wtArtist, title: wtTitle, type: "track", likely_known: "high" });
    if (wtResolved) {
      mbid = wtResolved.mbid;
      resolvedTitle = wtResolved.title;
      resolvedArtist = wtResolved.artist;
      resolvedYear = wtResolved.year;
    }
  } catch {
    logger.info({ wtArtist, wtTitle }, "Well-trodden MB resolution failed — using Last.fm fallback");
  }

  const wtLinks = await resolveLinks(mbid, "track", resolvedTitle, resolvedArtist).catch(() => ({
    spotify: `https://open.spotify.com/search/${encodeURIComponent(`${resolvedArtist} ${resolvedTitle}`)}`,
    youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${resolvedArtist} ${resolvedTitle}`)}`,
    appleMusic: null,
    source: "search_fallback" as const,
  }));

  return {
    diveStepId: stepId,
    type: "track",
    mbid,
    title: resolvedTitle,
    artist: resolvedArtist,
    year: resolvedYear,
    narrativeText: narrative,
    linksJson: wtLinks,
    arm: "well_trodden",
    likelyKnown: "high",
  };
}

function formatRecs(recs: Array<typeof recommendationsTable.$inferSelect>) {
  return recs.map((rec) => ({
    id: rec.id,
    diveStepId: rec.diveStepId,
    type: rec.type,
    mbid: rec.mbid,
    title: rec.title,
    artist: rec.artist,
    year: rec.year ?? null,
    narrativeText: rec.narrativeText ?? null,
    linksJson: rec.linksJson ?? null,
    artworkUrl: rec.artworkUrl ?? null,
    arm: rec.arm,
    likelyKnown: rec.likelyKnown ?? null,
    latestRating: null,
    createdAt: rec.createdAt.toISOString(),
  }));
}
