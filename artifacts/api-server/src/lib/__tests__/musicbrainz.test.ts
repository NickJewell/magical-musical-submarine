/**
 * Unit tests for pure functions in musicbrainz.ts:
 *  - similarity()  — Dice-coefficient bigram similarity
 *  - decide()      — picks the best candidate and applies acceptance thresholds
 */

import { describe, it, expect } from "vitest";
import { similarity, decide, normalize } from "../musicbrainz.js";

// ---------------------------------------------------------------------------
// normalize()
// ---------------------------------------------------------------------------

describe("normalize()", () => {
  it("lowercases the string", () => {
    expect(normalize("RADIOHEAD")).toBe("radiohead");
  });

  it("strips ASCII punctuation and collapses resulting whitespace", () => {
    // comma → space; adjacent spaces then collapsed by the second replace
    expect(normalize("hello, world!")).toBe("hello world");
  });

  it("collapses internal whitespace", () => {
    expect(normalize("a  b   c")).toBe("a b c");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalize("  hello  ")).toBe("hello");
  });

  it("handles a mixed-case string with punctuation", () => {
    // Non-ASCII chars (é) are treated as non-\w and replaced by spaces
    // 'Héllo, World!' → lowercase → 'héllo, world!' → strip non-\w → 'h llo  world ' → collapse → trim → 'h llo world'
    expect(normalize("Héllo, World!")).toBe("h llo world");
  });
});

// ---------------------------------------------------------------------------
// similarity()
// ---------------------------------------------------------------------------

describe("similarity()", () => {
  it("returns 1 for identical strings", () => {
    expect(similarity("Radiohead", "Radiohead")).toBe(1);
  });

  it("returns 1 for strings that are identical after normalization", () => {
    expect(similarity("Radiohead!", "radiohead")).toBe(1);
  });

  it("returns 0 when either string is empty after normalization", () => {
    expect(similarity("", "Radiohead")).toBe(0);
    expect(similarity("Radiohead", "")).toBe(0);
    expect(similarity("!!!", "Radiohead")).toBe(0); // all punct → empty after normalize
  });

  it("returns a value between 0 and 1 for partially similar strings", () => {
    const s = similarity("Thom Yorke", "Tom Yorke");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it("returns a higher score for closer strings", () => {
    const closeScore = similarity("Radiohead", "Radiohead UK");
    const farScore = similarity("Radiohead", "Led Zeppelin");
    expect(closeScore).toBeGreaterThan(farScore);
  });

  it("is symmetric", () => {
    const ab = similarity("OK Computer", "OK Computer Revisited");
    const ba = similarity("OK Computer Revisited", "OK Computer");
    expect(ab).toBeCloseTo(ba, 10);
  });
});

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

describe("decide()", () => {
  const mkCandidate = (id: string, title: string, artist: string) => ({
    id,
    title,
    artist,
    year: null,
  });

  it("returns null for an empty candidate list", () => {
    expect(decide([], "Karma Police", "Radiohead")).toBeNull();
  });

  it("returns the single candidate as best even if below threshold", () => {
    const result = decide(
      [mkCandidate("mbid-1", "Totally Different Song", "Some Other Band")],
      "Karma Police",
      "Radiohead",
      0.55,
      0.45
    );
    expect(result).not.toBeNull();
    expect(result!.mbid).toBe("mbid-1");
    expect(result!.accepted).toBe(false);
  });

  it("accepts a candidate whose title AND artist similarity both meet thresholds", () => {
    const result = decide(
      [mkCandidate("mbid-ok", "Karma Police", "Radiohead")],
      "Karma Police",
      "Radiohead"
    );
    expect(result).not.toBeNull();
    expect(result!.accepted).toBe(true);
    expect(result!.titleSim).toBe(1);
    expect(result!.artistSim).toBe(1);
  });

  it("rejects when title similarity is below threshold", () => {
    // Use a completely different title so titleSim is well below 0.55
    const result = decide(
      [mkCandidate("mbid-bad-title", "Completely Different Thing", "Radiohead")],
      "Karma Police",
      "Radiohead",
      0.55,
      0.45
    );
    expect(result).not.toBeNull();
    expect(result!.accepted).toBe(false);
  });

  it("rejects when artist similarity is below threshold", () => {
    const result = decide(
      [mkCandidate("mbid-bad-artist", "Karma Police", "An Unrelated Artist Name Here")],
      "Karma Police",
      "Radiohead",
      0.55,
      0.45
    );
    expect(result).not.toBeNull();
    expect(result!.accepted).toBe(false);
  });

  it("picks the candidate with the highest combined score when multiple exist", () => {
    const candidates = [
      mkCandidate("mbid-close", "Karma Police", "Radiohead"),
      mkCandidate("mbid-far", "Street Spirit", "Radiohead"),
    ];
    const result = decide(candidates, "Karma Police", "Radiohead");
    expect(result!.mbid).toBe("mbid-close");
  });

  it("reports correct titleSim and artistSim values in the result", () => {
    const result = decide(
      [mkCandidate("mbid-1", "Karma Police", "Radiohead")],
      "Karma Police",
      "Radiohead"
    );
    expect(result!.titleSim).toBeCloseTo(1, 5);
    expect(result!.artistSim).toBeCloseTo(1, 5);
  });

  it("respects custom threshold overrides", () => {
    // With very low thresholds even a poor match should be accepted
    const result = decide(
      [mkCandidate("mbid-1", "Karma Police", "Radiohead")],
      "Karma Police",
      "Radiohead",
      0.0,
      0.0
    );
    expect(result!.accepted).toBe(true);
  });
});
