/**
 * Unit tests for the Last.fm listening-history import (importHistory.ts).
 *
 * All external dependencies (DB, Last.fm HTTP, ELO backfill) are mocked.
 *
 * Scenarios:
 *  1. Happy path — fresh tracks land in focus_ratings as unstarred "known".
 *  2. De-dupe    — tracks already in the taste graph (by mbid OR by
 *                  title|artist under a different mbid) are skipped.
 *  3. Batch self-de-dupe — the same track twice in one response inserts once.
 *  4. Unknown user — the Last.fm 404 propagates as an error.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The module reads LASTFM_API_KEY at load time — set it before imports run.
vi.hoisted(() => {
  process.env.LASTFM_API_KEY = "test-key";
});

vi.mock("@workspace/db", () => {
  const table = { name: "mock-table" };
  return {
    db: {
      select: vi.fn(),
      selectDistinct: vi.fn(),
      insert: vi.fn(),
    },
    focusRatingsTable: { ...table, $inferInsert: {} },
    seedsTable: table,
    recommendationsTable: table,
    ratingsTable: table,
    diveStepsTable: table,
    divesTable: table,
    tasteEventsTable: table,
  };
});

vi.mock("../http.js", () => ({
  httpGet: vi.fn(),
}));

vi.mock("../elo.js", () => ({
  ensureUserTracksSeeded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { db } from "@workspace/db";
import { httpGet } from "../http.js";
import { ensureUserTracksSeeded } from "../elo.js";
import { importLastfmHistory } from "../importHistory.js";

type ViFn = ReturnType<typeof vi.fn>;
type DbMock = { select: ViFn; selectDistinct: ViFn; insert: ViFn };

const USER_ID = 7;

// ---------------------------------------------------------------------------
// Chain builders (same conventions as recommend.test.ts)
// ---------------------------------------------------------------------------

function buildSelectChain(value: unknown) {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(value).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(value).catch(fn),
    from: vi.fn(),
    where: vi.fn(),
    innerJoin: vi.fn(),
  };
  for (const key of ["from", "where", "innerJoin"]) {
    (chain[key] as ViFn).mockReturnValue(chain);
  }
  return chain;
}

function buildInsertChain() {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(undefined).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(undefined).catch(fn),
    values: vi.fn(),
  };
  (chain.values as ViFn).mockReturnValue(chain);
  return chain;
}

/**
 * Queue the three identity queries loadExistingIdentity makes, in call order:
 * focus_ratings (select), seeds (select), rated recs (selectDistinct).
 */
function setupIdentity(opts?: { focus?: unknown[]; seeds?: unknown[]; ratedRecs?: unknown[] }) {
  const dbMock = db as unknown as DbMock;
  dbMock.select
    .mockReturnValueOnce(buildSelectChain(opts?.focus ?? []))
    .mockReturnValueOnce(buildSelectChain(opts?.seeds ?? []));
  dbMock.selectDistinct.mockReturnValueOnce(buildSelectChain(opts?.ratedRecs ?? []));
}

/** A Last.fm user.gettoptracks response for the given tracks. */
function lfmResponse(tracks: Array<{ name: string; artist: string; mbid?: string; playcount?: string }>) {
  return {
    toptracks: {
      track: tracks.map((t) => ({
        name: t.name,
        mbid: t.mbid ?? "",
        playcount: t.playcount ?? "10",
        artist: { name: t.artist },
      })),
      "@attr": { user: "TestUser", total: String(tracks.length), totalPages: "1" },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ensureUserTracksSeeded).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("importLastfmHistory", () => {
  it("imports fresh tracks as unstarred 'known' focus ratings", async () => {
    vi.mocked(httpGet).mockResolvedValue(lfmResponse([
      { name: "Karma Police", artist: "Radiohead", mbid: "mbid-real" },
      { name: "Valerie", artist: "The Zutons" }, // no mbid → synthetic key
    ]));
    setupIdentity();
    const insertChains = [buildInsertChain(), buildInsertChain()];
    const dbMock = db as unknown as DbMock;
    dbMock.insert
      .mockReturnValueOnce(insertChains[0]) // focus_ratings batch
      .mockReturnValueOnce(insertChains[1]); // taste_events summary

    const result = await importLastfmHistory({ userId: USER_ID, username: "TestUser", limit: 50 });

    expect(result).toEqual({ fetched: 2, imported: 2, skipped: 0 });

    const rows = (insertChains[0].values as ViFn).mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      userId: USER_ID,
      mbid: "mbid-real",
      title: "Karma Police",
      artist: "Radiohead",
      listenState: "known",
      score: null,
    });
    expect(rows[1].mbid).toBe("lastfm:the-zutons:valerie");

    // Summary taste-event, not one per track
    const event = (insertChains[1].values as ViFn).mock.calls[0][0] as Record<string, unknown>;
    expect(event.kind).toBe("history_import");

    // ELO rows backfilled immediately so Rankings/Compare see the imports
    expect(ensureUserTracksSeeded).toHaveBeenCalledWith(USER_ID);
  });

  it("skips tracks already in the taste graph — by mbid or by title|artist", async () => {
    vi.mocked(httpGet).mockResolvedValue(lfmResponse([
      { name: "Karma Police", artist: "Radiohead", mbid: "mbid-kp" },  // known by mbid
      { name: "Valerie", artist: "The Zutons" },                        // known by title|artist
      { name: "Fresh Track", artist: "New Artist" },                    // genuinely new
    ]));
    setupIdentity({
      focus: [{ mbid: "mbid-kp", title: "Karma Police", artist: "Radiohead" }],
      seeds: [{ mbid: "mbid-other", title: "VALERIE", artist: "The  Zutons" }], // case/space differences
    });
    const focusInsert = buildInsertChain();
    const eventInsert = buildInsertChain();
    (db as unknown as DbMock).insert
      .mockReturnValueOnce(focusInsert)
      .mockReturnValueOnce(eventInsert);

    const result = await importLastfmHistory({ userId: USER_ID, username: "TestUser" });

    expect(result).toEqual({ fetched: 3, imported: 1, skipped: 2 });
    const rows = (focusInsert.values as ViFn).mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Fresh Track");
  });

  it("de-dupes within the fetched batch itself", async () => {
    vi.mocked(httpGet).mockResolvedValue(lfmResponse([
      { name: "Same Song", artist: "Same Band" },
      { name: "same song", artist: "Same Band" },
    ]));
    setupIdentity();
    const focusInsert = buildInsertChain();
    (db as unknown as DbMock).insert
      .mockReturnValueOnce(focusInsert)
      .mockReturnValueOnce(buildInsertChain());

    const result = await importLastfmHistory({ userId: USER_ID, username: "TestUser" });

    expect(result.imported).toBe(1);
    expect((focusInsert.values as ViFn).mock.calls[0][0]).toHaveLength(1);
  });

  it("propagates an unknown-user error without touching the DB", async () => {
    vi.mocked(httpGet).mockRejectedValue(new Error("HTTP 404 Not Found for https://ws.audioscrobbler.com/..."));

    await expect(
      importLastfmHistory({ userId: USER_ID, username: "no-such-user" }),
    ).rejects.toThrow("HTTP 404");

    expect((db as unknown as DbMock).insert).not.toHaveBeenCalled();
  });
});
