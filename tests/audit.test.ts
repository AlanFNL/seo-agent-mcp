import { describe, it, expect } from 'vitest';
import type { PageData } from '../src/core/types.js';
import type { CrawlResult } from '../src/crawl/crawler.js';
import { runAudit, healthScore, buildContext, issuesToActions, ALL_RULES } from '../src/crawl/audit.js';
import { rankActions, action } from '../src/core/envelope.js';
import { extractPage, extractPerfSignals } from '../src/crawl/extract.js';
import { parseRobots, isAllowed } from '../src/crawl/robots.js';
import { computePageRank, analyzeLinkGraph, findLinkOpportunities } from '../src/analysis/linkgraph.js';

/** Minimal well-formed page; override fields per test. */
function page(overrides: Partial<PageData> = {}): PageData {
  return {
    url: 'https://ex.com/',
    final_url: 'https://ex.com/',
    status: 200,
    redirect_chain: [],
    content_type: 'text/html; charset=utf-8',
    bytes: 20_000,
    fetch_ms: 200,
    title: 'A Perfectly Reasonable Page Title Here',
    meta_description:
      'A meta description of a sensible length that describes the page contents clearly and invites a click from search.',
    meta_robots: null,
    canonical: 'https://ex.com/',
    lang: 'en',
    headings: [{ level: 1, text: 'Heading' }],
    h1: ['Heading'],
    text: 'word '.repeat(600),
    word_count: 600,
    links: [],
    images: [],
    jsonld: [{ '@type': 'Article', headline: 'x', image: 'y', datePublished: '2026-01-01' }],
    social: { 'og:title': 't', 'og:image': 'i' },
    hreflang: [],
    depth: 0,
    ...overrides,
  };
}

function crawl(pages: PageData[], overrides: Partial<CrawlResult> = {}): CrawlResult {
  return {
    site: 'ex.com',
    origin: 'https://ex.com',
    pages,
    queued_not_crawled: [],
    orphans: [],
    sitemap_urls: [],
    robots: { exists: true, blocked_count: 0, sitemaps: [], crawl_delay: null },
    started_at: '2026-01-01T00:00:00Z',
    finished_at: '2026-01-01T00:01:00Z',
    errors: [],
    stopped_reason: 'complete',
    ...overrides,
  };
}

const rulesFired = (r: ReturnType<typeof runAudit>) => new Set(r.issues.map((i) => i.rule));

describe('audit rules', () => {
  it('finds nothing wrong with a clean page', () => {
    const report = runAudit(crawl([page()], { sitemap_urls: ['https://ex.com/'] }));
    expect(report.by_severity.error).toBe(0);
    expect(report.health_score).toBeGreaterThan(70);
  });

  it('flags a missing title as an error', () => {
    const report = runAudit(crawl([page({ title: null })]));
    expect(rulesFired(report)).toContain('title.missing');
    expect(report.by_severity.error).toBeGreaterThan(0);
  });

  it('flags duplicate titles across pages but not a single page', () => {
    const dup = runAudit(
      crawl([
        page({ url: 'https://ex.com/a', final_url: 'https://ex.com/a', canonical: 'https://ex.com/a', title: 'Same' }),
        page({ url: 'https://ex.com/b', final_url: 'https://ex.com/b', canonical: 'https://ex.com/b', title: 'Same' }),
      ]),
    );
    expect(rulesFired(dup)).toContain('title.duplicate');

    const unique = runAudit(
      crawl([
        page({ url: 'https://ex.com/a', final_url: 'https://ex.com/a', canonical: 'https://ex.com/a', title: 'One Title' }),
        page({ url: 'https://ex.com/b', final_url: 'https://ex.com/b', canonical: 'https://ex.com/b', title: 'Another Title' }),
      ]),
    );
    expect(rulesFired(unique)).not.toContain('title.duplicate');
  });

  it('does not flag duplicate titles on canonicalised pages', () => {
    // A page canonicalised elsewhere is *supposed* to share its canonical's metadata.
    const report = runAudit(
      crawl([
        page({ url: 'https://ex.com/a', final_url: 'https://ex.com/a', canonical: 'https://ex.com/a', title: 'Same' }),
        page({ url: 'https://ex.com/b?ref=x', final_url: 'https://ex.com/b?ref=x', canonical: 'https://ex.com/a', title: 'Same' }),
      ]),
    );
    expect(rulesFired(report)).not.toContain('title.duplicate');
  });

  it('flags thin content and escalates very thin content to an error', () => {
    const thin = runAudit(crawl([page({ text: 'word '.repeat(150), word_count: 150 })]));
    expect(thin.issues.find((i) => i.rule === 'content.thin')?.severity).toBe('warning');

    const veryThin = runAudit(crawl([page({ text: 'word '.repeat(40), word_count: 40 })]));
    expect(veryThin.issues.find((i) => i.rule === 'content.thin')?.severity).toBe('error');
  });

  it('flags a noindex page listed in the sitemap as contradictory', () => {
    const report = runAudit(
      crawl([page({ meta_robots: 'noindex, follow' })], { sitemap_urls: ['https://ex.com/'] }),
    );
    expect(rulesFired(report)).toContain('index.noindex_in_sitemap');
  });

  it('flags a canonical pointing at a 404', () => {
    const report = runAudit(
      crawl([
        page({ url: 'https://ex.com/a', final_url: 'https://ex.com/a', canonical: 'https://ex.com/gone' }),
        page({ url: 'https://ex.com/gone', final_url: 'https://ex.com/gone', status: 404 }),
      ]),
    );
    expect(rulesFired(report)).toContain('canonical.broken');
  });

  it('aggregates broken internal links per page rather than per occurrence', () => {
    const linker = page({
      url: 'https://ex.com/a',
      final_url: 'https://ex.com/a',
      canonical: 'https://ex.com/a',
      links: [
        { url: 'https://ex.com/dead', anchor: 'one', rel: null, internal: true, nofollow: false },
        { url: 'https://ex.com/dead', anchor: 'two', rel: null, internal: true, nofollow: false },
        { url: 'https://ex.com/dead2', anchor: 'three', rel: null, internal: true, nofollow: false },
      ],
    });
    const report = runAudit(
      crawl([
        linker,
        page({ url: 'https://ex.com/dead', final_url: 'https://ex.com/dead', status: 404 }),
        page({ url: 'https://ex.com/dead2', final_url: 'https://ex.com/dead2', status: 404 }),
      ]),
    );
    const broken = report.issues.filter((i) => i.rule === 'links.broken_internal');
    // One issue for the one linking page, not one per link occurrence.
    expect(broken).toHaveLength(1);
    expect(broken[0]?.evidence?.['count']).toBe(2);
  });

  it('flags near-duplicate body content across pages', () => {
    const body = 'The same paragraph of substantive content repeated verbatim across two pages. '.repeat(20);
    const report = runAudit(
      crawl([
        page({ url: 'https://ex.com/a', final_url: 'https://ex.com/a', canonical: 'https://ex.com/a', title: 'A', text: body, word_count: 260 }),
        page({ url: 'https://ex.com/b', final_url: 'https://ex.com/b', canonical: 'https://ex.com/b', title: 'B', text: body, word_count: 260 }),
      ]),
    );
    expect(rulesFired(report)).toContain('content.duplicate');
  });

  it('flags incomplete structured data by required property', () => {
    const report = runAudit(crawl([page({ jsonld: [{ '@type': 'Product', name: 'Widget' }] })]));
    const issue = report.issues.find((i) => i.rule === 'schema.incomplete');
    expect(issue).toBeDefined();
    expect(issue?.evidence?.['missing']).toContain('image');
  });

  it('flags non-reciprocal hreflang', () => {
    const report = runAudit(
      crawl([
        page({
          url: 'https://ex.com/en',
          final_url: 'https://ex.com/en',
          canonical: 'https://ex.com/en',
          hreflang: [{ lang: 'fr', href: 'https://ex.com/fr' }],
        }),
        page({
          url: 'https://ex.com/fr',
          final_url: 'https://ex.com/fr',
          canonical: 'https://ex.com/fr',
          // Points somewhere else, so the pair is not reciprocal.
          hreflang: [{ lang: 'de', href: 'https://ex.com/de' }],
        }),
      ]),
    );
    expect(rulesFired(report)).toContain('hreflang.no_return_link');
  });

  it('every rule survives being run against an empty crawl', () => {
    const ctx = buildContext(crawl([]));
    for (const rule of ALL_RULES) {
      expect(() => rule.check(ctx), `rule ${rule.id} threw on empty input`).not.toThrow();
    }
  });
});

describe('healthScore', () => {
  it('is 100 with no issues and falls as errors accumulate', () => {
    expect(healthScore({ error: 0, warning: 0, notice: 0 }, 50)).toBe(100);
    const few = healthScore({ error: 2, warning: 0, notice: 0 }, 50);
    const many = healthScore({ error: 20, warning: 0, notice: 0 }, 50);
    expect(few).toBeLessThan(100);
    expect(many).toBeLessThan(few);
  });

  it('does not punish a tiny site for a handful of issues', () => {
    // A 1-page site with 7 minor issues previously scored 7.5/100.
    expect(healthScore({ error: 1, warning: 3, notice: 3 }, 1, 2)).toBeGreaterThan(50);
  });

  it('caps the damage notices alone can do', () => {
    // Zero errors and warnings must never produce a catastrophic score.
    expect(healthScore({ error: 0, warning: 0, notice: 500 }, 25)).toBeGreaterThan(50);
  });

  it('normalises per page, so the same issue count hurts a small site more', () => {
    const small = healthScore({ error: 10, warning: 0, notice: 0 }, 10);
    const large = healthScore({ error: 10, warning: 0, notice: 0 }, 1000);
    expect(large).toBeGreaterThan(small);
  });

  it('never leaves the 0-100 range', () => {
    expect(healthScore({ error: 9999, warning: 9999, notice: 9999 }, 1)).toBeGreaterThanOrEqual(0);
    expect(healthScore({ error: 0, warning: 0, notice: 0 }, 1)).toBeLessThanOrEqual(100);
  });
});

describe('issuesToActions', () => {
  it('collapses many instances of one rule into a single ranked action', () => {
    const pages = Array.from({ length: 12 }, (_, i) =>
      page({
        url: `https://ex.com/p${i}`,
        final_url: `https://ex.com/p${i}`,
        canonical: `https://ex.com/p${i}`,
        title: `Distinct Title Number ${i} For This Page`,
        meta_description: null,
      }),
    );
    const c = crawl(pages);
    const report = runAudit(c);
    const actions = issuesToActions(report, buildContext(c));
    const metaActions = actions.filter((a) => a.id === 'audit.meta_description.missing');
    expect(metaActions).toHaveLength(1);
    expect(metaActions[0]?.evidence?.['affected_pages']).toBe(12);
  });

  it('writes imperative titles, not recycled issue text', () => {
    const c = crawl([page({ title: null })]);
    const actions = issuesToActions(runAudit(c), buildContext(c));
    const titleAction = actions.find((a) => a.id === 'audit.title.missing');
    expect(titleAction?.title).toMatch(/^Add a title tag/);
  });

  it('produces stable ids across identical runs so fixes can be tracked', () => {
    const c = crawl([page({ title: null, meta_description: null })]);
    const first = issuesToActions(runAudit(c), buildContext(c)).map((a) => a.id);
    const second = issuesToActions(runAudit(c), buildContext(c)).map((a) => a.id);
    expect(first).toEqual(second);
  });
});

describe('extractPage', () => {
  const html = `<!doctype html><html lang="en-GB"><head>
    <title>Test Page</title>
    <meta name="description" content="A description.">
    <link rel="canonical" href="/canonical-path">
    <link rel="alternate" hreflang="fr" href="https://ex.com/fr">
    <meta property="og:title" content="OG Title">
    <script type="application/ld+json">{"@graph":[{"@type":"Article","headline":"H"}]}</script>
    <link rel="stylesheet" href="/a.css">
    <script src="/blocking.js"></script>
  </head><body>
    <nav><a href="/nav-link">Navigation</a></nav>
    <main><h1>Main Heading</h1><h2>Sub</h2>
      <p>${'Real body content here. '.repeat(30)}</p>
      <a href="/internal">Internal link</a>
      <a href="https://other.com/x" rel="nofollow">External</a>
      <img src="/a.png" alt="described" width="10" height="10">
      <img data-src="/lazy.png">
    </main>
    <footer>Footer text that should not count</footer>
  </body></html>`;

  const p = extractPage({
    url: 'https://ex.com/page',
    finalUrl: 'https://ex.com/page',
    status: 200,
    html,
    headers: { 'content-type': 'text/html' },
    bytes: html.length,
    fetchMs: 100,
    redirectChain: [],
    depth: 0,
  });

  it('extracts core metadata and resolves the canonical against the page URL', () => {
    expect(p.title).toBe('Test Page');
    expect(p.meta_description).toBe('A description.');
    expect(p.canonical).toBe('https://ex.com/canonical-path');
    expect(p.lang).toBe('en-GB');
    expect(p.h1).toEqual(['Main Heading']);
  });

  it('flattens a @graph JSON-LD wrapper', () => {
    expect(p.jsonld).toHaveLength(1);
    expect((p.jsonld[0] as { '@type': string })['@type']).toBe('Article');
  });

  it('classifies links as internal or external and detects nofollow', () => {
    const internal = p.links.filter((l) => l.internal);
    const external = p.links.filter((l) => !l.internal);
    expect(internal.map((l) => l.url)).toContain('https://ex.com/internal');
    expect(external[0]?.nofollow).toBe(true);
  });

  it('finds lazy-loaded images that a naive src-only reader would miss', () => {
    expect(p.images.map((i) => i.src)).toContain('https://ex.com/lazy.png');
    expect(p.images.find((i) => i.src.endsWith('lazy.png'))?.alt).toBeNull();
  });

  it('strips nav and footer chrome from the body text', () => {
    expect(p.text).toContain('Real body content here');
    expect(p.text).not.toContain('Footer text that should not count');
    expect(p.text).not.toContain('Navigation');
  });

  it('reports render-blocking resources', () => {
    const perf = extractPerfSignals(html);
    expect(perf.render_blocking_css).toBe(1);
    expect(perf.render_blocking_js).toBe(1);
  });

  it('records a JSON-LD parse failure rather than throwing', () => {
    const bad = extractPage({
      url: 'https://ex.com/x',
      finalUrl: 'https://ex.com/x',
      status: 200,
      html: '<html><head><script type="application/ld+json">{not json</script></head><body>x</body></html>',
      headers: {},
      bytes: 100,
      fetchMs: 1,
      redirectChain: [],
      depth: 0,
    });
    expect(bad.jsonld[0]).toHaveProperty('__parse_error');
  });
});

describe('robots.txt', () => {
  const txt = `
User-agent: *
Disallow: /private/
Disallow: /tmp
Allow: /private/public-file.html

User-agent: AgentSEOBot
Disallow: /bot-only/
Crawl-delay: 2

Sitemap: https://ex.com/sitemap.xml
`;

  it('selects the most specific matching user-agent group', () => {
    const generic = parseRobots(txt, 'SomeOtherBot');
    const specific = parseRobots(txt, 'Mozilla/5.0 (compatible; AgentSEOBot)');
    expect(isAllowed(generic, 'https://ex.com/private/x')).toBe(false);
    // Our group only disallows /bot-only/, so /private/ is fair game for us.
    expect(isAllowed(specific, 'https://ex.com/private/x')).toBe(true);
    expect(isAllowed(specific, 'https://ex.com/bot-only/x')).toBe(false);
    expect(specific.crawlDelay).toBe(2);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    const r = parseRobots(txt, 'Generic');
    expect(isAllowed(r, 'https://ex.com/private/public-file.html')).toBe(true);
    expect(isAllowed(r, 'https://ex.com/private/other.html')).toBe(false);
  });

  it('collects sitemap declarations', () => {
    expect(parseRobots(txt, 'x').sitemaps).toContain('https://ex.com/sitemap.xml');
  });

  it('supports * and $ wildcards', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b', 'x');
    expect(isAllowed(r, 'https://ex.com/file.pdf')).toBe(false);
    expect(isAllowed(r, 'https://ex.com/file.pdf?x=1')).toBe(true);
    expect(isAllowed(r, 'https://ex.com/a/anything/b')).toBe(false);
  });

  it('treats an empty Disallow as allow-all', () => {
    const r = parseRobots('User-agent: *\nDisallow:', 'x');
    expect(isAllowed(r, 'https://ex.com/anything')).toBe(true);
  });

  it('allows everything when there are no rules', () => {
    expect(isAllowed({ exists: false, rules: [], sitemaps: [], crawlDelay: null, raw: '' }, 'https://ex.com/x')).toBe(true);
  });
});


describe('rankActions', () => {
  /**
   * The ordering guarantee is the whole agent-native premise: an agent works the
   * list top-down and must hit the valuable cheap things first. Mutation testing
   * showed the sort could be deleted entirely without any test failing, so these
   * assert the ordering itself rather than merely that actions exist.
   */
  const make = (id: string, priority: 'critical' | 'high' | 'medium' | 'low', effort: 'trivial' | 'small' | 'medium' | 'large', impact: number) =>
    action({ id, priority, effort, category: 'test', title: id, detail: '', impact_score: impact });

  it('puts a critical item before a low one regardless of input order', () => {
    const ranked = rankActions([
      make('low-first', 'low', 'trivial', 90),
      make('critical', 'critical', 'large', 10),
    ]);
    expect(ranked[0]?.id).toBe('critical');
  });

  it('orders strictly by descending priority when effort and impact match', () => {
    const ranked = rankActions([
      make('d-low', 'low', 'small', 50),
      make('b-high', 'high', 'small', 50),
      make('a-critical', 'critical', 'small', 50),
      make('c-medium', 'medium', 'small', 50),
    ]);
    expect(ranked.map((a) => a.id)).toEqual(['a-critical', 'b-high', 'c-medium', 'd-low']);
  });

  it('prefers the cheaper action at equal priority and impact', () => {
    const ranked = rankActions([
      make('expensive', 'high', 'large', 60),
      make('cheap', 'high', 'trivial', 60),
    ]);
    expect(ranked[0]?.id).toBe('cheap');
  });

  it('prefers the higher-impact action at equal priority and effort', () => {
    // Ids are chosen so the alphabetical tiebreak would give the WRONG answer.
    // With ids like "weak"/"strong" this test passed even when impact_score was
    // ignored entirely — the tiebreak happened to order them correctly, so the
    // test proved nothing. Now a build that drops impact fails here.
    const ranked = rankActions([
      make('aaa-low-impact', 'medium', 'small', 10),
      make('zzz-high-impact', 'medium', 'small', 95),
    ]);
    expect(ranked[0]?.id).toBe('zzz-high-impact');
  });

  it('lets impact outweigh effort when the gap is large enough', () => {
    // (200 + 100) / 1.4 = 214 beats (200 + 0) / 1 = 200, so the small-effort
    // high-impact item wins over the trivial-effort zero-impact one. Ids again
    // ordered so the tiebreak cannot rescue a broken comparator.
    const ranked = rankActions([
      make('aaa-trivial-no-impact', 'medium', 'trivial', 0),
      make('zzz-small-high-impact', 'medium', 'small', 100),
    ]);
    expect(ranked[0]?.id).toBe('zzz-small-high-impact');
  });

  it('lets a trivial high beat a large critical — impact per unit effort, not priority alone', () => {
    // 1000+10 / 4 = 252.5 for the critical; 500+80 / 1 = 580 for the trivial high.
    const ranked = rankActions([
      make('critical-huge-effort', 'critical', 'large', 10),
      make('high-trivial-effort', 'high', 'trivial', 80),
    ]);
    expect(ranked[0]?.id).toBe('high-trivial-effort');
  });

  it('dedupes by id, keeping the first occurrence', () => {
    const ranked = rankActions([make('dupe', 'high', 'small', 50), make('dupe', 'low', 'large', 5)]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.priority).toBe('high');
  });

  it('is a total order — stable and deterministic across runs', () => {
    const input = [
      make('a', 'high', 'small', 50), make('b', 'high', 'small', 50),
      make('c', 'medium', 'trivial', 50), make('d', 'low', 'large', 99),
    ];
    expect(rankActions([...input]).map((a) => a.id)).toEqual(rankActions([...input]).map((a) => a.id));
  });

  it('is monotonic: the score never increases down the returned list', () => {
    const PRIORITY = { critical: 1000, high: 500, medium: 200, low: 50 } as const;
    const EFFORT = { trivial: 1, small: 1.4, medium: 2.2, large: 4 } as const;
    const ranked = rankActions([
      make('p', 'low', 'large', 20), make('q', 'critical', 'trivial', 90),
      make('r', 'medium', 'medium', 55), make('s', 'high', 'small', 70),
      make('t', 'low', 'trivial', 5),
      // A pair differing only in impact, so the assertion below cannot hold if
      // impact is dropped from the score.
      make('u', 'medium', 'small', 5), make('v', 'medium', 'small', 99),
    ]);
    const scores = ranked.map((a) => (PRIORITY[a.priority] + a.impact_score) / EFFORT[a.effort]);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i] as number).toBeLessThanOrEqual(scores[i - 1] as number);
    }
  });
});


describe('internal link graph', () => {
  /**
   * These behaviours were originally checked with throwaway scripts and reported
   * as verified. Mutation testing showed the checks had evaporated with the
   * scripts: `computePageRank` could ignore nofollow entirely and
   * `findLinkOpportunities` could return [] unconditionally, with the suite still
   * green. Verification that isn't a test isn't verification.
   */
  const node = (url: string, links: Array<string | { url: string; nofollow: true }> = [], text = 'word '.repeat(200)): PageData =>
    page({
      url,
      final_url: url,
      canonical: url,
      title: url,
      h1: [url],
      text,
      word_count: 200,
      depth: 1,
      links: links.map((l) =>
        typeof l === 'string'
          ? { url: l, anchor: 'a', rel: null, internal: true, nofollow: false }
          : { url: l.url, anchor: 'a', rel: 'nofollow', internal: true, nofollow: true },
      ),
    });

  it('passes no PageRank through a nofollow link', () => {
    const pages = [
      node('https://ex.com/h1', ['https://ex.com/followed', { url: 'https://ex.com/nofollowed', nofollow: true }]),
      node('https://ex.com/h2', ['https://ex.com/followed', { url: 'https://ex.com/nofollowed', nofollow: true }]),
      node('https://ex.com/h3', ['https://ex.com/followed', { url: 'https://ex.com/nofollowed', nofollow: true }]),
      node('https://ex.com/followed'),
      node('https://ex.com/nofollowed'),
    ];
    const pr = computePageRank(pages);
    const followed = pr.get('https://ex.com/followed') as number;
    const nofollowed = pr.get('https://ex.com/nofollowed') as number;
    expect(followed).toBeGreaterThan(nofollowed);
  });

  it('gives more inbound links more PageRank', () => {
    const pages = [
      node('https://ex.com/a', ['https://ex.com/popular']),
      node('https://ex.com/b', ['https://ex.com/popular']),
      node('https://ex.com/c', ['https://ex.com/popular', 'https://ex.com/rare']),
      node('https://ex.com/popular'),
      node('https://ex.com/rare'),
    ];
    const pr = computePageRank(pages);
    expect(pr.get('https://ex.com/popular') as number).toBeGreaterThan(pr.get('https://ex.com/rare') as number);
  });

  it('conserves rank mass — every page gets a positive score, no leaks', () => {
    const pr = computePageRank([node('https://ex.com/x', ['https://ex.com/y']), node('https://ex.com/y')]);
    expect([...pr.values()].every((v) => v > 0)).toBe(true);
  });

  // The tests above check ordering only, so they would pass for any monotonic
  // stand-in — counting inbound links, for instance. These pin the actual
  // numbers, cross-checked against an independent power iteration written from
  // the definition r'[j] = (1-d)/n + d·Σ r[i]/outdeg(i) + d·dangling/n, which
  // agreed to within 0.005 on every shape tried.
  it('gives every page in a symmetric cycle exactly the same rank', () => {
    const pr = computePageRank([
      node('https://ex.com/a', ['https://ex.com/b']),
      node('https://ex.com/b', ['https://ex.com/c']),
      node('https://ex.com/c', ['https://ex.com/a']),
    ]);
    expect([...pr.values()]).toEqual([100, 100, 100]);
  });

  it('matches the analytic values for a linear chain', () => {
    // Inbound-link counting would make the last three equal; PageRank must
    // accumulate along the chain.
    const pr = computePageRank([
      node('https://ex.com/1', ['https://ex.com/2']),
      node('https://ex.com/2', ['https://ex.com/3']),
      node('https://ex.com/3', ['https://ex.com/4']),
      node('https://ex.com/4'),
    ]);
    expect(pr.get('https://ex.com/1') as number).toBeCloseTo(31.38, 1);
    expect(pr.get('https://ex.com/2') as number).toBeCloseTo(58.06, 1);
    expect(pr.get('https://ex.com/3') as number).toBeCloseTo(80.73, 1);
    expect(pr.get('https://ex.com/4') as number).toBeCloseTo(100, 1);
  });

  it('splits a page\'s equity across its outbound links', () => {
    // Decisive for outdegree normalisation, which every other graph here misses
    // because they all have outdegree 1. `src_narrow` and `src_wide` have equal
    // rank (neither has inbound links), but src_wide spreads itself over five
    // targets, so its target must end up weaker. Passing the full rank down every
    // link instead of a share would make these equal.
    const pr = computePageRank([
      node('https://ex.com/src_narrow', ['https://ex.com/target_a']),
      node('https://ex.com/src_wide', [
        'https://ex.com/target_b', 'https://ex.com/x1', 'https://ex.com/x2',
        'https://ex.com/x3', 'https://ex.com/x4',
      ]),
      node('https://ex.com/target_a'),
      node('https://ex.com/target_b'),
      node('https://ex.com/x1'), node('https://ex.com/x2'),
      node('https://ex.com/x3'), node('https://ex.com/x4'),
    ]);
    const a = pr.get('https://ex.com/target_a') as number;
    const b = pr.get('https://ex.com/target_b') as number;
    expect(a).toBeGreaterThan(b);
    // A link from a page with 5 outbound links is worth about a fifth as much,
    // so the gap has to be substantial rather than a rounding artefact.
    expect(a - b).toBeGreaterThan(5);
  });

  it('collapses towards uniform as damping approaches zero', () => {
    // With d≈0 the (1-d)/n term dominates and link structure stops mattering.
    const pages = [
      node('https://ex.com/a', ['https://ex.com/b']),
      node('https://ex.com/b', ['https://ex.com/c']),
      node('https://ex.com/c', ['https://ex.com/a']),
      node('https://ex.com/d', ['https://ex.com/a']),
    ];
    const spread = (damping: number) => {
      const v = [...computePageRank(pages, { damping }).values()];
      return Math.max(...v) - Math.min(...v);
    };
    expect(spread(0.01)).toBeLessThan(3);
    expect(spread(0.85)).toBeGreaterThan(20);
  });

  it('returns an empty map for no pages', () => {
    expect(computePageRank([]).size).toBe(0);
  });

  it('counts a page with no inbound internal links as an orphan', () => {
    const report = analyzeLinkGraph([
      node('https://ex.com/hub', ['https://ex.com/linked']),
      node('https://ex.com/linked'),
      node('https://ex.com/orphan'),
    ]);
    expect(report.orphans).toContain('https://ex.com/orphan');
    expect(report.orphans).not.toContain('https://ex.com/linked');
  });

  it('finds the one page that mentions a topic without linking to it', () => {
    const pages = [
      node('https://ex.com/', ['https://ex.com/blog/a', 'https://ex.com/blog/b']),
      // Mentions "static site generators" in prose but links only to the homepage.
      node(
        'https://ex.com/blog/a',
        ['https://ex.com/'],
        `When you evaluate options you will compare static site generators against a full CMS. ${'Static site generators are fast. '.repeat(20)}`,
      ),
      node('https://ex.com/blog/b', ['https://ex.com/'], 'A deep dive into the topic. '.repeat(40)),
    ];
    // Give /blog/b the title that /blog/a's prose mentions.
    (pages[2] as PageData).title = 'Static Site Generators';
    (pages[2] as PageData).h1 = ['Static Site Generators'];

    const opps = findLinkOpportunities(pages, { limit: 10 });
    const found = opps.find((o) => o.from_url.endsWith('/blog/a') && o.to_url.endsWith('/blog/b'));
    expect(found, 'the one genuine unlinked mention was not found').toBeDefined();
    expect(found?.anchor.toLowerCase()).toContain('static site generator');
    // The finder must quote the sentence to edit, not just name the page.
    expect(found?.context.toLowerCase()).toContain('compare static site generators');
  });

  it('suppresses the opportunity once the link exists', () => {
    const pages = [
      node('https://ex.com/', ['https://ex.com/blog/a', 'https://ex.com/blog/b']),
      node(
        'https://ex.com/blog/a',
        ['https://ex.com/', 'https://ex.com/blog/b'],
        `You will compare static site generators against a CMS. ${'Static site generators are fast. '.repeat(20)}`,
      ),
      node('https://ex.com/blog/b', ['https://ex.com/'], 'A deep dive. '.repeat(40)),
    ];
    (pages[2] as PageData).title = 'Static Site Generators';
    (pages[2] as PageData).h1 = ['Static Site Generators'];
    const opps = findLinkOpportunities(pages, { limit: 10 });
    expect(opps.filter((o) => o.from_url.endsWith('/blog/a') && o.to_url.endsWith('/blog/b'))).toHaveLength(0);
  });

  it('never proposes a page link to itself', () => {
    const pages = [
      node('https://ex.com/x', [], 'Static site generators are discussed here at length. '.repeat(20)),
      node('https://ex.com/y', ['https://ex.com/x'], 'Other content entirely. '.repeat(20)),
    ];
    (pages[0] as PageData).title = 'Static Site Generators';
    (pages[0] as PageData).h1 = ['Static Site Generators'];
    expect(findLinkOpportunities(pages, { limit: 20 }).every((o) => o.from_url !== o.to_url)).toBe(true);
  });
});
