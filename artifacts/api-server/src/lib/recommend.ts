/**
 * Recommend pipeline — Propose → Resolve → Narrate → Control arm.
 * Only verified tracks (passed MusicBrainz gate) get shown.
 * A well_trodden control-arm record is ALWAYS inserted for every step (A/B comparison).
 */

import { db, seedsTable, portraitsTable, diveStepsTable, recommendationsTable, ratingsTable, tasteEventsTable, divesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  enrichFromSeeds, enrichFromFocus, lastfmTopTrack,
  lastfmSimilarArtists, lastfmTagTopArtists, lastfmTagTopTracks,
  type EnrichResult, type SimilarArtist, type Focus,
} from "./enrich";
import { resolve, MB_REQUEST_TIMEOUT_MS } from "./musicbrainz";
import { resolveLinks } from "./links";
import { propose, narrate } from "./llm";
import { getEloSignal } from "./elo";
import { logger } from "./logger";

const MAX_CANDIDATES = 7;
const TARGET_RECS = 3;

/** Max time to wait for the LLM propose step (ms). */
const PROPOSE_BUDGET_MS = 40_000; // Kimi K2 via OpenRouter can easily take 30s under load
/**
 * Guaranteed time budget for the MusicBrainz resolve loop (ms), measured from
 * when propose() returns — not from the start of the whole pipeline. This means
 * a slow LLM response can't silently starve the resolver of its entire budget.
 */
const RESOLVE_BUDGET_MS = 30_000; // cold MB cache needs ~8s/call; 30s covers 3-4 candidates

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

  // Head-to-head ELO signal — the user's strongest-ranked tracks steer propose.
  const eloSignal = await getEloSignal(userId, 6);
  const eloTopFormatted = eloSignal.top.map((t) => `"${t.title}" by ${t.artist}`);

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
  // Second-tier neighbours: less obvious than the well-trodden top-10 but still
  // genuinely in this direction's space. Giving these to the LLM expands its
  // vocabulary without pointing it at the most predictable names.
  const adjacentArtistNames = enrichData.similarArtists.slice(15, 25).map((a) => a.name);

  // Artists already recommended in any previous step of this dive. The LLM is
  // instructed to avoid repeating them; we also hard-gate any that slip through.
  const priorDiveRecs = await db
    .select({ artist: recommendationsTable.artist })
    .from(recommendationsTable)
    .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
    .where(eq(diveStepsTable.diveId, step.diveId))
    .catch(() => []);
  const priorDiveArtists = [...new Set(priorDiveRecs.map((r) => r.artist))];
  const priorDiveArtistSet = new Set(priorDiveRecs.map((r) => r.artist.toLowerCase()));

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

  /**
   * Run one propose→resolve round. `resolveDeadline` is an absolute timestamp
   * (Date.now()-based) set AFTER propose() returns, so the resolve loop always
   * gets RESOLVE_BUDGET_MS regardless of how long the LLM took.
   */
  async function runProposalRound(broader: boolean): Promise<VerifiedRec[]> {
    const proposeTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("propose timeout")), PROPOSE_BUDGET_MS)
    );

    let candidates: Awaited<ReturnType<typeof propose>>;
    try {
      candidates = await Promise.race([
        propose({
          portraitText,
          recap,
          directionLabel,
          directionRationale,
          similarArtists: similarArtistNames,
          adjacentArtists: adjacentArtistNames,
          priorDiveArtists,
          eloTop: eloTopFormatted,
          count: MAX_CANDIDATES,
          broader,
        }),
        proposeTimeout,
      ]);
    } catch (err) {
      logger.warn({ stepId, broader, err: String(err) }, "propose() timed out or failed — skipping round");
      return [];
    }

    // Log what the LLM proposed so failures are diagnosable without relying on
    // transient log snapshots (the MB-gate rejection is logged inside musicbrainz.ts).
    logger.info(
      { stepId, broader, proposed: candidates.map((c) => `${c.artist} — ${c.title}`) },
      "Propose: raw LLM candidates before MB gate",
    );

    // Resolve budget starts NOW (after propose returned), not at pipeline start.
    const resolveDeadline = Date.now() + RESOLVE_BUDGET_MS;

    const roundVerified: VerifiedRec[] = [];
    for (const c of candidates) {
      if (roundVerified.length >= TARGET_RECS) break;

      const remainingMs = resolveDeadline - Date.now();
      if (remainingMs <= 0) {
        logger.warn({ stepId, verified: roundVerified.length }, "Resolve budget exhausted — stopping resolve loop early");
        break;
      }

      // Use whichever is smaller: the per-request default or whatever budget remains
      const effectiveTimeout = Math.min(MB_REQUEST_TIMEOUT_MS, remainingMs);
      const resolved = await resolve(c, effectiveTimeout);
      if (!resolved) {
        // Similarity-gate rejections and timeout errors are both logged inside musicbrainz.ts
        continue;
      }

      // ---- Change 2: hard artist-level diversity gate ----
      // Even if the LLM ignored the prompt instruction, we never let the same
      // artist appear twice within one step or carry over from a prior step.
      const artistKey = resolved.artist.toLowerCase();
      if (priorDiveArtistSet.has(artistKey)) {
        logger.info({ stepId, artist: resolved.artist }, "Diversity gate: artist already in a prior dive step — skipping");
        continue;
      }
      if (roundVerified.some((r) => r.artist.toLowerCase() === artistKey)) {
        logger.info({ stepId, artist: resolved.artist }, "Diversity gate: artist already in this round — skipping");
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
    verified = await runProposalRound(true);
    if (verified.length === 0) {
      logger.warn({ stepId }, "No LLM candidates passed MusicBrainz gate after broader retry — trying Last.fm tag fallback");
    } else {
      logger.info({ stepId, count: verified.length }, "Broader retry succeeded");
    }
  }

  // Narrate and persist verified LLM recs (arm = "llm").
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

  // ---- Last.fm tag fallback ----
  // Both LLM rounds failed to produce any verified recs. Use the direction label
  // as a Last.fm genre tag and pull top tracks from it — real, fan-verified picks
  // that are guaranteed to exist in the Last.fm catalogue. We still gate each one
  // through MusicBrainz so the MBID is real, but the pool is much more reliable
  // than open-ended LLM hallucinations under time pressure.
  if (llmRecs.length === 0) {
    logger.info({ stepId, direction: directionLabel }, "Last.fm tag fallback: fetching top tracks for direction");
    const tagTracks = await lastfmTagTopTracks(directionLabel).catch(() => []);
    logger.info({ stepId, tagTrackCount: tagTracks.length }, "Last.fm tag fallback: pool size");

    // Collect artists already used in this dive (across all steps) to avoid repeats.
    const priorDiveRecs = await db
      .select({ artist: recommendationsTable.artist })
      .from(recommendationsTable)
      .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
      .where(eq(diveStepsTable.diveId, step.diveId))
      .catch(() => []);
    const usedFbArtists = new Set(priorDiveRecs.map((r) => r.artist.toLowerCase()));

    const fallbackDeadline = Date.now() + 25_000; // 25s to verify up to TARGET_RECS - 1 fallback picks

    for (const t of tagTracks) {
      if (llmRecs.length >= TARGET_RECS - 1) break; // always leave room for the well_trodden arm
      if (usedFbArtists.has(t.artist.toLowerCase())) continue;
      if (Date.now() > fallbackDeadline) {
        logger.warn({ stepId }, "Last.fm tag fallback: deadline exceeded");
        break;
      }

      const remainingMs = fallbackDeadline - Date.now();
      const resolved = await resolve(
        { artist: t.artist, title: t.name, type: "track", likely_known: "medium" },
        Math.min(MB_REQUEST_TIMEOUT_MS, remainingMs),
      ).catch(() => null);
      if (!resolved) continue;

      const [narrative, links] = await Promise.all([
        narrate({
          portraitText,
          rec: { title: resolved.title, artist: resolved.artist, year: resolved.year, relationships: resolved.relationships },
          directionLabel,
          priorRatings: priorRatingsFormatted,
        }),
        resolveLinks(resolved.mbid, "track", resolved.title, resolved.artist),
      ]);

      llmRecs.push({
        diveStepId: stepId,
        type: "track",
        mbid: resolved.mbid,
        title: resolved.title,
        artist: resolved.artist,
        year: resolved.year,
        narrativeText: narrative,
        linksJson: links,
        artworkUrl: links.artworkUrl ?? null,
        arm: "tag_fallback",
        likelyKnown: "medium",
      });
      usedFbArtists.add(t.artist.toLowerCase());
    }

    if (llmRecs.length > 0) {
      logger.info({ stepId, count: llmRecs.length, direction: directionLabel }, "Last.fm tag fallback produced recs");
    } else {
      logger.warn({ stepId }, "Last.fm tag fallback also produced nothing — step will have only control-arm rec");
    }
  }

  // ---- Control arm: ALWAYS inserted regardless of LLM outcome ----
  // Source: Last.fm (verified external dataset); MB resolution attempted but not required.
  // Pass the in-genre LLM rec artists so the "obvious pick" is a CF neighbour of
  // THIS dive's genre, not of the user's global seed taste.
  const wtRec = await buildWellTroddenRec({
    stepId, diveId: step.diveId, enrichData, wtDir, seeds, directionLabel,
    llmRecArtists: llmRecs.map((r) => r.artist),
  });

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

async function buildWellTroddenRec(opts: {
  stepId: number;
  diveId: number;
  enrichData: EnrichResult;
  wtDir: { label: string; rationale: string } | undefined;
  seeds: Array<{ artist: string; title: string }>;
  directionLabel: string;
  llmRecArtists: string[];
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
  const { stepId, diveId, enrichData, wtDir, seeds, directionLabel, llmRecArtists } = opts;

  // ---- 1. De-duplicate: skip artists already used in this dive's well_trodden
  // recs, and the three LLM recs on THIS step (the obvious pick must be distinct). ----
  const priorWt = await db
    .select({ artist: recommendationsTable.artist })
    .from(recommendationsTable)
    .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
    .where(and(eq(diveStepsTable.diveId, diveId), eq(recommendationsTable.arm, "well_trodden")))
    .catch(() => []);
  const usedArtists = new Set(priorWt.map((r) => r.artist.toLowerCase()));
  const llmArtistSet = new Set(llmRecArtists.map((a) => a.toLowerCase()));
  const isEligible = (name: string) => {
    const n = name.toLowerCase();
    return n.length > 1 && !usedArtists.has(n) && !llmArtistSet.has(n);
  };

  // ---- 2. Build an IN-GENRE candidate pool ----
  // The bug this fixes: enrichData is anchored on the user's first *seed*, so its
  // similar-artist pool reflects their global taste (often nothing like the genre
  // they're actually diving into). The three LLM recs, by contrast, ARE the genre
  // being explored — so their aggregated CF neighbours are the real "obvious pick"
  // for this leg. We rank a neighbour higher the more of the three recs it's
  // similar to (a genuine collaborative-filtering centrality signal).
  const keywords = directionKeywords(`${wtDir?.label ?? ""} ${directionLabel}`);
  const kwScore = (text: string) =>
    keywords.filter((kw) => text.toLowerCase().includes(kw)).length;

  async function inGenrePool(): Promise<SimilarArtist[]> {
    // (a) CF neighbours of the in-genre LLM recs — the primary, most reliable source.
    if (llmRecArtists.length > 0) {
      const lists = await Promise.all(llmRecArtists.map((a) => lastfmSimilarArtists(a).catch(() => [])));
      const agg = new Map<string, { name: string; match: number; hits: number }>();
      for (const list of lists) {
        for (const a of list) {
          const key = a.name.toLowerCase();
          const cur = agg.get(key) ?? { name: a.name, match: 0, hits: 0 };
          cur.match += a.match;
          cur.hits += 1;
          agg.set(key, cur);
        }
      }
      // Sort by how many recs it neighbours (centrality), then summed match.
      const ranked = [...agg.values()]
        .sort((x, y) => y.hits - x.hits || y.match - x.match)
        .map((a) => ({ name: a.name, match: a.match }));
      if (ranked.length > 0) return ranked;
    }

    // (b) Genre-tag top artists — covers the "LLM produced nothing" case and any
    // dive where the direction/well-trodden label reads as a genre tag.
    for (const label of [wtDir?.label, directionLabel]) {
      const tag = label?.trim();
      if (!tag) continue;
      const tagArtists = await lastfmTagTopArtists(tag).catch(() => []);
      if (tagArtists.length > 0) return tagArtists;
    }

    // (c) Last resort: the seed-anchored pool (the old behaviour).
    return enrichData.similarArtists;
  }

  let wtTitle: string | null = null;
  let wtArtist: string | null = null;

  const pool = (await inGenrePool())
    .filter((a) => isEligible(a.name))
    .map((a) => ({ ...a, _kw: kwScore(a.name) }))
    // Pool is already genre-ranked; use keyword alignment only as a gentle nudge.
    .sort((a, b) => b._kw - a._kw || b.match - a.match);

  // Walk the ranked pool and take the first artist whose top track resolves.
  for (const cand of pool.slice(0, 8)) {
    const top = await lastfmTopTrack(cand.name).catch(() => null);
    if (top) {
      wtArtist = cand.name;
      wtTitle = top.name;
      logger.debug({ wtArtist, wtTitle, source: "in-genre CF pool" }, "Well-trodden: resolved from in-genre pool");
      break;
    }
  }

  // ---- 3. Fallbacks if the pool yielded nothing playable ----
  if (!wtArtist) {
    const scoredTracks = enrichData.similarTracks
      .map((t) => ({ ...t, _score: kwScore(t.artist) + kwScore(t.name), _used: !isEligible(t.artist) }))
      .sort((a, b) => Number(a._used) - Number(b._used) || b._score - a._score || b.match - a.match);

    if (scoredTracks.length > 0) {
      wtTitle  = scoredTracks[0].name;
      wtArtist = scoredTracks[0].artist;
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

  // Use the direction label (always accurate to this step) rather than the
  // pre-baked wtDir.rationale (written at hypothesis time — may reference a
  // different artist/genre if the CF resolution diverged from the original context).
  const wtRationale = wtDir?.label
    ? `A reliable pick within the ${wtDir.label} direction.`
    : "A reliable recommendation based on listening patterns similar to yours.";

  const narrative =
    `The well-trodden road: "${wtTitle}" by ${wtArtist} is the obvious conventional pick. ` +
    wtRationale;

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
