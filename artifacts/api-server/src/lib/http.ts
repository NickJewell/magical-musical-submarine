/**
 * Shared HTTP client with per-host throttling, response caching, and retries.
 * MusicBrainz requires ~1 req/s; we enforce that with a per-host queue.
 *
 * Cache layers:
 *   L1 — in-memory Map (process-scoped, fastest, lost on restart)
 *   L2 — Postgres http_cache table (persistent, survives restarts)
 */

import { logger } from "./logger";
import { db, httpCacheTable } from "@workspace/db";
import { eq, lt } from "drizzle-orm";

const MB_CONTACT = process.env.MB_CONTACT ?? "trails-app@example.com";
const USER_AGENT = `Trails/1.0 (${MB_CONTACT})`;

// Per-host rate limiting: track last request time
const lastRequestTime: Map<string, number> = new Map();
const HOST_DELAYS: Record<string, number> = {
  "musicbrainz.org": 1100, // 1 req/s with buffer
  "coverartarchive.org": 1100,
};

// L1: in-memory response cache (fast path, process-scoped)
const l1Cache: Map<string, { body: unknown; expiresAt: number }> = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h default

function getHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function throttle(host: string): Promise<void> {
  const delay = HOST_DELAYS[host];
  if (!delay) return;
  const last = lastRequestTime.get(host) ?? 0;
  const now = Date.now();
  const wait = delay - (now - last);
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestTime.set(host, Date.now());
}

// ---- L2 DB cache helpers ----

async function l2Get(key: string): Promise<unknown | null> {
  try {
    const rows = await db
      .select()
      .from(httpCacheTable)
      .where(eq(httpCacheTable.key, key))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt < new Date()) {
      // Expired — delete in background, don't block
      db.delete(httpCacheTable).where(eq(httpCacheTable.key, key)).catch(() => {});
      return null;
    }
    return row.body;
  } catch (err) {
    logger.warn({ err, key }, "http_cache L2 read failed — falling through to network");
    return null;
  }
}

async function l2Set(key: string, body: unknown, ttlMs: number): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + ttlMs);
    await db
      .insert(httpCacheTable)
      .values({ key, body, expiresAt })
      .onConflictDoUpdate({
        target: httpCacheTable.key,
        set: { body, expiresAt, createdAt: new Date() },
      });
  } catch (err) {
    logger.warn({ err, key }, "http_cache L2 write failed — cache miss on next restart");
  }
}

/** Purge rows that have already expired (run occasionally to keep the table small).
 *  Returns the number of rows deleted. */
export async function purgeExpiredHttpCache(): Promise<number> {
  try {
    const result = await db
      .delete(httpCacheTable)
      .where(lt(httpCacheTable.expiresAt, new Date()))
      .returning({ key: httpCacheTable.key });
    return result.length;
  } catch (err) {
    logger.warn({ err }, "Failed to purge expired http_cache rows");
    return 0;
  }
}

export interface FetchOptions {
  cacheKey?: string;
  cacheTtlMs?: number;
  retries?: number;
  /** Per-request abort timeout in milliseconds. If the fetch doesn't complete within this window, it is aborted and the attempt counts as a failure. */
  timeoutMs?: number;
}

export async function httpGet<T>(
  url: string,
  opts: FetchOptions = {}
): Promise<T> {
  const { cacheKey, cacheTtlMs = CACHE_TTL_MS, retries = 3, timeoutMs } = opts;

  // L1 check (in-memory)
  if (cacheKey) {
    const hit = l1Cache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) {
      return hit.body as T;
    }
  }

  // L2 check (DB — only on L1 miss)
  if (cacheKey) {
    const dbBody = await l2Get(cacheKey);
    if (dbBody !== null) {
      // Warm L1 so subsequent calls in this process skip DB
      l1Cache.set(cacheKey, { body: dbBody, expiresAt: Date.now() + cacheTtlMs });
      return dbBody as T;
    }
  }

  const host = getHost(url);
  await throttle(host);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      let signal: AbortSignal | undefined;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs) {
        const controller = new AbortController();
        signal = controller.signal;
        abortTimer = setTimeout(() => controller.abort(), timeoutMs);
      }

      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
          },
          signal,
        });
      } finally {
        if (abortTimer !== undefined) clearTimeout(abortTimer);
      }

      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "2", 10);
        const hasMoreAttempts = attempt + 1 < retries;
        logger.warn({ status: res.status, retryAfter, url, hasMoreAttempts }, "Rate limited");
        if (hasMoreAttempts) {
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
        } else {
          lastError = new Error(`HTTP ${res.status} rate-limited for ${url}`);
        }
        continue;
      }

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        // 4xx client errors (except 429 handled above) are not retryable — bail immediately
        if (res.status >= 400 && res.status < 500) throw err;
        lastError = err;
        logger.warn({ err, url, attempt }, "HTTP request failed");
        continue;
      }

      const body = (await res.json()) as T;

      if (cacheKey) {
        // Write to both L1 and L2
        l1Cache.set(cacheKey, { body, expiresAt: Date.now() + cacheTtlMs });
        l2Set(cacheKey, body, cacheTtlMs).catch(() => {}); // fire-and-forget
      }

      return body;
    } catch (err) {
      lastError = err as Error;
      const isTimeout =
        (err instanceof Error && err.name === "AbortError") ||
        (err instanceof Error && err.message.includes("aborted"));
      // 4xx errors (except 429 already handled above) are not transient — don't retry
      const is4xx = lastError.message.match(/HTTP 4\d\d/);
      if (is4xx) throw lastError;
      if (isTimeout) {
        logger.warn({ url, attempt, timeoutMs }, "HTTP request timed out (AbortError)");
      } else {
        logger.warn({ err, url, attempt }, "HTTP request failed");
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

export async function httpPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for POST ${url}`);
  }

  return (await res.json()) as T;
}
