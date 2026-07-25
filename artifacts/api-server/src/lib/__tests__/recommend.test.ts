/**
 * Unit tests for the recommend() pipeline (recommend.ts).
 *
 * All external dependencies (DB, LLM, MusicBrainz, Last.fm, links) are mocked
 * so these tests run in-process with no network or database access.
 *
 * Scenarios covered:
 *  1. Happy path   — first proposal round returns verified recs (no retry).
 *  2. Retry path   — first round returns 0 verified; broader retry succeeds.
 *  3. All-fail     — both rounds return 0; only the control-arm rec is returned.
 *  4. Cache hit    — existing recs returned immediately without calling propose().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports so vitest hoists them correctly.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const table = { name: "mock-table" };
  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
    },
    seedsTable: table,
    portraitsTable: table,
    diveStepsTable: table,
    recommendationsTable: { ...table, $inferSelect: {} },
    ratingsTable: table,
    tasteEventsTable: table,
    divesTable: table,
  };
});

vi.mock("../enrich.js", () => ({
  enrichFromSeeds: vi.fn(),
}));

vi.mock("../musicbrainz.js", () => ({
  resolve: vi.fn(),
  MB_REQUEST_TIMEOUT_MS: 8000,
}));

vi.mock("../links.js", () => ({
  resolveLinks: vi.fn(),
}));

vi.mock("../llm.js", () => ({
  propose: vi.fn(),
  narrate: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import mocked modules (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { db } from "@workspace/db";
import { enrichFromSeeds } from "../enrich.js";
import { resolve } from "../musicbrainz.js";
import { resolveLinks } from "../links.js";
import { propose, narrate } from "../llm.js";
import { recommend } from "../recommend.js";

// ---------------------------------------------------------------------------
// Local convenience type for the db mock object.
// "as unknown as DbMock" is the correct TypeScript pattern when the declared
// type and the runtime type are unrelated (here: Drizzle vs. vi.fn()).
// ---------------------------------------------------------------------------

type ViFn = ReturnType<typeof vi.fn>;
type DbMock = { select: ViFn; insert: ViFn };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STEP_ID = 42;
const USER_ID = 7;

const mockStep = {
  id: STEP_ID,
  diveId: 1,
  chosenDirection: "explore",
  directionsJson: {
    directions: [{ label: "explore", rationale: "Go wide." }],
    hypothesis: "You might enjoy these.",
    wellTroddenDirection: { label: "familiar", rationale: "Reliable pick." },
  },
};

const mockSeeds = [{ artist: "Radiohead", title: "Karma Police", userId: USER_ID }];
const mockPortraits = [{ text: "An indie-rock enthusiast.", version: 1, userId: USER_ID }];

/** A minimal LLM proposal object */
const mkProposal = (title: string, artist: string) => ({
  title,
  artist,
  type: "track" as const,
  likely_known: "medium" as const,
  rationale: "good pick",
});

/** A minimal MusicBrainz resolved entity */
const mkResolved = (title: string, artist: string, mbid = "mbid-" + title) => ({
  mbid,
  type: "recording",
  title,
  artist,
  year: 2001,
  relationships: {},
});

/** The links stub returned by resolveLinks */
const LINKS_STUB = {
  spotify: "https://spotify.com/track/x",
  youtube: "https://youtube.com/watch?v=x",
  appleMusic: null,
  source: "odesli" as const,
  spotifyTrackId: null,
  youtubeVideoId: null,
  deezerId: null,
  artworkUrl: null,
};

/** The inserted row shape recommend() expects back from db.insert().returning() */
const mkInserted = (title: string, artist: string, arm: string, mbid: string) => ({
  id: Math.floor(Math.random() * 1000),
  diveStepId: STEP_ID,
  type: "track",
  mbid,
  title,
  artist,
  year: 2001,
  narrativeText: "A great track.",
  linksJson: LINKS_STUB,
  artworkUrl: null,
  arm,
  likelyKnown: "medium",
  createdAt: new Date(),
});

// ---------------------------------------------------------------------------
// DB mock chain builders
//
// recommend() uses three distinct call patterns:
//   (a) await db.select().from(T).where(...)              — direct await, no .limit()
//   (b) await db.select().from(T).where(...).limit(n)     — .limit() terminates
//   (c) await db.select(...).from(T).innerJoin(...).where(...).orderBy(...).limit(n).catch(fn)
//
// buildSelectChain returns an object that is both:
//   • thenable (has .then / .catch / .finally) so pattern (a) works via `await`
//   • chainable (.from/.where/.orderBy/.innerJoin all return the same chain)
//   • .limit() returns a real Promise (which already has .catch())
// ---------------------------------------------------------------------------

function buildSelectChain(value: unknown) {
  const limitPromise = Promise.resolve(value);

  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(value).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(value).catch(fn),
    finally: (fn: () => void) => Promise.resolve(value).finally(fn),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    innerJoin: vi.fn(),
    limit: vi.fn().mockReturnValue(limitPromise),
  };

  for (const key of ["from", "where", "orderBy", "innerJoin"]) {
    (chain[key] as ViFn).mockReturnValue(chain);
  }

  return chain;
}

/**
 * Build an insert chain for a single rec insertion:
 *   db.insert(T).values({...}).returning() → resolves to [row]
 *
 * Also supports:
 *   db.insert(T).values({...})             — direct await (tasteEventsTable)
 */
function buildInsertChain(returnedRows: unknown[]) {
  const chain: Record<string, unknown> = {
    // Thenable so `await db.insert(T).values(...)` works when .returning() isn't called
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(undefined).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(undefined).catch(fn),
    returning: vi.fn().mockResolvedValue(returnedRows),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  };
  chain.values = vi.fn().mockReturnValue(chain);
  return chain;
}

// ---------------------------------------------------------------------------
// Per-test setup helpers
// ---------------------------------------------------------------------------

/**
 * Wire up db.select mock across all the calls recommend() makes:
 *  1. existing recs check  → []          awaited directly
 *  2. load step            → [mockStep]  ends with .limit(1)
 *  3. load seeds           → mockSeeds   awaited directly
 *  4. load portraits       → [portrait]  ends with .orderBy().limit(1)
 *  5. load prior ratings   → []          ends with .limit(20).catch()
 */
function setupDbSelectSequence(overrides?: { existingRecs?: unknown[] }) {
  const existing = overrides?.existingRecs ?? [];
  const dbMock = db as unknown as DbMock;
  dbMock.select
    .mockReturnValueOnce(buildSelectChain(existing))
    .mockReturnValueOnce(buildSelectChain([mockStep]))
    .mockReturnValueOnce(buildSelectChain(mockSeeds))
    .mockReturnValueOnce(buildSelectChain(mockPortraits))
    .mockReturnValueOnce(buildSelectChain([]));
}

function setupEnrich() {
  vi.mocked(enrichFromSeeds).mockResolvedValue({
    similarArtists: [{ name: "Thom Yorke", match: 0.9 }, { name: "PJ Harvey", match: 0.8 }],
    similarTracks: [{ name: "Fake Plastic Trees", artist: "Radiohead", match: 0.85 }],
    tags: [],
    wellTroddenArtist: null,
  });
}

function setupLinks() {
  vi.mocked(resolveLinks).mockResolvedValue(LINKS_STUB);
}

function setupNarrate() {
  vi.mocked(narrate).mockResolvedValue("A great track.");
}

/**
 * Set up db.insert so each rec gets its own single-row chain (.returning())
 * followed by one more call for the tasteEventsTable (.values() only).
 */
function setupDbInsert(rows: unknown[]) {
  const dbMock = db as unknown as DbMock;
  for (const row of rows) {
    dbMock.insert.mockReturnValueOnce(buildInsertChain([row]));
  }
  // tasteEventsTable: .values() awaited directly, no .returning()
  dbMock.insert.mockReturnValueOnce(buildInsertChain([]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // vi.resetAllMocks() — not just clearAllMocks() — so that mockReturnValueOnce
  // queues from a previous test are fully drained before the next one starts.
  // clearAllMocks() only wipes call/result history; it leaves unspent queued
  // return values in place, which can leak across tests (e.g. the cache-hit
  // test leaves 4 unspent db.select values that would corrupt the next test).
  vi.resetAllMocks();
});

describe("recommend() pipeline", () => {
  // -------------------------------------------------------------------------
  // Scenario 1: Happy path — first round returns verified recs
  // -------------------------------------------------------------------------
  describe("happy path — first round succeeds", () => {
    it("returns LLM recs plus the control-arm rec without retrying", async () => {
      setupDbSelectSequence();
      setupEnrich();
      setupLinks();
      setupNarrate();

      const proposals = [
        mkProposal("Karma Police", "Radiohead"),
        mkProposal("Exit Music", "Radiohead"),
        mkProposal("Paranoid Android", "Radiohead"),
      ];
      vi.mocked(propose).mockResolvedValue(proposals);

      // All three candidates pass MusicBrainz resolution; control arm also resolves
      vi.mocked(resolve)
        .mockResolvedValueOnce(mkResolved("Karma Police", "Radiohead", "mbid-kp"))
        .mockResolvedValueOnce(mkResolved("Exit Music", "Radiohead", "mbid-em"))
        .mockResolvedValueOnce(mkResolved("Paranoid Android", "Radiohead", "mbid-pa"))
        .mockResolvedValueOnce(mkResolved("Fake Plastic Trees", "Radiohead", "mbid-fpt"));

      const llmInserted = proposals.map((p) =>
        mkInserted(p.title, p.artist, "llm", "mbid-" + p.title)
      );
      const wtInserted = mkInserted("Fake Plastic Trees", "Radiohead", "well_trodden", "mbid-fpt");
      setupDbInsert([...llmInserted, wtInserted]);

      const result = await recommend({ stepId: STEP_ID, userId: USER_ID });

      // propose() called exactly once — no retry
      expect(propose).toHaveBeenCalledTimes(1);
      expect(vi.mocked(propose).mock.calls[0][0]).toMatchObject({ broader: false });

      // 3 LLM recs + 1 well_trodden
      expect(result).toHaveLength(4);
      const arms = result.map((r) => r.arm);
      expect(arms.filter((a) => a === "llm")).toHaveLength(3);
      expect(arms.filter((a) => a === "well_trodden")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Retry path — first round fails, broader retry succeeds
  // -------------------------------------------------------------------------
  describe("retry path — first round fails, broader retry succeeds", () => {
    it("calls propose() twice (normal then broader) and returns retry recs", async () => {
      setupDbSelectSequence();
      setupEnrich();
      setupLinks();
      setupNarrate();

      const firstRoundProposals = [
        mkProposal("Hallucinated Track 1", "Ghost Band"),
        mkProposal("Hallucinated Track 2", "Ghost Band"),
      ];
      const secondRoundProposals = [
        mkProposal("Reckoner", "Radiohead"),
        mkProposal("All I Need", "Radiohead"),
      ];

      vi.mocked(propose)
        .mockResolvedValueOnce(firstRoundProposals)   // first round — all fail MB gate
        .mockResolvedValueOnce(secondRoundProposals); // broader retry — both pass

      vi.mocked(resolve)
        .mockResolvedValueOnce(null) // first round c1 rejected by MB gate
        .mockResolvedValueOnce(null) // first round c2 rejected by MB gate
        .mockResolvedValueOnce(mkResolved("Reckoner", "Radiohead", "mbid-reck"))   // retry c1
        .mockResolvedValueOnce(mkResolved("All I Need", "Radiohead", "mbid-ain"))  // retry c2
        .mockResolvedValueOnce(mkResolved("Fake Plastic Trees", "Radiohead", "mbid-fpt")); // WT

      setupDbInsert([
        mkInserted("Reckoner", "Radiohead", "llm", "mbid-reck"),
        mkInserted("All I Need", "Radiohead", "llm", "mbid-ain"),
        mkInserted("Fake Plastic Trees", "Radiohead", "well_trodden", "mbid-fpt"),
      ]);

      const result = await recommend({ stepId: STEP_ID, userId: USER_ID });

      // propose() called twice; second must use broader=true
      expect(propose).toHaveBeenCalledTimes(2);
      expect(vi.mocked(propose).mock.calls[0][0]).toMatchObject({ broader: false });
      expect(vi.mocked(propose).mock.calls[1][0]).toMatchObject({ broader: true });

      // 2 LLM recs from retry + 1 well_trodden
      expect(result).toHaveLength(3);
      const arms = result.map((r) => r.arm);
      expect(arms.filter((a) => a === "llm")).toHaveLength(2);
      expect(arms.filter((a) => a === "well_trodden")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: All-fail — both rounds return 0, only control arm rec
  // -------------------------------------------------------------------------
  describe("all-fail path — both rounds return 0 verified recs", () => {
    it("returns only the control-arm rec when all LLM candidates fail the MB gate", async () => {
      setupDbSelectSequence();
      setupEnrich();
      setupLinks();
      setupNarrate();

      vi.mocked(propose).mockResolvedValue([mkProposal("Bogus Track", "Nobody")]);

      // All resolve() calls return null — both rounds fail gate
      vi.mocked(resolve)
        .mockResolvedValueOnce(null) // round 1 candidate rejected
        .mockResolvedValueOnce(null) // round 2 candidate rejected (broader retry)
        .mockResolvedValueOnce(mkResolved("Fake Plastic Trees", "Radiohead", "mbid-fpt")); // WT

      setupDbInsert([
        mkInserted("Fake Plastic Trees", "Radiohead", "well_trodden", "mbid-fpt"),
      ]);

      const result = await recommend({ stepId: STEP_ID, userId: USER_ID });

      // Both rounds attempted
      expect(propose).toHaveBeenCalledTimes(2);

      // Only the control-arm rec is present
      expect(result).toHaveLength(1);
      expect(result[0].arm).toBe("well_trodden");
    });
  });

  // -------------------------------------------------------------------------
  // Cache hit — returns existing recs immediately without calling propose()
  // -------------------------------------------------------------------------
  describe("cache hit", () => {
    it("returns cached recs without calling propose()", async () => {
      const cachedRec = mkInserted("Karma Police", "Radiohead", "llm", "mbid-kp");
      setupDbSelectSequence({ existingRecs: [cachedRec] });

      const result = await recommend({ stepId: STEP_ID, userId: USER_ID });

      expect(propose).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Karma Police");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Pipeline budget exhausted mid-round — partial results returned
  //
  // Three proposals are queued; after the first candidate resolves the mocked
  // Date.now() jumps past the 30 s budget, so the loop breaks before calling
  // resolve() for the remaining two candidates.  The result should contain
  // exactly one LLM rec (the one that resolved before the budget ran out) plus
  // the control-arm rec.
  // -------------------------------------------------------------------------
  describe("pipeline budget exhausted mid-round", () => {
    it("stops the resolve loop early and returns partial LLM recs plus control-arm rec", async () => {
      setupDbSelectSequence();
      setupEnrich();
      setupLinks();
      setupNarrate();

      // Three proposals, but the budget expires after the first one resolves.
      const proposals = [
        mkProposal("Karma Police", "Radiohead"),
        mkProposal("Exit Music", "Radiohead"),
        mkProposal("Paranoid Android", "Radiohead"),
      ];
      vi.mocked(propose).mockResolvedValue(proposals);

      // Flip this flag after the first LLM resolve() so Date.now() jumps past
      // the 30 s pipeline budget on subsequent remainingBudgetMs() calls.
      let budgetExhausted = false;
      const T0 = 1_000_000; // arbitrary fixed start time
      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockImplementation(() => (budgetExhausted ? T0 + 31_000 : T0));

      vi.mocked(resolve)
        // First LLM candidate — resolves, then exhausts budget
        .mockImplementationOnce(async () => {
          const rec = mkResolved("Karma Police", "Radiohead", "mbid-kp");
          budgetExhausted = true; // budget runs out after this call returns
          return rec;
        })
        // Control-arm (well_trodden) — still called regardless of LLM budget
        .mockResolvedValueOnce(
          mkResolved("Fake Plastic Trees", "Radiohead", "mbid-fpt")
        );

      setupDbInsert([
        mkInserted("Karma Police", "Radiohead", "llm", "mbid-kp"),
        mkInserted("Fake Plastic Trees", "Radiohead", "well_trodden", "mbid-fpt"),
      ]);

      const result = await recommend({ stepId: STEP_ID, userId: USER_ID });

      dateNowSpy.mockRestore();

      // propose() was called exactly once (budget exhausted before any retry)
      expect(propose).toHaveBeenCalledTimes(1);

      // resolve() called only for the first LLM candidate + control arm —
      // the other two LLM candidates were never attempted because budget ran out.
      expect(vi.mocked(resolve)).toHaveBeenCalledTimes(2);

      // Exactly one LLM rec (partial result) plus the control-arm rec
      expect(result.filter((r) => r.arm === "llm")).toHaveLength(1);
      expect(result.filter((r) => r.arm === "well_trodden")).toHaveLength(1);
      expect(result[0].title).toBe("Karma Police");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: All MB resolve() calls return null (simulates all calls timing
  // out) — the control-arm rec must still be returned so the UI never shows an
  // empty spinner instead of at least one recommendation.
  // -------------------------------------------------------------------------
  describe("all MB calls time out — control-arm rec always returned", () => {
    it("returns the control-arm rec even when every resolve() call returns null", async () => {
      setupDbSelectSequence();
      setupEnrich();
      setupLinks();
      setupNarrate();

      // Both rounds have proposals, but every resolve() returns null (timeout / gate miss)
      vi.mocked(propose).mockResolvedValue([
        mkProposal("Hallucinated Track", "Ghost Band"),
      ]);

      vi.mocked(resolve)
        .mockResolvedValueOnce(null) // round 1 — timed out / rejected
        .mockResolvedValueOnce(null) // broader round 2 — also timed out / rejected
        .mockResolvedValueOnce(
          mkResolved("Fake Plastic Trees", "Radiohead", "mbid-fpt")
        ); // control arm always attempted independently

      setupDbInsert([
        mkInserted("Fake Plastic Trees", "Radiohead", "well_trodden", "mbid-fpt"),
      ]);

      const result = await recommend({ stepId: STEP_ID, userId: USER_ID });

      // No LLM recs — only the control-arm rec is present
      expect(result.filter((r) => r.arm === "llm")).toHaveLength(0);
      expect(result.filter((r) => r.arm === "well_trodden")).toHaveLength(1);
      expect(result).toHaveLength(1);
    });
  });
});
