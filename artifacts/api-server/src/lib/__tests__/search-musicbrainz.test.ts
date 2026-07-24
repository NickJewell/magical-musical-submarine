/**
 * Unit tests for searchMusicBrainz() in musicbrainz.ts.
 *
 * Covers the three key behaviours of the MBID-lookup cap introduced to keep
 * search results fast even when Last.fm returns tracks without MBIDs:
 *
 *   (a) Only MAX_MBID_LOOKUPS (4) MusicBrainz requests are fired when all
 *       tracks come back from Last.fm without MBIDs — avoids 10-second
 *       worst-case when all 10 results need serial MB lookups.
 *
 *   (b) A failed individual MBID lookup is swallowed and does not abort
 *       the whole call — the other tracks are still returned.
 *
 *   (c) Tracks whose Last.fm result already carries an MBID bypass the
 *       MusicBrainz lookup entirely.
 *
 * All network I/O is mocked via httpGet so these tests run instantly with
 * no real HTTP traffic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports so vitest can hoist them.
// ---------------------------------------------------------------------------

vi.mock("../http.js", () => ({
  httpGet: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// searchMusicBrainz does not call the DB directly, but the module-level
// import of @workspace/db is still resolved — mock it to avoid connection
// errors in the test environment.
vi.mock("@workspace/db", () => ({
  db: {},
  resolvedEntitiesTable: { name: "mock-resolved-entities" },
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { httpGet } from "../http.js";
import { searchMusicBrainz } from "../musicbrainz.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0";
const MB_BASE = "https://musicbrainz.org/ws/2";

/** Build a minimal Last.fm track.search response with `count` tracks.
 *  Set `withMbid` to give the first N tracks a pre-existing MBID. */
function makeLastFmResponse(
  count: number,
  withMbid = 0
): object {
  const tracks = Array.from({ length: count }, (_, i) => ({
    name: `Track ${i + 1}`,
    artist: `Artist ${i + 1}`,
    mbid: i < withMbid ? `existing-mbid-${i + 1}` : "",
    listeners: String(1000 - i * 10),
  }));
  return {
    results: {
      trackmatches: { track: tracks },
    },
  };
}

/** Build a minimal MusicBrainz recording search response. */
function makeMBRecordingResponse(title: string, artist: string): object {
  return {
    recordings: [
      {
        id: `mb-resolved-${title.replace(/\s/g, "-").toLowerCase()}`,
        title,
        score: 100,
        "artist-credit": [{ artist: { name: artist } }],
        releases: [{ title: "Some Album", date: "2000" }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure LASTFM_API_KEY is set so the Last.fm code path is taken.
  // The constant is read at module load time, so we rely on the environment
  // having it set (the secret is present in this project). The mock for
  // httpGet intercepts all actual HTTP calls regardless.
  process.env.LASTFM_API_KEY = process.env.LASTFM_API_KEY ?? "test-key-for-unit-tests";
});

describe("searchMusicBrainz() — MBID lookup cap (MAX_MBID_LOOKUPS = 4)", () => {
  it("(a) fires at most 4 MusicBrainz lookups even when all 10 Last.fm tracks lack MBIDs", async () => {
    vi.mocked(httpGet).mockImplementation(async (url: string) => {
      if (url.includes(LASTFM_BASE)) {
        return makeLastFmResponse(10, 0); // 10 tracks, none with an MBID
      }
      if (url.includes(`${MB_BASE}/recording`)) {
        // Return empty so the lookup produces no MBID (that's fine — we're
        // counting calls, not verifying resolution quality here).
        return { recordings: [] };
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const results = await searchMusicBrainz("test", "track");

    // One Last.fm call + at most MAX_MBID_LOOKUPS MB calls
    const mbCalls = vi.mocked(httpGet).mock.calls.filter(([url]) =>
      (url as string).includes(`${MB_BASE}/recording`)
    );
    expect(mbCalls.length).toBeLessThanOrEqual(4);

    // All 10 tracks are still returned (without MBIDs where lookups returned nothing)
    expect(results).toHaveLength(10);
  });

  it("(a) fires exactly 4 lookups, not more, when all tracks lack MBIDs", async () => {
    vi.mocked(httpGet).mockImplementation(async (url: string) => {
      if (url.includes(LASTFM_BASE)) {
        return makeLastFmResponse(10, 0);
      }
      if (url.includes(`${MB_BASE}/recording`)) {
        return { recordings: [] };
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });

    await searchMusicBrainz("test", "track");

    const mbCalls = vi.mocked(httpGet).mock.calls.filter(([url]) =>
      (url as string).includes(`${MB_BASE}/recording`)
    );
    expect(mbCalls.length).toBe(4);
  });
});

describe("searchMusicBrainz() — failed lookup does not abort the whole call", () => {
  it("(b) returns all tracks even when some MBID lookups throw", async () => {
    let mbCallCount = 0;

    vi.mocked(httpGet).mockImplementation(async (url: string) => {
      if (url.includes(LASTFM_BASE)) {
        return makeLastFmResponse(6, 0); // 6 tracks, none with MBIDs → 4 lookups capped
      }
      if (url.includes(`${MB_BASE}/recording`)) {
        mbCallCount++;
        // Alternate: even-numbered calls throw, odd succeed
        if (mbCallCount % 2 === 0) {
          throw new Error("ECONNRESET: network error");
        }
        return makeMBRecordingResponse(`Track ${mbCallCount}`, `Artist ${mbCallCount}`);
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const results = await searchMusicBrainz("test", "track");

    // All 6 tracks returned — errors didn't abort the call
    expect(results).toHaveLength(6);
  });

  it("(b) returns all tracks even when every MBID lookup throws", async () => {
    vi.mocked(httpGet).mockImplementation(async (url: string) => {
      if (url.includes(LASTFM_BASE)) {
        return makeLastFmResponse(5, 0);
      }
      if (url.includes(`${MB_BASE}/recording`)) {
        throw new Error("Connection refused");
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const results = await searchMusicBrainz("test", "track");

    // Still returns all 5 tracks even with every lookup failing
    expect(results).toHaveLength(5);
    // None of them are verified (no MBIDs resolved)
    expect(results.every((r) => !r.verified)).toBe(true);
  });

  it("(b) tracks whose lookup succeeded are marked verified even when others fail", async () => {
    let mbCallCount = 0;

    vi.mocked(httpGet).mockImplementation(async (url: string) => {
      if (url.includes(LASTFM_BASE)) {
        // 4 tracks without MBIDs — all 4 will be attempted
        return makeLastFmResponse(4, 0);
      }
      if (url.includes(`${MB_BASE}/recording`)) {
        mbCallCount++;
        if (mbCallCount === 1) {
          // First lookup succeeds
          return makeMBRecordingResponse("Track 1", "Artist 1");
        }
        // The rest fail
        throw new Error("timeout");
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const results = await searchMusicBrainz("test", "track");

    expect(results).toHaveLength(4);
    const verified = results.filter((r) => r.verified);
    // Exactly 1 track has a resolved MBID
    expect(verified.length).toBe(1);
  });
});

describe("searchMusicBrainz() — tracks with existing MBIDs bypass lookup", () => {
  it("(c) tracks already carrying an MBID from Last.fm are not looked up in MB", async () => {
    vi.mocked(httpGet).mockImplementation(async (url: string) => {
      if (url.includes(LASTFM_BASE)) {
        // 5 tracks: first 3 have MBIDs, last 2 don't
        return makeLastFmResponse(5, 3);
      }
      if (url.includes(`${MB_BASE}/recording`)) {
        return makeMBRecordingResponse("Resolved Track", "Resolved Artist");
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });

    await searchMusicBrainz("test", "track");

    // Only 2 tracks needed lookups — 3 already had MBIDs
    const mbCalls = vi.mocked(httpGet).mock.calls.filter(([url]) =>
      (url as string).includes(`${MB_BASE}/recording`)
    );
    expect(mbCalls.length).toBe(2);
  });

  it("(c) tracks with existing MBIDs are marked verified without any MB call", async () => {
    vi.mocked(httpGet).mockImplementation(async (url: string) => {
      if (url.includes(LASTFM_BASE)) {
        // All 5 tracks already have MBIDs — no lookups should fire
        return makeLastFmResponse(5, 5);
      }
      // If this is reached the test should fail — no MB calls expected
      throw new Error(`Unexpected MB call for URL: ${url}`);
    });

    const results = await searchMusicBrainz("test", "track");

    expect(results).toHaveLength(5);
    // All are verified because all had pre-existing MBIDs
    expect(results.every((r) => r.verified)).toBe(true);

    const mbCalls = vi.mocked(httpGet).mock.calls.filter(([url]) =>
      (url as string).includes(`${MB_BASE}/recording`)
    );
    expect(mbCalls.length).toBe(0);
  });

  it("(c) pre-existing MBIDs are preserved in the output exactly as Last.fm returned them", async () => {
    vi.mocked(httpGet).mockImplementation(async (url: string) => {
      if (url.includes(LASTFM_BASE)) {
        return makeLastFmResponse(3, 3); // all 3 have MBIDs
      }
      throw new Error(`Unexpected MB call for URL: ${url}`);
    });

    const results = await searchMusicBrainz("test", "track");

    expect(results[0].mbid).toBe("existing-mbid-1");
    expect(results[1].mbid).toBe("existing-mbid-2");
    expect(results[2].mbid).toBe("existing-mbid-3");
  });
});
