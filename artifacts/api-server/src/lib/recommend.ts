/**
 * Recommend pipeline — Propose → Resolve → Narrate → Control arm.
 * Only verified tracks (passed MusicBrainz gate) get shown.
 * A well_trodden control-arm record is ALWAYS inserted for every step (A/B comparison).
 */

import { db, seedsTable, portraitsTable, diveStepsTable, recommendationsTable, ratingsTable, focusRatingsTable, tasteEventsTable, divesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  enrichFromSeeds, enrichFromFocus, lastfmTopTrack,
  lastfmSimilarArtists, lastfmTagTopArtists,
  type EnrichResult, type SimilarArtist, type Focus,
} from "./enrich";
import { resolve, MB_REQUEST_TIMEOUT_MS } from "./musicbrainz";
import { resolveLinks } from "./links";
import { propose, narrate } from "./llm";
import { getEloSignal } from "./elo";
import { logger } from "./logger";

const MAX_CANDIDATES = 7;
const TARGET_RECS = 3;

/** How many already-rated tracks to name in the propose prompt as a soft hint. */
const RATED_AVOID_HINT_MAX = 30;

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
/** Stable identity for a track independent of which resolver produced its mbid. */
const trackKey = (title: string, artist: string) => `${normalize(title)}|${normalize(artist)}`;

interface RatedIndex {
  mbids: Set<string>;
  keys: Set<string>;
  recent: Array<{ title: string; artist: string }>;
}

/**
 * Every track the user has already rated — from dive-track ratings AND Discover
 * & Rank (focus) ratings — indexed by mbid and by normalized "title|artist". A
 * dive shouldn't re-serve a song they've already judged, so this is the
 * exclusion set the propose/resolve loop and the well-trodden arm filter
 * against. We match on both mbid and title/artist because the same song can land
 * under different mbids depending on the resolver (real MusicBrainz id vs a
 * synthetic `lastfm:`/`spotify:` key).
 */
async function loadRatedTrackIndex(userId: number): Promise<RatedIndex> {
  const [recRated, focusRated] = await Promise.all([
    db
      .select({
        mbid: recommendationsTable.mbid,
        title: recommendationsTable.title,
        artist: recommendationsTable.artist,
      })
      .from(ratingsTable)
      .innerJoin(recommendationsTable, eq(ratingsTable.recId, recommendationsTable.id))
      .innerJoin(diveStepsTable, eq(recommendationsTable.diveStepId, diveStepsTable.id))
      .innerJoin(divesTable, eq(diveStepsTable.diveId, divesTable.id))
      .where(eq(divesTable.userId, userId))
      .catch(() => []),
    db
      .select({
        mbid: focusRatingsTable.mbid,
        title: focusRatingsTable.title,
        artist: focusRatingsTable.artist,
      })
      .from(focusRatingsTable)
      .where(eq(focusRatingsTable.userId, userId))
      .catch(() => []),
  ]);

  const mbids = new Set<string>();
  const keys = new Set<string>();
  const recent: Array<{ title: string; artist: string }> = [];
  for (const r of [...recRated, ...focusRated]) {
    if (r.mbid) mbids.add(r.mbid);
    if (r.title && r.artist) {
      keys.add(trackKey(r.title, r.artist));
      if (recent.length < RATED_AVOID_HINT_MAX) recent.push({ title: r.title, artist: r.artist });
    }
  }
  return { mbids, keys, recent };
}

/** Max time to wait for the LLM propose step (ms). */
const PROPOSE_BUDGET_MS = 25_000;
/**
 * Guaranteed time budget for the MusicBrainz resolve loop (ms), measured from
 * when propose() returns — not from the start of the whole pipeline. This means
 * a slow LLM response can't silently starve the resolver of its entire budget.
 */
const RESOLVE_BUDGET_MS = 20_000;

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

  // Tracks the user has already rated — a dive shouldn't re-serve these, so we
  // hard-filter proposals and the well-trodden pick against this set below.
  const ratedIndex = await loadRatedTrackIndex(userId);
  const avoidHint = ratedIndex.recent.map((r) => `"${r.title}" by ${r.artist}`);

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
          eloTop: eloTopFormatted,
          avoid: avoidHint,
          count: MAX_CANDIDATES,
          broader,
        }),
        proposeTimeout,
      ]);
    } catch (err) {
      logger.warn({ stepId, broader, err: String(err) }, "propose() timed out or failed — skipping round");
      return [];
    }

    // Resolve budget starts NOW (after propose returned), not at pipeline start.
    const resolveDeadline = Date.now() + RESOLVE_BUDGET_MS;

    const roundVerified: VerifiedRec[] = [];
    for (const c of candidates) {
      if (roundVerified.length >= TARGET_RECS) break;

      // Skip anything the user has already rated (pre-resolve — saves an MB
      // lookup). This is the main fix: a dive must not re-serve rated songs.
      if (ratedIndex.keys.has(trackKey(c.title, c.artist))) {
        logger.debug({ stepId, title: c.title, artist: c.artist }, "Skipping already-rated candidate (pre-resolve)");
        continue;
      }

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
      // Re-check after resolution: MusicBrainz canonicalizes the title/artist and
      // gives the real mbid, so a rated track the LLM spelled differently is
      // caught here. Also drop intra-round duplicates (the LLM can repeat a
      // track, or two candidates can resolve to the same recording).
      if (ratedIndex.mbids.has(resolved.mbid) || ratedIndex.keys.has(trackKey(resolved.title, resolved.artist))) {
        logger.debug({ stepId, mbid: resolved.mbid }, "Skipping already-rated candidate (post-resolve)");
        continue;
      }
      if (roundVerified.some((v) => v.mbid === resolved.mbid || trackKey(v.title, v.artist) === trackKey(resolved.title, resolved.artist))) {
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
      logger.warn({ stepId }, "No LLM candidates passed MusicBrainz gate after broader retry — step will have only control-arm rec");
    } else {
      logger.info({ stepId, count: verified.length }, "Broader retry succeeded");
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
  // Pass the in-genre LLM rec artists so the "obvious pick" is a CF neighbour of
  // THIS dive's genre, not of the user's global seed taste.
  const wtRec = await buildWellTroddenRec({
    stepId, diveId: step.diveId, enrichData, wtDir, seeds, directionLabel,
    llmRecArtists: llmRecs.map((r) => r.artist),
    ratedIndex,
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
  ratedIndex: RatedIndex;
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
  const { stepId, diveId, enrichData, wtDir, seeds, directionLabel, llmRecArtists, ratedIndex } = opts;

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

  // Walk the ranked pool and take the first artist whose top track resolves and
  // hasn't already been rated (the obvious pick is a rec too — no repeats).
  for (const cand of pool.slice(0, 8)) {
    const top = await lastfmTopTrack(cand.name).catch(() => null);
    if (top && !ratedIndex.keys.has(trackKey(top.name, cand.name))) {
      wtArtist = cand.name;
      wtTitle = top.name;
      logger.debug({ wtArtist, wtTitle, source: "in-genre CF pool" }, "Well-trodden: resolved from in-genre pool");
      break;
    }
  }

  // ---- 3. Fallbacks if the pool yielded nothing playable ----
  if (!wtArtist) {
    const scoredTracks = enrichData.similarTracks
      .filter((t) => !ratedIndex.keys.has(trackKey(t.name, t.artist)))
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
