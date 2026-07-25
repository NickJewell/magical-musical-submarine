/**
 * Integration tests for POST /portrait/generate — cache-hit behaviour.
 *
 * When the DB already holds an LLM-generated portrait whose `seeds_hash`
 * matches the current seeds + pair choices, the route must return the cached
 * portrait immediately without invoking the LLM.
 *
 * All external dependencies (DB, LLM) are mocked so the suite runs fully
 * in-process with no network or database access.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports so Vitest hoists them.
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
    tasteEventsTable: table,
  };
});

vi.mock("../../lib/llm.js", () => ({
  generatePortrait: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { db } from "@workspace/db";
import { generatePortrait } from "../../lib/llm.js";
import portraitRouter from "../portrait.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ViFn = ReturnType<typeof vi.fn>;
type DbMock = { select: ViFn; insert: ViFn };

/**
 * Build a Drizzle-style select chain that resolves to `value`.
 *
 * Supports the three call patterns used by the portrait route:
 *   (a) db.select().from(T).where(...)                        — direct await
 *   (b) db.select().from(T).where(...).then(fn)               — with .then()
 *   (c) db.select().from(T).where(...).orderBy(...).limit(n)  — limit terminates
 */
function buildSelectChain(value: unknown) {
  const chain: Record<string, unknown> = {
    // Makes the chain directly awaitable (pattern a)
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(value).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(value).catch(fn),
    finally: (fn: () => void) => Promise.resolve(value).finally(fn),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    // limit() must return a real Promise so .then() chaining works on it (pattern c)
    limit: vi.fn().mockReturnValue(Promise.resolve(value)),
  };

  for (const key of ["from", "where", "orderBy"]) {
    (chain[key] as ViFn).mockReturnValue(chain);
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 42;

/**
 * A minimal seed row (mirrors lib/db/src/schema/seeds.ts).
 */
const mockSeed = {
  id: 1,
  userId: USER_ID,
  mbid: "mbid-karma-police",
  title: "Karma Police",
  artist: "Radiohead",
  year: 1997,
  prompt: null,
};

/**
 * Pre-compute the seeds_hash that the route will derive for `mockSeed` with
 * no pair-choice events.  We do this here so we can insert a portrait that
 * exactly matches and confirm the route skips the LLM.
 *
 * The algorithm (from portrait.ts):
 *   SHA-256( JSON.stringify({ seeds: [...normalised...], pairs: [...] }) )
 */
import { createHash } from "node:crypto";

function computeSeedsHash(
  seeds: Array<{ title: string; artist: string; year?: number | null; prompt?: string | null }>,
  pairChoices: Array<{ winner: string; loser: string; strength: number }>,
  ratingCount: number
): string {
  const payload = JSON.stringify({
    seeds: seeds.map((s) => ({
      title: s.title.trim().toLowerCase(),
      artist: s.artist.trim().toLowerCase(),
      year: s.year ?? null,
      prompt: s.prompt ?? null,
    })),
    pairs: pairChoices.map((p) => ({
      winner: p.winner.trim().toLowerCase(),
      loser: p.loser.trim().toLowerCase(),
      strength: p.strength,
    })),
    ratingCount,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// No pair choices and a taste-event count of 0 (matching the mocked db below).
const RATING_COUNT = 0;
const SEEDS_HASH = computeSeedsHash(
  [{ title: mockSeed.title, artist: mockSeed.artist, year: mockSeed.year, prompt: mockSeed.prompt }],
  [], // no pair choices
  RATING_COUNT
);

const mockCachedPortrait = {
  id: 10,
  userId: USER_ID,
  version: 1,
  text: "A devoted lover of Britpop and alternative rock.",
  source: "llm",
  seedsHash: SEEDS_HASH,
  generatedAt: new Date("2024-01-01T00:00:00Z"),
};

// ---------------------------------------------------------------------------
// App factory (avoids shared state between tests)
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/", portraitRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /portrait/generate — cache hit", () => {
  it("returns the cached portrait without calling the LLM when seeds_hash matches", async () => {
    const dbMock = db as unknown as DbMock;

    // rebuildPortrait() then the route's final fetch make six select calls:
    dbMock.select
      // 1 — load seeds:               db.select().from(seedsTable).where(...)
      .mockReturnValueOnce(buildSelectChain([mockSeed]))
      // 2 — pair-choice taste events: ...where(...).then(fn)
      .mockReturnValueOnce(buildSelectChain([]))
      // 3 — recent-rating taste events: ...orderBy(...).limit(n)
      .mockReturnValueOnce(buildSelectChain([]))
      // 4 — taste-event count:        db.select({cnt}).from(...).where(...)
      .mockReturnValueOnce(buildSelectChain([{ cnt: RATING_COUNT }]))
      // 5 — latest portrait (cache check): ...orderBy(...).limit(1) → cache hit
      .mockReturnValueOnce(buildSelectChain([mockCachedPortrait]))
      // 6 — route re-fetches the persisted row to return it
      .mockReturnValueOnce(buildSelectChain([mockCachedPortrait]));

    const res = await request(makeApp())
      .post("/portrait/generate")
      .send({ userId: USER_ID })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);

    // The response must carry the cached flag
    expect(res.body).toMatchObject({
      id: mockCachedPortrait.id,
      userId: USER_ID,
      version: 1,
      text: mockCachedPortrait.text,
      source: "llm",
      cached: true,
    });

    // LLM must NOT have been called
    expect(generatePortrait).not.toHaveBeenCalled();
  });

  it("calls the LLM when no portrait exists yet", async () => {
    const NEW_TEXT = "A newly generated portrait.";
    vi.mocked(generatePortrait).mockResolvedValue(NEW_TEXT);

    const dbMock = db as unknown as DbMock;
    const newPortrait = { ...mockCachedPortrait, id: 11, text: NEW_TEXT, version: 1 };

    // seeds, pair events, rating events, count, portrait check (empty → generate),
    // then the route's final fetch returns the freshly inserted row.
    dbMock.select
      .mockReturnValueOnce(buildSelectChain([mockSeed]))
      .mockReturnValueOnce(buildSelectChain([]))
      .mockReturnValueOnce(buildSelectChain([]))
      .mockReturnValueOnce(buildSelectChain([{ cnt: RATING_COUNT }]))
      .mockReturnValueOnce(buildSelectChain([]))
      .mockReturnValueOnce(buildSelectChain([newPortrait]));

    // insert returning the new portrait row
    const insertChain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
      catch: (fn: (e: unknown) => unknown) => Promise.resolve(undefined).catch(fn),
      values: vi.fn(),
      returning: vi.fn().mockResolvedValue([newPortrait]),
    };
    (insertChain.values as ViFn).mockReturnValue(insertChain);
    dbMock.insert.mockReturnValue(insertChain as never);

    const res = await request(makeApp())
      .post("/portrait/generate")
      .send({ userId: USER_ID })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(generatePortrait).toHaveBeenCalledTimes(1);
    // Fresh generation → not a cache hit
    expect(res.body.cached).toBe(false);
    expect(res.body.text).toBe(NEW_TEXT);
  });

  it("calls the LLM when the existing portrait has a different seeds_hash", async () => {
    const STALE_PORTRAIT = {
      ...mockCachedPortrait,
      seedsHash: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    vi.mocked(generatePortrait).mockResolvedValue("Fresh portrait text.");

    const dbMock = db as unknown as DbMock;
    const updatedPortrait = { ...STALE_PORTRAIT, id: 12, seedsHash: SEEDS_HASH, version: 2 };

    dbMock.select
      .mockReturnValueOnce(buildSelectChain([mockSeed]))
      .mockReturnValueOnce(buildSelectChain([]))
      .mockReturnValueOnce(buildSelectChain([]))
      .mockReturnValueOnce(buildSelectChain([{ cnt: RATING_COUNT }]))
      .mockReturnValueOnce(buildSelectChain([STALE_PORTRAIT]))
      .mockReturnValueOnce(buildSelectChain([updatedPortrait]));

    const insertChain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
      catch: (fn: (e: unknown) => unknown) => Promise.resolve(undefined).catch(fn),
      values: vi.fn(),
      returning: vi.fn().mockResolvedValue([updatedPortrait]),
    };
    (insertChain.values as ViFn).mockReturnValue(insertChain as never);
    dbMock.insert.mockReturnValue(insertChain as never);

    const res = await request(makeApp())
      .post("/portrait/generate")
      .send({ userId: USER_ID })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    // Seeds have changed → LLM must be called
    expect(generatePortrait).toHaveBeenCalledTimes(1);
    expect(res.body.cached).toBe(false);
  });
});
