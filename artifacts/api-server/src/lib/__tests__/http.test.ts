/**
 * Unit tests for httpGet() L2 (DB) cache behaviour.
 *
 * The L2 cache is the only layer that survives a server restart.  These tests
 * seed the mocked `http_cache` table, call `httpGet`, and assert that the
 * cached body is returned without making a network request.
 *
 * All external dependencies (DB, fetch) are mocked so the suite runs fully
 * in-process.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports so Vitest can hoist them.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const table = { name: "mock-http-cache-table" };
  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
    },
    httpCacheTable: table,
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

import { db, httpCacheTable } from "@workspace/db";
import { httpGet } from "../http.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ViFn = ReturnType<typeof vi.fn>;
type DbMock = { select: ViFn; insert: ViFn; delete: ViFn };

/**
 * Build a Drizzle-style select chain that resolves to `value`.
 * Supports the patterns used by l2Get:
 *   db.select().from(T).where(...).limit(n)
 */
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
    limit: vi.fn().mockReturnValue(limitPromise),
  };

  for (const key of ["from", "where", "orderBy"]) {
    (chain[key] as ViFn).mockReturnValue(chain);
  }

  return chain;
}

/**
 * Build a Drizzle-style delete chain (used by l2Get to purge expired rows).
 * db.delete(T).where(...) — the result is fire-and-forget so we just need
 * the chain to not throw.
 */
function buildDeleteChain() {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(undefined).catch(fn),
    where: vi.fn(),
  };
  (chain.where as ViFn).mockReturnValue(chain);
  return chain;
}

/**
 * Build an insert chain for l2Set:
 *   db.insert(T).values({...}).onConflictDoUpdate({...})
 */
function buildInsertChain() {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(undefined).catch(fn),
    values: vi.fn(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  (chain.values as ViFn).mockReturnValue(chain);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the global fetch mock to a spy that throws — if a test accidentally
  // triggers a real network call it will fail loudly.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("fetch should not be called for a cache hit"))
  );
});

describe("httpGet() — L2 DB cache", () => {
  it("returns the cached body from the DB without making a network request", async () => {
    const CACHE_KEY = "test:artist:radiohead";
    const CACHED_BODY = { name: "Radiohead", listeners: 5_000_000 };
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h from now

    // Seed the mock DB with a fresh cache row
    const dbMock = db as unknown as DbMock;
    dbMock.select.mockReturnValueOnce(
      buildSelectChain([{ key: CACHE_KEY, body: CACHED_BODY, expiresAt: futureDate }])
    );

    // Also stub the insert for l2Set (L1 warm-up write is fire-and-forget)
    dbMock.insert.mockReturnValue(buildInsertChain());

    const result = await httpGet<typeof CACHED_BODY>("https://ws.audioscrobbler.com/fake", {
      cacheKey: CACHE_KEY,
    });

    // The cached body is returned intact
    expect(result).toEqual(CACHED_BODY);

    // fetch must NOT have been called
    expect(fetch).not.toHaveBeenCalled();

    // The DB was queried exactly once (l2Get)
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it("skips the DB and calls fetch when the cache row is expired", async () => {
    const CACHE_KEY = "test:artist:expired";
    const NETWORK_BODY = { name: "Portishead", listeners: 2_000_000 };
    const pastDate = new Date(Date.now() - 1000); // 1 s ago — expired

    const dbMock = db as unknown as DbMock;

    // First select returns an expired row → l2Get will return null and trigger delete
    dbMock.select.mockReturnValueOnce(
      buildSelectChain([{ key: CACHE_KEY, body: { stale: true }, expiresAt: pastDate }])
    );

    // l2Set after successful fetch (select is not called again; insert is)
    dbMock.insert.mockReturnValue(buildInsertChain());
    dbMock.delete.mockReturnValue(buildDeleteChain());

    // Stub fetch to succeed with the network body
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => NETWORK_BODY,
        headers: { get: () => null },
      })
    );

    const result = await httpGet<typeof NETWORK_BODY>("https://ws.audioscrobbler.com/fake", {
      cacheKey: CACHE_KEY,
    });

    expect(result).toEqual(NETWORK_BODY);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("calls fetch when no cache key is provided", async () => {
    const NETWORK_BODY = { name: "Massive Attack" };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => NETWORK_BODY,
        headers: { get: () => null },
      })
    );

    const dbMock = db as unknown as DbMock;
    dbMock.insert.mockReturnValue(buildInsertChain());

    const result = await httpGet<typeof NETWORK_BODY>("https://ws.audioscrobbler.com/fake");

    // No cache key → DB is never consulted
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(NETWORK_BODY);
  });
});
