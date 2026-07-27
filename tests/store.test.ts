import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../src/core/db.js';
import {
  saveCrawl,
  listCrawls,
  latestCrawlId,
  getCrawlPages,
  getCrawlIssues,
  upsertProject,
  getProject,
  saveKeywords,
  getKeywords,
  saveRanks,
  getRankChanges,
  getRankHistory,
  rankDates,
} from '../src/store/index.js';
import { diffCrawls, diffToActions, diffRanks } from '../src/store/diff.js';
import { runAudit } from '../src/crawl/audit.js';
import { cacheSet, cacheGet, cacheKey, cacheClear, cachePurgeExpired } from '../src/core/cache.js';
import { spill } from '../src/core/envelope.js';
import { configureBudget, reserve, canSpend, budgetStatus, record, usageSummary } from '../src/core/budget.js';
import { toKeywords } from '../src/keywords/cluster.js';
import type { PageData } from '../src/core/types.js';
import type { CrawlResult } from '../src/crawl/crawler.js';
import { SeoAgentError } from '../src/core/errors.js';
import { partitionResults } from '../src/core/http.js';
import { normalizeError } from '../src/core/errors.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-agent-test-'));
  openDb(join(dir, 'test.db'));
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function page(url: string, overrides: Partial<PageData> = {}): PageData {
  return {
    url,
    final_url: url,
    status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    bytes: 10_000,
    fetch_ms: 100,
    title: `Title for ${url}`,
    meta_description: 'A meta description that is long enough to be considered reasonable by the audit rules here.',
    meta_robots: null,
    canonical: url,
    lang: 'en',
    headings: [{ level: 1, text: 'H' }],
    h1: ['H'],
    text: 'content '.repeat(400),
    word_count: 400,
    links: [],
    images: [],
    jsonld: [],
    social: {},
    hreflang: [],
    depth: 0,
    ...overrides,
  };
}

function crawlOf(pages: PageData[]): CrawlResult {
  return {
    site: 'store-test.com',
    origin: 'https://store-test.com',
    pages,
    queued_not_crawled: [],
    orphans: [],
    sitemap_urls: [],
    robots: { exists: true, blocked_count: 0, sitemaps: [], crawl_delay: null },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    errors: [],
    stopped_reason: 'complete',
  };
}

describe('crawl persistence', () => {
  it('round-trips pages and issues', () => {
    const c = crawlOf([page('https://store-test.com/a'), page('https://store-test.com/b')]);
    const saved = saveCrawl(c, runAudit(c));
    expect(saved.pages_saved).toBe(2);

    const readBack = getCrawlPages(saved.crawl_id);
    expect(readBack).toHaveLength(2);
    expect(readBack.map((p) => p.url).sort()).toEqual([
      'https://store-test.com/a',
      'https://store-test.com/b',
    ]);
    // The full PageData blob survives the round trip.
    expect(readBack[0]?.word_count).toBe(400);
  });

  it('finds the latest crawl for a site, tolerating URL vs hostname input', () => {
    const c = crawlOf([page('https://store-test.com/c')]);
    const saved = saveCrawl(c, runAudit(c));
    expect(latestCrawlId('store-test.com')).toBe(saved.crawl_id);
    expect(latestCrawlId('https://store-test.com/')).toBe(saved.crawl_id);
  });

  it('lists crawls newest first', () => {
    const list = listCrawls('store-test.com', 10);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(new Date(list[0]!.started_at).getTime()).toBeGreaterThanOrEqual(
      new Date(list[1]!.started_at).getTime(),
    );
  });

  it('filters stored issues by severity and rule', () => {
    const c = crawlOf([page('https://store-test.com/d', { title: null })]);
    const saved = saveCrawl(c, runAudit(c));
    expect(getCrawlIssues(saved.crawl_id, 'error').length).toBeGreaterThan(0);
    expect(getCrawlIssues(saved.crawl_id, undefined, 'title.missing')).toHaveLength(1);
    expect(getCrawlIssues(saved.crawl_id, undefined, 'nonexistent.rule')).toHaveLength(0);
  });
});

describe('diffCrawls', () => {
  it('reports added pages, removed pages, and resolved issues', () => {
    const before = crawlOf([
      page('https://d.com/a', { title: null }),
      page('https://d.com/gone'),
    ]);
    before.site = 'd.com';
    const beforeId = saveCrawl(before, runAudit(before)).crawl_id;

    const after = crawlOf([
      page('https://d.com/a', { title: 'Now It Has A Proper Title Here' }),
      page('https://d.com/new'),
    ]);
    after.site = 'd.com';
    const afterId = saveCrawl(after, runAudit(after)).crawl_id;

    const diff = diffCrawls(beforeId, afterId);
    expect(diff.pages.added).toContain('https://d.com/new');
    expect(diff.pages.removed).toContain('https://d.com/gone');
    // The missing title was fixed, so it must appear as resolved.
    expect(diff.issues.resolved.some((i) => i.rule === 'title.missing')).toBe(true);
  });

  it('detects a page becoming non-indexable and raises a critical action', () => {
    const before = crawlOf([page('https://e.com/x')]);
    before.site = 'e.com';
    const beforeId = saveCrawl(before, runAudit(before)).crawl_id;

    const after = crawlOf([page('https://e.com/x', { meta_robots: 'noindex' })]);
    after.site = 'e.com';
    const afterId = saveCrawl(after, runAudit(after)).crawl_id;

    const diff = diffCrawls(beforeId, afterId);
    const deindexed = diff.changed_pages.find((p) => p.url === 'https://e.com/x');
    expect(deindexed?.changes.some((c) => c.field === 'indexable')).toBe(true);

    const actions = diffToActions(diff);
    const critical = actions.find((a) => a.id === 'diff.deindexed');
    expect(critical?.priority).toBe('critical');
  });

  it('detects a changed title and a substantial word-count change', () => {
    const before = crawlOf([page('https://f.com/x', { title: 'Old Title Here', word_count: 400 })]);
    before.site = 'f.com';
    const b = saveCrawl(before, runAudit(before)).crawl_id;

    const after = crawlOf([
      page('https://f.com/x', { title: 'Brand New Title Here', text: 'content '.repeat(900), word_count: 900 }),
    ]);
    after.site = 'f.com';
    const a = saveCrawl(after, runAudit(after)).crawl_id;

    const changes = diffCrawls(b, a).changed_pages[0]?.changes.map((c) => c.field) ?? [];
    expect(changes).toContain('title');
    expect(changes).toContain('word_count');
  });

  it('reports no changes between two identical crawls', () => {
    const c = crawlOf([page('https://g.com/x')]);
    c.site = 'g.com';
    const one = saveCrawl(c, runAudit(c)).crawl_id;
    const two = saveCrawl(c, runAudit(c)).crawl_id;
    const diff = diffCrawls(one, two);
    expect(diff.pages.added).toHaveLength(0);
    expect(diff.pages.removed).toHaveLength(0);
    expect(diff.issues.new).toHaveLength(0);
    expect(diff.changed_pages).toHaveLength(0);
  });

  it('throws a clear error for a missing crawl id', () => {
    // Assert the contract, not the wording: a bad id is the caller's argument
    // problem, so it must be INVALID_INPUT with a remedy that names the tool
    // for looking ids up. Thrown as a plain Error it became INTERNAL, whose
    // remedy tells the agent it hit a bug in seo-agent and should report it.
    let thrown: unknown;
    try {
      diffCrawls(999_999, 999_998);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeoAgentError);
    const err = thrown as SeoAgentError;
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/999999|does not exist/i);
    expect(err.remedy).toMatch(/seo_crawl_history/);
  });
});

describe('projects and keywords', () => {
  it('round-trips a project', () => {
    upsertProject({
      name: 'acme',
      site: 'https://acme.com',
      competitors: ['rival.com'],
      locale: 'en-GB',
      location: 'United Kingdom',
      description: 'Test',
    });
    const p = getProject('acme');
    expect(p?.competitors).toEqual(['rival.com']);
    expect(p?.location).toBe('United Kingdom');
  });

  it('updates a project in place rather than duplicating it', () => {
    upsertProject({ name: 'acme', site: 'https://acme.com', competitors: ['a.com', 'b.com'], locale: 'en-US', location: 'United States', description: null });
    expect(getProject('acme')?.competitors).toHaveLength(2);
  });

  it('saves keywords and never lets a cheap pass erase paid metrics', () => {
    saveKeywords('acme', toKeywords([{ keyword: 'crm software', volume: 5000, cpc: 3.5, difficulty: 60, intent: 'commercial' }]));
    expect(getKeywords('acme')[0]?.volume).toBe(5000);

    // A later discovery pass has no volume data; COALESCE must preserve the old value.
    saveKeywords('acme', toKeywords([{ keyword: 'crm software', volume: null, cpc: null, intent: 'commercial' }]));
    const after = getKeywords('acme')[0];
    expect(after?.volume).toBe(5000);
    expect(after?.cpc).toBe(3.5);
  });
});

describe('rank tracking', () => {
  it('computes movement against the previous snapshot with the right sign', () => {
    saveRanks([
      { project: 'ranks', keyword: 'improving', position: 20, url: '/a', source: 'test', checked_at: '2026-01-01T00:00:00Z' },
      { project: 'ranks', keyword: 'declining', position: 4, url: '/b', source: 'test', checked_at: '2026-01-01T00:00:00Z' },
    ]);
    saveRanks([
      { project: 'ranks', keyword: 'improving', position: 8, url: '/a', source: 'test', checked_at: '2026-01-08T00:00:00Z' },
      { project: 'ranks', keyword: 'declining', position: 15, url: '/b', source: 'test', checked_at: '2026-01-08T00:00:00Z' },
    ]);

    const changes = getRankChanges('ranks');
    const improving = changes.find((c) => c.keyword === 'improving');
    const declining = changes.find((c) => c.keyword === 'declining');

    // Moving 20 -> 8 is an improvement, so change must be positive.
    expect(improving?.position).toBe(8);
    expect(improving?.change).toBe(12);
    // Moving 4 -> 15 is a decline, so change must be negative.
    expect(declining?.change).toBe(-11);
  });

  it('returns null change for a keyword with only one snapshot', () => {
    saveRanks([{ project: 'ranks', keyword: 'brand new', position: 5, url: '/c', source: 'test' }]);
    expect(getRankChanges('ranks').find((c) => c.keyword === 'brand new')?.change).toBeNull();
  });

  it('keeps full history newest-first', () => {
    const history = getRankHistory('ranks', 'improving');
    expect(history).toHaveLength(2);
    expect(history[0]?.position).toBe(8);
  });

  it('lists available snapshot dates', () => {
    const dates = rankDates('ranks');
    expect(dates).toContain('2026-01-01');
    expect(dates).toContain('2026-01-08');
  });

  it('diffs two specific dates', () => {
    const rows = diffRanks('ranks', '2026-01-01', '2026-01-08');
    const improving = rows.find((r) => r.keyword === 'improving');
    expect(improving?.before).toBe(20);
    expect(improving?.after).toBe(8);
    expect(improving?.change).toBe(12);
  });
});

describe('cache', () => {
  it('stores and retrieves a value', () => {
    const k = cacheKey('test', { a: 1 });
    cacheSet(k, { hello: 'world' }, 60);
    expect(cacheGet<{ hello: string }>(k)?.value.hello).toBe('world');
  });

  it('produces the same key regardless of argument order', () => {
    expect(cacheKey('t', { a: 1, b: 2 })).toBe(cacheKey('t', { b: 2, a: 1 }));
  });

  it('produces different keys for different values', () => {
    expect(cacheKey('t', { a: 1 })).not.toBe(cacheKey('t', { a: 2 }));
  });

  it('treats an expired entry as absent', () => {
    const k = cacheKey('test', { expired: true });
    cacheSet(k, 'stale', -10);
    expect(cacheGet(k)).toBeNull();
  });

  it('purges expired entries and clears by namespace', () => {
    cacheSet(cacheKey('purgeme', { x: 1 }), 'v', -5);
    expect(cachePurgeExpired()).toBeGreaterThanOrEqual(1);
    cacheSet(cacheKey('ns1', { x: 1 }), 'v', 60);
    cacheSet(cacheKey('ns2', { x: 1 }), 'v', 60);
    expect(cacheClear('ns1')).toBe(1);
    expect(cacheGet(cacheKey('ns2', { x: 1 }))).not.toBeNull();
  });
});

describe('budget', () => {
  it('allows spend under the cap and blocks it over', () => {
    configureBudget(10);
    expect(canSpend(5)).toBe(true);
    record('p', 't', 5);
    expect(budgetStatus().spent).toBe(5);
    expect(canSpend(4)).toBe(true);
    record('p', 't', 5);
    expect(canSpend(1)).toBe(false);
    expect(() => reserve(1)).toThrow(/budget/i);
  });

  it('is unlimited when no cap is configured', () => {
    configureBudget(undefined);
    expect(budgetStatus().cap).toBeNull();
    expect(canSpend(1_000_000)).toBe(true);
    expect(() => reserve(1_000_000)).not.toThrow();
  });

  it('records usage per provider', () => {
    configureBudget(undefined);
    record('provider-x', 'tool', 3);
    expect(usageSummary('2000-01-01T00:00:00Z').some((u) => u.provider === 'provider-x')).toBe(true);
  });
});


describe('diffCrawls new-issue detection', () => {
  it('reports an issue that appeared since the baseline', () => {
    // The suite previously only asserted on `resolved` and `changed_pages`, so
    // `issues.new` could be hardcoded to [] with everything still green — and
    // regressions are the whole point of diffing.
    const before = crawlOf([page('https://newissue.com/a')]);
    before.site = 'newissue.com';
    const beforeId = saveCrawl(before, runAudit(before)).crawl_id;

    const after = crawlOf([page('https://newissue.com/a', { title: null })]);
    after.site = 'newissue.com';
    const afterId = saveCrawl(after, runAudit(after)).crawl_id;

    const diff = diffCrawls(beforeId, afterId);
    expect(diff.issues.new.length).toBeGreaterThan(0);
    expect(diff.issues.new.some((i) => i.rule === 'title.missing')).toBe(true);
    expect(diff.issues.count_after).toBeGreaterThan(diff.issues.count_before);
    // Errors must sort first, so a truncated list still shows the worst.
    expect(diff.issues.new[0]?.severity).toBe('error');
  });

  it('surfaces a regression as a critical action', () => {
    const before = crawlOf([page('https://regress.com/a')]);
    before.site = 'regress.com';
    const b = saveCrawl(before, runAudit(before)).crawl_id;
    const after = crawlOf([page('https://regress.com/a', { title: null })]);
    after.site = 'regress.com';
    const a = saveCrawl(after, runAudit(after)).crawl_id;

    const actions = diffToActions(diffCrawls(b, a));
    const regression = actions.find((x) => x.id === 'diff.new_errors');
    expect(regression?.priority).toBe('critical');
  });

  it('reports a per-rule delta so the cause of a health drop is findable', () => {
    const before = crawlOf([page('https://delta.com/a')]);
    before.site = 'delta.com';
    const b = saveCrawl(before, runAudit(before)).crawl_id;
    const after = crawlOf([page('https://delta.com/a', { title: null, meta_description: null })]);
    after.site = 'delta.com';
    const a = saveCrawl(after, runAudit(after)).crawl_id;

    const deltas = diffCrawls(b, a).issues.by_rule_delta;
    expect(deltas.some((d) => d.rule === 'title.missing' && d.delta > 0)).toBe(true);
  });
});

describe('spill (context bounding)', () => {
  it('truncates past the cap and records what was withheld', () => {
    // "A 5,000-page crawl never floods the context window" is a documented
    // guarantee; without this test the cap could be removed silently.
    const rows = Array.from({ length: 250 }, (_, i) => ({ i }));
    const out = spill('test-tool', rows, 20);
    expect(out.rows).toHaveLength(20);
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.total_available).toBe(250);
    expect(out.meta.returned).toBe(20);
    // The full set must still be reachable, not silently discarded.
    expect(typeof out.meta.artifact).toBe('string');
  });

  it('returns everything untruncated when under the cap', () => {
    const out = spill('test-tool', [{ a: 1 }, { a: 2 }], 10);
    expect(out.rows).toHaveLength(2);
    expect(out.meta.truncated).toBe(false);
    expect(out.meta.artifact).toBeUndefined();
  });

  it('preserves order and keeps the first rows, which are the ranked ones', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ i }));
    expect(spill('t', rows, 3).rows).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it('writes the withheld rows to the artifact file', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ i }));
    const out = spill('t', rows, 5);
    const written = JSON.parse(readFileSync(out.meta.artifact as string, 'utf8')) as Array<{ i: number }>;
    expect(written).toHaveLength(40);
    expect(written[39]?.i).toBe(39);
  });
});

describe('partitionResults', () => {
  const err = (msg: string) => ({ ok: false as const, error: new SeoAgentError('PROVIDER_NOT_CONFIGURED', msg, 'set a key') });
  const ok = <T,>(value: T) => ({ ok: true as const, value });

  it('throws the first real error when every task failed', () => {
    // The whole point: an empty result set from total failure must not be
    // reportable as a successful "we found nothing".
    expect(() => partitionResults([err('no serp provider'), err('no serp provider')])).toThrow(SeoAgentError);
    try {
      partitionResults([err('no serp provider')]);
    } catch (e) {
      expect((e as SeoAgentError).code).toBe('PROVIDER_NOT_CONFIGURED');
      expect((e as SeoAgentError).remedy).toBe('set a key');
    }
  });

  it('returns partial values with a warning that names the shortfall', () => {
    const r = partitionResults([ok(1), err('timeout'), ok(3)], 'SERP lookup');
    expect(r.values).toEqual([1, 3]);
    expect(r.failed).toBe(1);
    expect(r.warning).toMatch(/1 of 3 SERP lookup\(s\) failed/);
    expect(r.warning).toMatch(/timeout/);
    expect(r.warning).toMatch(/floor/);
  });

  it('reports no warning when everything succeeded', () => {
    const r = partitionResults([ok('a'), ok('b')]);
    expect(r.values).toEqual(['a', 'b']);
    expect(r.failed).toBe(0);
    expect(r.warning).toBeNull();
  });

  it('treats an empty input as an empty success, not a failure', () => {
    const r = partitionResults([]);
    expect(r.values).toEqual([]);
    expect(r.warning).toBeNull();
  });
});

describe('normalizeError network classification', () => {
  // INTERNAL means "this codebase is broken" and its remedy tells the agent to
  // report a bug. A refused connection or a DNS failure is neither, and because
  // fetchWithRetry rethrows immediately on INTERNAL, misclassifying these also
  // silently disabled retries for the most common transient failure there is.
  const fetchFail = (cause: unknown) => Object.assign(new TypeError('fetch failed'), { cause });

  it('reads the code out of an AggregateError cause, as undici reports it', () => {
    const err = fetchFail(new AggregateError([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })]));
    const norm = normalizeError(err);
    expect(norm.code).toBe('NETWORK');
    expect(norm.remedy).not.toMatch(/likely a bug/i);
    expect(norm.message).toMatch(/Connection failed/);
    // Asserting NETWORK alone is not enough: the bare "fetch failed" fallback
    // also yields NETWORK, so this test passed even with the errors[] walk
    // removed. details.cause only gets set when the code was actually extracted,
    // so it is what proves the walk ran.
    expect(norm.details).toMatchObject({ cause: 'ECONNREFUSED' });
  });

  it('reads a nested cause chain', () => {
    const err = fetchFail({ cause: { code: 'ENOTFOUND' } });
    const norm = normalizeError(err);
    expect(norm.code).toBe('NETWORK');
    // Same reasoning — prove the chain was walked, not that a fallback caught it.
    expect(norm.message).toMatch(/DNS lookup failed/);
    expect(norm.details).toMatchObject({ cause: 'ENOTFOUND' });
  });

  it('treats a bare "fetch failed" with no usable cause as NETWORK', () => {
    expect(normalizeError(new TypeError('fetch failed')).code).toBe('NETWORK');
  });

  it('maps a connect timeout to TIMEOUT', () => {
    expect(normalizeError(fetchFail({ code: 'UND_ERR_CONNECT_TIMEOUT' })).code).toBe('TIMEOUT');
    expect(normalizeError(fetchFail({ code: 'ETIMEDOUT' })).code).toBe('TIMEOUT');
  });

  it('still reports a genuine programming error as INTERNAL', () => {
    const norm = normalizeError(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(norm.code).toBe('INTERNAL');
    expect(norm.remedy).toMatch(/likely a bug/i);
  });

  it('does not loop forever on a circular cause chain', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(normalizeError(Object.assign(new Error('weird'), { cause: a })).code).toBe('INTERNAL');
  });
});

describe('configureBudget zero and malformed caps', () => {
  // A cap of 0 is the obvious way to freeze all paid calls. The original
  // `maxUnits && maxUnits > 0 ? maxUnits : Infinity` treated it as falsy and
  // granted *unlimited* spend — a safety flag doing the exact opposite of what
  // it says. Anything that is not a usable positive number must block.
  it('treats 0 as spend nothing, not as unset', () => {
    configureBudget(0);
    expect(budgetStatus().cap).toBe(0);
    expect(canSpend(1)).toBe(false);
    expect(canSpend(0)).toBe(true);
    expect(() => reserve(1)).toThrow(/budget/i);
  });

  it('clamps a negative cap to 0 rather than opening it up', () => {
    configureBudget(-5);
    expect(budgetStatus().cap).toBe(0);
    expect(() => reserve(1)).toThrow(/budget/i);
  });

  it('blocks on a malformed cap instead of defaulting to unlimited', () => {
    configureBudget(Number.NaN);
    expect(budgetStatus().cap).toBe(0);
    expect(() => reserve(1)).toThrow(/budget/i);
  });

  it('is unlimited only when the cap is genuinely unset', () => {
    configureBudget(undefined);
    expect(budgetStatus().cap).toBeNull();
    expect(canSpend(1_000_000)).toBe(true);
  });

  it('still honours an ordinary positive cap', () => {
    configureBudget(10);
    expect(canSpend(10)).toBe(true);
    expect(canSpend(11)).toBe(false);
  });
});
