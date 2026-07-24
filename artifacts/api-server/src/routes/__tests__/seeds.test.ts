/**
 * Integration tests for GET /seeds/search — error-clearing behaviour on retry.
 *
 * Scenario:
 *   1. MusicBrainz times out → route returns 503 (the UI shows the error banner).
 *   2. The user edits their query and retries → route returns 200 with results
 *      (the UI's React Query hook sees a new query key, resets isError to false,
 *      and the error banner disappears while the spinner and then results render).
 *
 * All external dependencies (MusicBrainz, DB) are mocked so the suite runs
 * fully in-process with no network or database access.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports so Vitest hoists them.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const table = { name: "mock-table" };
  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
    },
    seedsTable: table,
  };
});

vi.mock("../../lib/musicbrainz.js", () => ({
  searchMusicBrainz: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { searchMusicBrainz } from "../../lib/musicbrainz.js";
import seedsRouter from "../seeds.js";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/", seedsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_RESULTS = [
  {
    mbid: "mbid-karma-police",
    type: "track",
    title: "Karma Police",
    artist: "Radiohead",
    release: "OK Computer",
    year: 1997,
  },
  {
    mbid: "mbid-creep",
    type: "track",
    title: "Creep",
    artist: "Radiohead",
    release: "Pablo Honey",
    year: 1992,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /search — timeout then successful retry", () => {
  it("returns 503 when MusicBrainz search throws (simulated timeout)", async () => {
    vi.mocked(searchMusicBrainz).mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const res = await request(makeApp())
      .get("/search")
      .query({ userId: 1, q: "radiohead", type: "track", page: 1 });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining("timed out") });
  });

  it("returns 200 with results on a successful retry after a timeout", async () => {
    // First call: simulate timeout
    vi.mocked(searchMusicBrainz).mockRejectedValueOnce(new Error("ETIMEDOUT"));
    // Second call: simulate successful response
    vi.mocked(searchMusicBrainz).mockResolvedValueOnce(MOCK_RESULTS as never);

    const app = makeApp();

    // Step 1 — timed-out search: error banner should appear in the UI
    const errorRes = await request(app)
      .get("/search")
      .query({ userId: 1, q: "radio", type: "track", page: 1 });

    expect(errorRes.status).toBe(503);
    expect(errorRes.body).toMatchObject({ error: expect.stringContaining("timed out") });

    // Step 2 — user edits the query and retries: error should clear and results appear.
    // In the UI, the React Query hook receives a new query key (different `q`), which
    // resets isError → false before this request even resolves, so the error banner
    // disappears and the spinner shows. When this request succeeds, results render.
    const retryRes = await request(app)
      .get("/search")
      .query({ userId: 1, q: "radiohead", type: "track", page: 1 });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body).toEqual(MOCK_RESULTS);
  });

  it("returns 200 on an immediate retry with the same query after a timeout", async () => {
    // First call fails, second succeeds — same query string (user hits retry without
    // changing the text, e.g. after clearing and re-typing the same term).
    vi.mocked(searchMusicBrainz)
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(MOCK_RESULTS as never);

    const app = makeApp();

    const first = await request(app)
      .get("/search")
      .query({ userId: 1, q: "radiohead", type: "track", page: 1 });
    expect(first.status).toBe(503);

    const second = await request(app)
      .get("/search")
      .query({ userId: 1, q: "radiohead", type: "track", page: 1 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(MOCK_RESULTS);
  });

  it("propagates any MusicBrainz error as 503, not just ETIMEDOUT", async () => {
    vi.mocked(searchMusicBrainz).mockRejectedValueOnce(new Error("socket hang up"));

    const res = await request(makeApp())
      .get("/search")
      .query({ userId: 1, q: "radiohead", type: "track", page: 1 });

    expect(res.status).toBe(503);
  });
});

describe("GET /search — input validation", () => {
  it("returns 400 when userId is missing", async () => {
    const res = await request(makeApp())
      .get("/search")
      .query({ q: "radiohead", type: "track" }); // no `userId`

    expect(res.status).toBe(400);
  });

  it("returns 400 when type is an invalid enum value", async () => {
    vi.mocked(searchMusicBrainz).mockResolvedValueOnce(MOCK_RESULTS as never);

    const res = await request(makeApp())
      .get("/search")
      .query({ userId: 1, q: "radiohead", type: "banana" });

    expect(res.status).toBe(400);
  });
});
