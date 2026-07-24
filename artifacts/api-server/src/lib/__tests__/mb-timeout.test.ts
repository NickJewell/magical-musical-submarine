/**
 * Tests that resolve() handles MusicBrainz per-request timeouts gracefully —
 * returning null instead of hanging or re-throwing.
 *
 * The per-request timeout is enforced by httpGet() via AbortController.
 * These tests mock httpGet so the abort path is exercised in isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports so vitest can hoist them.
// ---------------------------------------------------------------------------

vi.mock("../http.js", () => ({
  httpGet: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  // enrichEntity checks the DB for a cached entity before making a network
  // call. Mock it to return [] (no cached entity) so the abort path is reached.
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue([]);

  return {
    db: {
      select: vi.fn().mockReturnValue(chain),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    },
    resolvedEntitiesTable: { name: "mock-resolved-entities" },
  };
});

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { httpGet } from "../http.js";
import { resolve } from "../musicbrainz.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an AbortError — the error httpGet() raises when timeoutMs elapses. */
function makeAbortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** Create a fetch-abort error using the message pattern (some runtimes use this). */
function makeAbortedMessageError(): Error {
  return new Error("Request aborted due to timeout");
}

const TRACK_CANDIDATE = {
  artist: "Radiohead",
  title: "Karma Police",
  type: "track" as const,
  likely_known: "medium" as const,
};

const ALBUM_CANDIDATE = {
  artist: "Radiohead",
  title: "OK Computer",
  type: "album" as const,
  likely_known: "high" as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolve() — per-request timeout handling", () => {
  // -------------------------------------------------------------------------
  // AbortError (name === "AbortError") — primary timeout signal
  // -------------------------------------------------------------------------
  it("returns null for a track when httpGet throws AbortError", async () => {
    vi.mocked(httpGet).mockRejectedValue(makeAbortError());

    const result = await resolve(TRACK_CANDIDATE, 100);

    expect(result).toBeNull();
  });

  it("returns null for an album when httpGet throws AbortError", async () => {
    vi.mocked(httpGet).mockRejectedValue(makeAbortError());

    const result = await resolve(ALBUM_CANDIDATE, 100);

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Error with "aborted" in message — secondary timeout signal used by some
  // fetch implementations (e.g. node-fetch in older Node versions).
  // -------------------------------------------------------------------------
  it("returns null when httpGet throws an error with 'aborted' in the message", async () => {
    vi.mocked(httpGet).mockRejectedValue(makeAbortedMessageError());

    const result = await resolve(TRACK_CANDIDATE, 100);

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Any other network error also results in null (not a throw)
  // -------------------------------------------------------------------------
  it("returns null when httpGet throws a generic network error", async () => {
    vi.mocked(httpGet).mockRejectedValue(new Error("ECONNRESET"));

    const result = await resolve(TRACK_CANDIDATE, 100);

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Resolve() must not hang — it returns promptly even under error conditions
  // -------------------------------------------------------------------------
  it("resolves promptly — does not hang when httpGet is rejected immediately", async () => {
    vi.mocked(httpGet).mockRejectedValue(makeAbortError());

    const start = Date.now();
    const result = await resolve(TRACK_CANDIDATE, 50);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // Even on a slow CI runner, a mocked rejection resolves in well under 500 ms.
    expect(elapsed).toBeLessThan(500);
  });
});
