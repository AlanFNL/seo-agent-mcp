import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/**
 * `node:sqlite` is loaded via `createRequire` rather than a static import.
 *
 * Node emits an ExperimentalWarning for this module during the ESM *linking*
 * phase — before any module body executes — so a static import fires the
 * warning before `core/quiet.ts` can install its filter, no matter how early
 * that filter is imported. `createRequire` defers the load to evaluation time,
 * by which point the filter is in place. The API is identical and still
 * synchronous.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/**
 * Local persistence.
 *
 * This is the feature that separates an agent-native SEO tool from a wrapper
 * around someone else's API: history. An agent that can only see "today" can
 * report. An agent that can diff today against last Tuesday can *decide*.
 * Everything crawled, ranked, or discovered is written here so the diffing
 * tools have something to diff.
 *
 * Uses `node:sqlite` (built into Node >= 22.5) so installing this package pulls
 * zero native dependencies — which matters a lot when an agent is installing it
 * unattended.
 */

let db: DatabaseSyncType | null = null;
let dbPath = '';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  name         TEXT PRIMARY KEY,
  site         TEXT NOT NULL,
  competitors  TEXT NOT NULL DEFAULT '[]',
  locale       TEXT NOT NULL DEFAULT 'en-US',
  location     TEXT NOT NULL DEFAULT 'United States',
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crawls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project        TEXT,
  site           TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  pages_crawled  INTEGER NOT NULL DEFAULT 0,
  pages_ok       INTEGER NOT NULL DEFAULT 0,
  pages_error    INTEGER NOT NULL DEFAULT 0,
  health_score   REAL,
  config         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_crawls_site ON crawls(site, started_at DESC);

CREATE TABLE IF NOT EXISTS pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id      INTEGER NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  final_url     TEXT NOT NULL,
  status        INTEGER NOT NULL,
  title         TEXT,
  meta_description TEXT,
  canonical     TEXT,
  h1            TEXT,
  word_count    INTEGER NOT NULL DEFAULT 0,
  depth         INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL DEFAULT 0,
  fetch_ms      INTEGER NOT NULL DEFAULT 0,
  simhash       TEXT,
  indexable     INTEGER NOT NULL DEFAULT 1,
  internal_links_in  INTEGER NOT NULL DEFAULT 0,
  internal_links_out INTEGER NOT NULL DEFAULT 0,
  page_rank     REAL,
  data          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_crawl ON pages(crawl_id);
CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(crawl_id, url);
CREATE INDEX IF NOT EXISTS idx_pages_simhash ON pages(crawl_id, simhash);

CREATE TABLE IF NOT EXISTS issues (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id  INTEGER NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
  rule      TEXT NOT NULL,
  severity  TEXT NOT NULL,
  url       TEXT NOT NULL,
  message   TEXT NOT NULL,
  evidence  TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_crawl ON issues(crawl_id, severity);
CREATE INDEX IF NOT EXISTS idx_issues_rule ON issues(crawl_id, rule);

CREATE TABLE IF NOT EXISTS keywords (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  volume      INTEGER,
  difficulty  REAL,
  cpc         REAL,
  intent      TEXT,
  source      TEXT NOT NULL,
  cluster     TEXT,
  opportunity REAL,
  words       INTEGER NOT NULL DEFAULT 1,
  tracked     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  UNIQUE(project, keyword)
);
CREATE INDEX IF NOT EXISTS idx_keywords_project ON keywords(project, opportunity DESC);
CREATE INDEX IF NOT EXISTS idx_keywords_cluster ON keywords(project, cluster);

CREATE TABLE IF NOT EXISTS ranks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  position    REAL,
  url         TEXT,
  clicks      INTEGER,
  impressions INTEGER,
  ctr         REAL,
  source      TEXT NOT NULL,
  location    TEXT NOT NULL DEFAULT '',
  device      TEXT NOT NULL DEFAULT 'desktop',
  checked_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ranks_lookup ON ranks(project, keyword, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ranks_date ON ranks(project, checked_at DESC);

CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  source     TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON cache(expires_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  tool       TEXT NOT NULL,
  path       TEXT NOT NULL,
  rows       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider   TEXT NOT NULL,
  tool       TEXT NOT NULL,
  units      REAL NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at DESC);
`;

export function openDb(path: string): DatabaseSyncType {
  if (db && dbPath === path) return db;
  if (db) db.close();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(SCHEMA);
  dbPath = path;
  return db;
}

export function getDb(): DatabaseSyncType {
  if (!db) throw new Error('Database not opened. Call openDb() first.');
  return db;
}

/**
 * Non-throwing accessor.
 *
 * Caching and usage logging are conveniences, not requirements — the crawler and
 * analysers must stay usable as a plain library with no store initialised. Those
 * call sites use this and quietly skip persistence when it returns null.
 */
export function tryGetDb(): DatabaseSyncType | null {
  return db;
}

export function isDbOpen(): boolean {
  return db !== null;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    dbPath = '';
  }
}

/** Run `fn` inside a transaction; rolls back on throw. */
export function transaction<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* the original error is the one worth surfacing */
    }
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * node:sqlite returns null-prototype objects, which break spread, `in`, and
 * most structural checks downstream. Rehydrate to plain objects at the boundary.
 */
export function rows<T = Record<string, unknown>>(result: unknown[]): T[] {
  return result.map((r) => ({ ...(r as object) }) as T);
}
