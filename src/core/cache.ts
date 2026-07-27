import { tryGetDb } from './db.js';
import { shortHash } from './text.js';

/**
 * Persistent TTL cache.
 *
 * Agents loop. An agent researching a topic will happily call the same SERP
 * endpoint eleven times in one reasoning chain, and with a metered provider
 * that is real money. Caching is therefore a correctness feature here, not an
 * optimisation — and it survives process restarts because agent sessions don't.
 */

export interface CacheEntry<T> {
  value: T;
  source: string | null;
  age_seconds: number;
}

export function cacheKey(namespace: string, parts: Record<string, unknown>): string {
  const stable = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${JSON.stringify(parts[k])}`)
    .join('&');
  return `${namespace}:${shortHash(stable)}`;
}

export function cacheGet<T>(key: string): CacheEntry<T> | null {
  const db = tryGetDb();
  if (!db) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = db
    .prepare('SELECT value, source, created_at FROM cache WHERE key = ? AND expires_at > ?')
    .get(key, now) as { value: string; source: string | null; created_at: number } | undefined;
  if (!row) return null;
  try {
    return {
      value: JSON.parse(row.value) as T,
      source: row.source,
      age_seconds: now - row.created_at,
    };
  } catch {
    // Corrupt entry: drop it rather than poisoning every future read.
    db.prepare('DELETE FROM cache WHERE key = ?').run(key);
    return null;
  }
}

export function cacheSet(key: string, value: unknown, ttlSeconds: number, source?: string): void {
  const db = tryGetDb();
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  db
    .prepare(
      'INSERT INTO cache (key, value, source, created_at, expires_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, ' +
        'created_at=excluded.created_at, expires_at=excluded.expires_at',
    )
    .run(key, JSON.stringify(value), source ?? null, now, now + ttlSeconds);
}

/** Read-through cache. `fresh` is only invoked on a miss. */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fresh: () => Promise<T>,
  opts: { source?: string; bypass?: boolean } = {},
): Promise<{ value: T; cached: boolean; age_seconds: number }> {
  if (!opts.bypass) {
    const hit = cacheGet<T>(key);
    if (hit) return { value: hit.value, cached: true, age_seconds: hit.age_seconds };
  }
  const value = await fresh();
  cacheSet(key, value, ttlSeconds, opts.source);
  return { value, cached: false, age_seconds: 0 };
}

export function cachePurgeExpired(): number {
  const db = tryGetDb();
  if (!db) return 0;
  const now = Math.floor(Date.now() / 1000);
  const res = db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(now);
  return Number(res.changes);
}

export function cacheClear(namespace?: string): number {
  const db = tryGetDb();
  if (!db) return 0;
  const res = namespace
    ? db.prepare('DELETE FROM cache WHERE key LIKE ?').run(`${namespace}:%`)
    : db.prepare('DELETE FROM cache').run();
  return Number(res.changes);
}

/** Sensible TTLs by data volatility. Exported so tools stay consistent. */
export const TTL = {
  /** SERPs move daily; a few hours of staleness is acceptable and saves a lot of credits. */
  serp: 6 * 3600,
  /** Volume/CPC come from monthly aggregates upstream — no point refetching often. */
  keyword_metrics: 7 * 24 * 3600,
  /** Autocomplete is cheap but rate-limited; a day is plenty. */
  suggest: 24 * 3600,
  /** A fetched page, for repeated on-page analysis within a session. */
  page: 3600,
  /** Backlink profiles update slowly upstream. */
  backlinks: 3 * 24 * 3600,
  /** Search Console data has a ~2 day lag anyway. */
  gsc: 12 * 3600,
  /** robots.txt — respect that it can change, but don't refetch per URL. */
  robots: 3600,
} as const;
