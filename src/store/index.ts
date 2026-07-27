import { getDb, nowIso, transaction, rows } from '../core/db.js';
import type { PageData, Issue, Keyword, Severity } from '../core/types.js';
import type { CrawlResult } from '../crawl/crawler.js';
import type { AuditReport } from '../crawl/audit.js';
import { simhash } from '../core/text.js';
import { domainOf } from '../core/url.js';

/**
 * Persistence and history.
 *
 * The diffing functions at the bottom of this file are, to my mind, the actual
 * product. An agent that can only see the current state produces reports; an
 * agent that can compare two states produces decisions ("this page lost 40% of
 * its clicks after the redesign", "these 12 issues are new since Tuesday").
 * Human tools bury this behind a date-range picker. Here it's a first-class call.
 */

export interface SaveCrawlResult {
  crawl_id: number;
  pages_saved: number;
  issues_saved: number;
}

export function saveCrawl(
  crawl: CrawlResult,
  audit: AuditReport,
  opts: { project?: string; config?: Record<string, unknown> } = {},
): SaveCrawlResult {
  const db = getDb();
  return transaction(() => {
    db.prepare(
      'INSERT INTO crawls (project, site, started_at, finished_at, pages_crawled, pages_ok, pages_error, health_score, config) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      opts.project ?? null,
      crawl.site,
      crawl.started_at,
      crawl.finished_at,
      crawl.pages.length,
      crawl.pages.filter((p) => p.status >= 200 && p.status < 400 && !p.error).length,
      crawl.pages.filter((p) => p.status >= 400 || p.error).length,
      audit.health_score,
      JSON.stringify(opts.config ?? {}),
    );
    const crawlId = Number(
      (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
    );

    // Inbound link counts are needed by nearly every later query, so compute
    // once here rather than re-deriving them from the JSON blobs each time.
    const inLinks = new Map<string, number>();
    for (const p of crawl.pages) {
      for (const l of p.links) {
        if (!l.internal || l.url === p.url) continue;
        inLinks.set(l.url, (inLinks.get(l.url) ?? 0) + 1);
      }
    }

    const insertPage = db.prepare(
      'INSERT INTO pages (crawl_id, url, final_url, status, title, meta_description, canonical, h1, ' +
        'word_count, depth, bytes, fetch_ms, simhash, indexable, internal_links_in, internal_links_out, data) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const p of crawl.pages) {
      const indexable = !(p.meta_robots && /\bnoindex\b/i.test(p.meta_robots)) && p.status >= 200 && p.status < 300;
      insertPage.run(
        crawlId,
        p.url,
        p.final_url,
        p.status,
        p.title,
        p.meta_description,
        p.canonical,
        p.h1[0] ?? null,
        p.word_count,
        p.depth,
        p.bytes,
        p.fetch_ms,
        // Only worth computing for pages with real content.
        p.word_count >= 50 ? simhash(p.text).toString() : null,
        indexable ? 1 : 0,
        inLinks.get(p.url) ?? 0,
        p.links.filter((l) => l.internal).length,
        JSON.stringify(p),
      );
    }

    const insertIssue = db.prepare(
      'INSERT INTO issues (crawl_id, rule, severity, url, message, evidence) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const i of audit.issues) {
      insertIssue.run(crawlId, i.rule, i.severity, i.url, i.message, i.evidence ? JSON.stringify(i.evidence) : null);
    }

    return { crawl_id: crawlId, pages_saved: crawl.pages.length, issues_saved: audit.issues.length };
  });
}

export interface CrawlRecord {
  id: number;
  project: string | null;
  site: string;
  started_at: string;
  finished_at: string | null;
  pages_crawled: number;
  pages_ok: number;
  pages_error: number;
  health_score: number | null;
}

export function listCrawls(site?: string, limit = 20): CrawlRecord[] {
  const db = getDb();
  const result = site
    ? db
        .prepare(
          'SELECT id, project, site, started_at, finished_at, pages_crawled, pages_ok, pages_error, health_score ' +
            'FROM crawls WHERE site = ? ORDER BY started_at DESC LIMIT ?',
        )
        .all(normalizeSite(site), limit)
    : db
        .prepare(
          'SELECT id, project, site, started_at, finished_at, pages_crawled, pages_ok, pages_error, health_score ' +
            'FROM crawls ORDER BY started_at DESC LIMIT ?',
        )
        .all(limit);
  return rows<CrawlRecord>(result);
}

export function latestCrawlId(site: string): number | null {
  const row = getDb()
    .prepare('SELECT id FROM crawls WHERE site = ? ORDER BY started_at DESC LIMIT 1')
    .get(normalizeSite(site)) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

/** Accept "example.com", "https://www.example.com/" or "www.example.com" interchangeably. */
function normalizeSite(site: string): string {
  const d = domainOf(site);
  const db = getDb();
  // Crawls are stored under the hostname actually crawled (which may include
  // "www."), so resolve the caller's looser input to a stored value.
  const exact = db.prepare('SELECT site FROM crawls WHERE site = ? LIMIT 1').get(site) as { site: string } | undefined;
  if (exact) return exact.site;
  const like = db
    .prepare("SELECT site FROM crawls WHERE site = ? OR site = ? ORDER BY started_at DESC LIMIT 1")
    .get(d, `www.${d}`) as { site: string } | undefined;
  return like?.site ?? site;
}

export function getCrawlPages(crawlId: number): PageData[] {
  const result = getDb().prepare('SELECT data FROM pages WHERE crawl_id = ?').all(crawlId) as Array<{ data: string }>;
  return result.map((r) => JSON.parse(r.data) as PageData);
}

export interface StoredPageSummary {
  url: string;
  status: number;
  title: string | null;
  meta_description: string | null;
  word_count: number;
  depth: number;
  indexable: number;
  internal_links_in: number;
  simhash: string | null;
}

export function getCrawlPageSummaries(crawlId: number): StoredPageSummary[] {
  return rows<StoredPageSummary>(
    getDb()
      .prepare(
        'SELECT url, status, title, meta_description, word_count, depth, indexable, internal_links_in, simhash ' +
          'FROM pages WHERE crawl_id = ? ORDER BY depth, url',
      )
      .all(crawlId),
  );
}

export function getCrawlIssues(crawlId: number, severity?: Severity, rule?: string): Issue[] {
  const db = getDb();
  let sql = 'SELECT rule, severity, url, message, evidence FROM issues WHERE crawl_id = ?';
  const params: unknown[] = [crawlId];
  if (severity) {
    sql += ' AND severity = ?';
    params.push(severity);
  }
  if (rule) {
    sql += ' AND rule = ?';
    params.push(rule);
  }
  const result = db.prepare(sql).all(...(params as never[])) as Array<{
    rule: string;
    severity: Severity;
    url: string;
    message: string;
    evidence: string | null;
  }>;
  return result.map((r) => ({
    rule: r.rule,
    severity: r.severity,
    url: r.url,
    message: r.message,
    ...(r.evidence ? { evidence: JSON.parse(r.evidence) as Record<string, unknown> } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface Project {
  name: string;
  site: string;
  competitors: string[];
  locale: string;
  location: string;
  description: string | null;
}

export function upsertProject(p: Project): void {
  getDb()
    .prepare(
      'INSERT INTO projects (name, site, competitors, locale, location, description, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(name) DO UPDATE SET site=excluded.site, competitors=excluded.competitors, ' +
        'locale=excluded.locale, location=excluded.location, description=excluded.description, updated_at=excluded.updated_at',
    )
    .run(p.name, p.site, JSON.stringify(p.competitors), p.locale, p.location, p.description, nowIso(), nowIso());
}

export function getProject(name: string): Project | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE name = ?').get(name) as
    | { name: string; site: string; competitors: string; locale: string; location: string; description: string | null }
    | undefined;
  if (!row) return null;
  return {
    name: row.name,
    site: row.site,
    competitors: JSON.parse(row.competitors) as string[],
    locale: row.locale,
    location: row.location,
    description: row.description,
  };
}

export function listProjects(): Project[] {
  const result = getDb().prepare('SELECT * FROM projects ORDER BY name').all() as Array<{
    name: string;
    site: string;
    competitors: string;
    locale: string;
    location: string;
    description: string | null;
  }>;
  return result.map((r) => ({
    name: r.name,
    site: r.site,
    competitors: JSON.parse(r.competitors) as string[],
    locale: r.locale,
    location: r.location,
    description: r.description,
  }));
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

export function saveKeywords(project: string, keywords: Keyword[]): number {
  const db = getDb();
  return transaction(() => {
    const stmt = db.prepare(
      'INSERT INTO keywords (project, keyword, volume, difficulty, cpc, intent, source, cluster, opportunity, words, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(project, keyword) DO UPDATE SET ' +
        // COALESCE so a later cheap pass (no volume data) can't erase metrics a
        // previous enriched pass already paid a provider for.
        'volume=COALESCE(excluded.volume, keywords.volume), ' +
        'difficulty=COALESCE(excluded.difficulty, keywords.difficulty), ' +
        'cpc=COALESCE(excluded.cpc, keywords.cpc), ' +
        'intent=excluded.intent, cluster=COALESCE(excluded.cluster, keywords.cluster), ' +
        'opportunity=COALESCE(excluded.opportunity, keywords.opportunity), updated_at=excluded.updated_at',
    );
    let n = 0;
    for (const k of keywords) {
      stmt.run(
        project,
        k.keyword,
        k.volume,
        k.difficulty,
        k.cpc,
        k.intent,
        k.source,
        k.cluster ?? null,
        k.opportunity,
        k.words,
        nowIso(),
      );
      n++;
    }
    return n;
  });
}

export function getKeywords(project: string, opts: { limit?: number; cluster?: string; tracked?: boolean } = {}): Keyword[] {
  const db = getDb();
  let sql = 'SELECT * FROM keywords WHERE project = ?';
  const params: unknown[] = [project];
  if (opts.cluster) {
    sql += ' AND cluster = ?';
    params.push(opts.cluster);
  }
  if (opts.tracked) sql += ' AND tracked = 1';
  sql += ' ORDER BY opportunity DESC NULLS LAST, volume DESC NULLS LAST LIMIT ?';
  params.push(opts.limit ?? 500);
  const result = db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  return result.map((r) => ({
    keyword: String(r['keyword']),
    volume: r['volume'] as number | null,
    difficulty: r['difficulty'] as number | null,
    cpc: r['cpc'] as number | null,
    intent: (r['intent'] as Keyword['intent']) ?? 'informational',
    source: String(r['source'] ?? 'stored'),
    words: Number(r['words'] ?? 1),
    opportunity: r['opportunity'] as number | null,
    ...(r['cluster'] ? { cluster: String(r['cluster']) } : {}),
  }));
}

export function setTracked(project: string, keywords: string[], tracked: boolean): number {
  const db = getDb();
  return transaction(() => {
    const stmt = db.prepare('UPDATE keywords SET tracked = ? WHERE project = ? AND keyword = ?');
    let n = 0;
    for (const k of keywords) {
      const res = stmt.run(tracked ? 1 : 0, project, k.toLowerCase());
      n += Number(res.changes);
    }
    return n;
  });
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export interface RankSnapshot {
  project: string;
  keyword: string;
  position: number | null;
  url: string | null;
  clicks?: number | null;
  impressions?: number | null;
  ctr?: number | null;
  source: string;
  location?: string;
  device?: string;
  checked_at?: string;
}

export function saveRanks(snapshots: RankSnapshot[]): number {
  const db = getDb();
  return transaction(() => {
    const stmt = db.prepare(
      'INSERT INTO ranks (project, keyword, position, url, clicks, impressions, ctr, source, location, device, checked_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let n = 0;
    for (const s of snapshots) {
      stmt.run(
        s.project,
        s.keyword.toLowerCase(),
        s.position,
        s.url,
        s.clicks ?? null,
        s.impressions ?? null,
        s.ctr ?? null,
        s.source,
        s.location ?? '',
        s.device ?? 'desktop',
        s.checked_at ?? nowIso(),
      );
      n++;
    }
    return n;
  });
}

export interface RankHistoryPoint {
  checked_at: string;
  position: number | null;
  url: string | null;
  clicks: number | null;
  impressions: number | null;
}

export function getRankHistory(project: string, keyword: string, limit = 60): RankHistoryPoint[] {
  return rows<RankHistoryPoint>(
    getDb()
      .prepare(
        'SELECT checked_at, position, url, clicks, impressions FROM ranks ' +
          'WHERE project = ? AND keyword = ? ORDER BY checked_at DESC LIMIT ?',
      )
      .all(project, keyword.toLowerCase(), limit),
  );
}

/**
 * Latest position per keyword, plus the change since the most recent earlier
 * snapshot. This is the "how are we doing" query, and it's the one an agent will
 * call most, so it's a single SQL round trip rather than N history lookups.
 */
export interface RankChange {
  keyword: string;
  position: number | null;
  previous_position: number | null;
  /** Positive = improved (moved toward #1). Null when there's no prior data. */
  change: number | null;
  url: string | null;
  clicks: number | null;
  impressions: number | null;
  checked_at: string;
  previous_checked_at: string | null;
}

export function getRankChanges(project: string, opts: { limit?: number } = {}): RankChange[] {
  const db = getDb();
  const result = db
    .prepare(
      `WITH ranked AS (
         SELECT keyword, position, url, clicks, impressions, checked_at,
                ROW_NUMBER() OVER (PARTITION BY keyword ORDER BY checked_at DESC) AS rn
         FROM ranks WHERE project = ?
       )
       SELECT c.keyword, c.position, c.url, c.clicks, c.impressions, c.checked_at,
              p.position AS previous_position, p.checked_at AS previous_checked_at
       FROM ranked c
       LEFT JOIN ranked p ON p.keyword = c.keyword AND p.rn = 2
       WHERE c.rn = 1
       ORDER BY c.impressions DESC NULLS LAST, c.position ASC NULLS LAST
       LIMIT ?`,
    )
    .all(project, opts.limit ?? 500) as Array<Record<string, unknown>>;

  return result.map((r) => {
    const position = r['position'] as number | null;
    const previous = r['previous_position'] as number | null;
    return {
      keyword: String(r['keyword']),
      position,
      previous_position: previous,
      // Improving means the number gets smaller, so invert for readability.
      change: position !== null && previous !== null ? Math.round((previous - position) * 10) / 10 : null,
      url: r['url'] as string | null,
      clicks: r['clicks'] as number | null,
      impressions: r['impressions'] as number | null,
      checked_at: String(r['checked_at']),
      previous_checked_at: (r['previous_checked_at'] as string | null) ?? null,
    };
  });
}

/** Distinct snapshot dates available, newest first. Lets an agent pick a baseline. */
export function rankDates(project: string, limit = 30): string[] {
  const result = getDb()
    .prepare('SELECT DISTINCT substr(checked_at, 1, 10) AS d FROM ranks WHERE project = ? ORDER BY d DESC LIMIT ?')
    .all(project, limit) as Array<{ d: string }>;
  return result.map((r) => r.d);
}
