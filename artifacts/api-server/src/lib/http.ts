/**
 * Shared HTTP client with per-host throttling, response caching, and retries.
 * MusicBrainz requires ~1 req/s; we enforce that with a per-host queue.
 */

import { logger } from "./logger";

const MB_CONTACT = process.env.MB_CONTACT ?? "trails-app@example.com";
const USER_AGENT = `Trails/1.0 (${MB_CONTACT})`;

// Per-host rate limiting: track last request time
const lastRequestTime: Map<string, number> = new Map();
const HOST_DELAYS: Record<string, number> = {
  "musicbrainz.org": 1100, // 1 req/s with buffer
  "coverartarchive.org": 1100,
};

// Simple in-memory response cache
const responseCache: Map<string, { body: unknown; expiresAt: number }> = new Map();
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

export interface FetchOptions {
  cacheKey?: string;
  cacheTtlMs?: number;
  retries?: number;
}

export async function httpGet<T>(
  url: string,
  opts: FetchOptions = {}
): Promise<T> {
  const { cacheKey, cacheTtlMs = CACHE_TTL_MS, retries = 3 } = opts;

  // Check cache
  if (cacheKey) {
    const cached = responseCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.body as T;
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
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });

      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "2", 10);
        logger.warn({ status: res.status, retryAfter, url }, "Rate limited, will retry");
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }

      const body = (await res.json()) as T;

      if (cacheKey) {
        responseCache.set(cacheKey, { body, expiresAt: Date.now() + cacheTtlMs });
      }

      return body;
    } catch (err) {
      lastError = err as Error;
      logger.warn({ err, url, attempt }, "HTTP request failed");
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
