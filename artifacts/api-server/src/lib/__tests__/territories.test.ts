/**
 * Unit tests for the taste-territories clustering (territories.ts).
 *
 * Covers the pure, deterministic half of the pipeline — the tag clustering —
 * which decides what the LLM is even asked to name:
 *  1. Sibling tags ("indie" / "indie rock") collapse into ONE territory.
 *  2. Distinct scenes become separate territories; tracks go to their
 *     strongest tag; unmatched tracks land in the outlands.
 *  3. Junk tags ("seen live") can never become a territory.
 *  4. Loved tracks (3★, winning ELO) shape the map hardest.
 *  5. Affinity labels verbalize the private stats qualitatively.
 */

import { describe, it, expect, vi } from "vitest";

// territories.ts pulls in db/enrich/llm at module level — mock them so the
// pure functions can be imported without side effects.
vi.mock("@workspace/db", () => {
  const table = { name: "mock-table" };
  return {
    db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() },
    tasteTerritoriesTable: table,
    focusRatingsTable: table,
    ratingsTable: table,
    recommendationsTable: table,
    diveStepsTable: table,
    divesTable: table,
  };
});
vi.mock("../elo.js", () => ({
  getRankedTracks: vi.fn(),
  ensureUserTracksSeeded: vi.fn(),
  BASE_RATING: 1500,
}));
vi.mock("../enrich.js", () => ({ lastfmArtistTopTags: vi.fn() }));
vi.mock("../llm.js", () => ({ nameTerritories: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { clusterTracks, trackWeight, affinityLabel, type TaggedTrack } from "../territories.js";

// ---- Fixtures ----

const mk = (
  title: string,
  artist: string,
  tags: Array<[string, number]>,
  opts: { stars?: number | null; elo?: number; matches?: number } = {},
): TaggedTrack => ({
  track: { mbid: `mbid-${title}`, title, artist },
  stars: opts.stars ?? null,
  elo: opts.elo ?? 1500,
  matches: opts.matches ?? 0,
  tags: tags.map(([name, weight]) => ({ name, weight })),
});

describe("clusterTracks", () => {
  it("collapses sibling tags into one territory instead of two", () => {
    // Every indie track carries BOTH "indie" and "indie rock" — >60% overlap,
    // so only the stronger tag should be picked.
    const indie = [
      mk("A", "Band1", [["indie", 90], ["indie rock", 80]]),
      mk("B", "Band2", [["indie", 85], ["indie rock", 75]]),
      mk("C", "Band3", [["indie", 80], ["indie rock", 70]]),
    ];
    const jazz = [
      mk("D", "Trio1", [["jazz", 95]]),
      mk("E", "Trio2", [["jazz", 90]]),
      mk("F", "Trio3", [["jazz", 88]]),
    ];
    const { clusters } = clusterTracks([...indie, ...jazz]);

    const tags = clusters.map((c) => c.tag);
    expect(tags).toContain("jazz");
    // exactly one of the indie siblings survives
    expect(tags.filter((t) => t.startsWith("indie"))).toHaveLength(1);
    expect(clusters).toHaveLength(2);
  });

  it("assigns each track to its strongest tag and routes strays to the outlands", () => {
    const tracks = [
      // A carries both tags — its assignment must follow the STRONGER one.
      mk("A", "Band1", [["shoegaze", 95], ["dream pop", 40]]),
      mk("B", "Band2", [["shoegaze", 90]]),
      mk("C", "Band3", [["dream pop", 95]]),
      mk("D", "Band4", [["dream pop", 88]]),
      // No usable overlap with either scene:
      mk("E", "Polka9", [["polka", 99]]),
    ];
    const { clusters, outlands } = clusterTracks(tracks);

    const shoegaze = clusters.find((c) => c.tag === "shoegaze");
    const dreampop = clusters.find((c) => c.tag === "dream pop");
    expect(shoegaze?.tracks.map((t) => t.track.title).sort()).toEqual(["A", "B"]);
    expect(dreampop?.tracks.map((t) => t.track.title).sort()).toEqual(["C", "D"]);
    // polka appears on only one track (< minSize 2) → never a territory
    expect(clusters.find((c) => c.tag === "polka")).toBeUndefined();
    expect(outlands.map((t) => t.track.title)).toEqual(["E"]);
  });

  it("never lets junk tags become a territory", () => {
    const tracks = [
      mk("A", "Band1", [["seen live", 100], ["post-punk", 60]]),
      mk("B", "Band2", [["seen live", 100], ["post-punk", 55]]),
      mk("C", "Band3", [["seen live", 100], ["post-punk", 50]]),
    ];
    const { clusters } = clusterTracks(tracks);
    expect(clusters.map((c) => c.tag)).toEqual(["post-punk"]);
  });
});

describe("trackWeight", () => {
  it("weights loved tracks hardest", () => {
    const three = trackWeight({ stars: 3, elo: 1500, matches: 0 });
    const two = trackWeight({ stars: 2, elo: 1500, matches: 0 });
    const plain = trackWeight({ stars: null, elo: 1500, matches: 0 });
    const winner = trackWeight({ stars: null, elo: 1600, matches: 4 });
    expect(three).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(plain);
    expect(winner).toBeGreaterThan(plain);
  });
});

describe("affinityLabel", () => {
  it("verbalizes strongholds, solid ground, arm's length, and unexplored", () => {
    const stronghold = [
      mk("A", "X", [], { stars: 3 }), mk("B", "X", [], { stars: 3 }), mk("C", "X", [], { stars: 2 }),
    ];
    const armsLength = [
      mk("A", "X", [], { stars: 1 }), mk("B", "X", [], { stars: 1 }), mk("C", "X", [], { stars: 1 }),
    ];
    const unexplored = [mk("A", "X", []), mk("B", "X", [])];

    expect(affinityLabel(stronghold)).toContain("stronghold");
    expect(affinityLabel(armsLength)).toContain("arm's length");
    expect(affinityLabel(unexplored)).toContain("barely explored");
  });
});
