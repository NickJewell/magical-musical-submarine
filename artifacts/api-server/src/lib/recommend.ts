/**
 * Recommend pipeline — Propose → Resolve → Narrate → Control arm.
 * Only verified tracks (passed MusicBrainz gate) get shown.
 * A well_trodden control-arm record is ALWAYS inserted for every step (A/B comparison).
 */

import { db, seedsTable, portraitsTable, diveStepsTable, recommendationsTable, ratingsTable, tasteEventsTable, divesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { enrichFromSeeds, enrichFromFocus, lastfmTopTrack, type EnrichResult, type Focus } from "./enrich";
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

  // Build prior ratings context — the user's recent rating history across ALL
  // their dives (not just this step), including any notes they left. This gives
  // the narrator real material to draw on when a past track illuminates why the
  // new one fits — rather than an almost-always-empty same-step list.
  const priorRatings = await db
    .select({
      title: recommendationsTable.title,
      artist: recommendationsTable.artist,
      listenState: ratingsTable.listenState,
      score: ratingsTable.score,
      reviewText: ratingsTable.reviewText,
    })
    .from(ratingsTable)
    .innerJoin(recommendationsTable, eq(ratingsTable.recId, recommendationsTable.id))
    .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
    .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
    .where(eq(divesTable.userId, userId))
    .orderBy(desc(ratingsTable.ratedAt))
    .limit(20)
    .catch(() => []);

  const priorRatingsFormatted = priorRatings.map((r) => ({
    title: r.title,
    artist: r.artist,
    listenState: r.listenState,
    score: r.score != null ? parseFloat(String(r.score)) : null,
    reviewText: r.reviewText ?? null,
  }));

  const directionLabel = step.chosenDirection ?? "explore";
  const directionsJson = step.directionsJson as {
    directions?: Array<{ label: string; rationale: string }>;
    hypothesis?: string;
    wellTroddenDirection?: { label: string; rationale: string };
    focus?: Focus;
  } | null;

  // Enrich from the dive's focus when it started from a specific selection,
  // otherwise from the user's seeds. This anchors BOTH the propose-steering and
  // the well-trodden control arm on the chosen starting point, so the 4th
  // (well-trodden) recommendation is the obvious CF neighbour of the focus.
  const focus = directionsJson?.focus ?? null;
  const enrichData = focus
    ? await enrichFromFocus(focus)
    : await enrichFromSeeds(seeds.map((s) => ({ artist: s.artist, title: s.title })));
  const similarArtistNames = enrichData.similarArtists.slice(0, 15).map((a) => a.name);

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
    artworkUrl: string | null;
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
      // Use the candidate's declared type (always "track" — locked by LLM schema),
      // not resolved.type which is an internal MB entity kind ("recording",
      // "release-group") and can be stale if the mbid was cached under a
      // different entity type in a previous run.
      roundVerified.push({
        mbid: resolved.mbid,
        type: c.type,
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
          artworkUrl: links.artworkUrl ?? null,
          arm: "llm",
          likelyKnown: v.likelyKnown,
        };
      })
    );
    llmRecs.push(...narrated);
  }

  // ---- Control arm: ALWAYS inserted regardless of LLM outcome ----
  // Source: Last.fm (verified external dataset); MB resolution attempted but not required.
  const wtRec = await buildWellTroddenRec({ stepId, diveId: step.diveId, enrichData, wtDir, seeds, directionLabel });

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
          artworkUrl: rec.artworkUrl ?? null,
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

// ---- Keyword helpers for direction-aware scoring ----

const WT_STOP_WORDS = new Set([
  "with", "from", "that", "this", "they", "have", "been", "will", "more",
  "into", "than", "also", "some", "most", "well", "trodden", "direction",
  "obvious", "pick", "music", "sound", "style", "classic", "classics",
  "standard", "standards", "the", "and", "for",
]);

function directionKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3 && !WT_STOP_WORDS.has(w));
}

/** Clean wtDir.label → candidate artist name (strip genre/descriptor noise) */
function extractArtistFromLabel(label: string): string {
  return label
    .replace(/\b(classics?|standards?|picks?|direction|obvious|well[- ]trodden|music|sounds?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildWellTroddenRec(opts: {
  stepId: number;
  diveId: number;
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
  artworkUrl: string | null;
  arm: string;
  likelyKnown: string;
}> {
  const { stepId, diveId, enrichData, wtDir, seeds, directionLabel } = opts;

  // ---- 1. De-duplicate: skip artists already used in this dive's well_trodden recs ----
  const priorWt = await db
    .select({ artist: recommendationsTable.artist })
    .from(recommendationsTable)
    .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
    .where(and(eq(diveStepsTable.diveId, diveId), eq(recommendationsTable.arm, "well_trodden")))
    .catch(() => []);
  const usedArtists = new Set(priorWt.map((r) => r.artist.toLowerCase()));

  // ---- 2. Keyword scoring: rank candidates by alignment to wtDir + direction ----
  const keywords = directionKeywords(`${wtDir?.label ?? ""} ${directionLabel}`);
  const score = (text: string) =>
    keywords.filter((kw) => text.toLowerCase().includes(kw)).length;

  // ---- 3. First choice: use wtDir.label as the artist the LLM intended ----
  let wtTitle: string | null = null;
  let wtArtist: string | null = null;

  if (wtDir?.label) {
    const candidateArtist = extractArtistFromLabel(wtDir.label);
    const isNotUsed = candidateArtist.length > 1 && !usedArtists.has(candidateArtist.toLowerCase());
    if (isNotUsed) {
      const topTrack = await lastfmTopTrack(candidateArtist).catch(() => null);
      if (topTrack) {
        wtTitle = topTrack.name;
        wtArtist = candidateArtist;
        logger.debug({ wtArtist, wtTitle, label: wtDir.label }, "Well-trodden: resolved from wtDir label");
      }
    }
  }

  // ---- 4. Fallback: score similar tracks/artists, prefer non-duplicates & direction-aligned ----
  if (!wtArtist) {
    const scoredTracks = enrichData.similarTracks
      .map((t) => ({ ...t, _score: score(t.artist) + score(t.name), _used: usedArtists.has(t.artist.toLowerCase()) }))
      .sort((a, b) => Number(a._used) - Number(b._used) || b._score - a._score || b.match - a.match);

    const scoredArtists = enrichData.similarArtists
      .map((a) => ({ ...a, _score: score(a.name), _used: usedArtists.has(a.name.toLowerCase()) }))
      .sort((a, b) => Number(a._used) - Number(b._used) || b._score - a._score || b.match - a.match);

    if (scoredTracks.length > 0) {
      wtTitle  = scoredTracks[0].name;
      wtArtist = scoredTracks[0].artist;
    } else if (scoredArtists.length > 0) {
      wtArtist = scoredArtists[0].name;
      wtTitle  = seeds[0]?.title ?? "a popular track";
    } else {
      // Last resort: primary seed
      wtArtist = seeds[0]?.artist ?? "Unknown artist";
      wtTitle  = seeds[0]?.title  ?? "a popular track";
    }
  }

  // By this point both are always set; coerce for the type checker and as a
  // final safety net.
  wtTitle = wtTitle ?? "a popular track";
  wtArtist = wtArtist ?? "Unknown artist";

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
    spotifyTrackId: null,
    youtubeVideoId: null,
    artworkUrl: null,
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
    artworkUrl: wtLinks.artworkUrl ?? null,
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
