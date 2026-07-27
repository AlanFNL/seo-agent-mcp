import type { PageData } from '../core/types.js';
import { httpFetch, setHostDelay } from '../core/http.js';
import { normalizeUrl, sameSite, looksLikeHtml, parseUrl, slashInsensitiveKey } from '../core/url.js';
import { SeoAgentError, normalizeError } from '../core/errors.js';
import { extractPage } from './extract.js';
import { fetchRobots, isAllowed, type RobotsTxt } from './robots.js';
import { discoverSitemaps, fetchSitemap } from './sitemap.js';

/**
 * Breadth-first site crawler.
 *
 * BFS specifically, not DFS: crawl depth correlates with how Google values a
 * page, so when we hit the page cap we want the shallow, important pages —
 * not a random deep branch of the pagination.
 */

export interface CrawlOptions {
  maxPages: number;
  concurrency: number;
  hostDelayMs: number;
  timeoutMs: number;
  userAgent: string;
  respectRobots: boolean;
  /** Also seed the frontier from sitemap.xml. Finds orphan pages links can't. */
  useSitemap?: boolean;
  /** Only crawl URLs whose path matches one of these (substring or /regex/). */
  includePatterns?: string[];
  excludePatterns?: string[];
  maxDepth?: number;
  /**
   * Follow links into other subdomains of the same registrable domain.
   *
   * Off by default. Links to a subdomain still count as internal for link
   * analysis (that's how search engines see them), but a "crawl this site" that
   * wanders from www into a v2/staging/docs subdomain burns the page budget on
   * what is effectively a different site.
   */
  includeSubdomains?: boolean;
  signal?: AbortSignal;
  onPage?: (page: PageData, crawled: number) => void;
}

export interface CrawlResult {
  site: string;
  origin: string;
  pages: PageData[];
  /** Discovered but not fetched, because of the page cap. */
  queued_not_crawled: string[];
  /** URLs in the sitemap that the crawler never reached by following links. */
  orphans: string[];
  sitemap_urls: string[];
  robots: { exists: boolean; blocked_count: number; sitemaps: string[]; crawl_delay: number | null };
  started_at: string;
  finished_at: string;
  errors: Array<{ url: string; error: string; code: string }>;
  stopped_reason: 'complete' | 'max_pages' | 'aborted';
}

export async function crawlSite(startUrl: string, opts: CrawlOptions): Promise<CrawlResult> {
  const seed = normalizeUrl(startUrl);
  if (!seed) {
    throw new SeoAgentError(
      'INVALID_INPUT',
      `Not a usable URL: ${startUrl}`,
      'Pass an absolute http(s) URL, e.g. "https://example.com".',
    );
  }
  const seedParsed = parseUrl(seed);
  if (!seedParsed) throw new SeoAgentError('INVALID_INPUT', `Cannot parse ${startUrl}`, 'Pass a valid URL.');
  const origin = seedParsed.origin;

  setHostDelay(opts.hostDelayMs);

  const startedAt = new Date().toISOString();
  const robots: RobotsTxt = opts.respectRobots
    ? await fetchRobots(origin, opts.userAgent)
    : { exists: false, rules: [], sitemaps: [], crawlDelay: null, raw: '' };

  // Honour a declared crawl-delay when it's stricter than ours.
  if (robots.crawlDelay && robots.crawlDelay * 1000 > opts.hostDelayMs) {
    setHostDelay(Math.min(10_000, robots.crawlDelay * 1000));
  }

  const include = compilePatterns(opts.includePatterns);
  const exclude = compilePatterns(opts.excludePatterns);

  // Frontier as a depth-bucketed queue keeps BFS order without an O(n) sort.
  const frontier: Array<{ url: string; depth: number }> = [{ url: seed, depth: 0 }];
  // Keyed slash-insensitively so `/docs` and `/docs/` are never both queued,
  // while the queued entry keeps whichever exact form the site actually linked.
  const seen = new Set<string>([slashInsensitiveKey(seed)]);
  /** Resolved identities we've already recorded, to drop post-redirect duplicates. */
  const resolved = new Set<string>();
  const pages: PageData[] = [];
  const errors: CrawlResult['errors'] = [];
  let blockedByRobots = 0;

  const inScope = (url: string): boolean => {
    if (!sameSite(url, seed)) return false;
    if (opts.includeSubdomains) return true;
    return parseUrl(url)?.hostname === seedParsed.hostname;
  };

  let sitemapUrls: string[] = [];
  if (opts.useSitemap !== false) {
    try {
      const smLocations = await discoverSitemaps(origin, robots.sitemaps);
      for (const loc of smLocations.slice(0, 3)) {
        const sm = await fetchSitemap(loc, { maxUrls: Math.max(opts.maxPages * 4, 2000) });
        sitemapUrls.push(...sm.entries.map((e) => e.url));
      }
      sitemapUrls = [...new Set(sitemapUrls)].filter(inScope);
      // Sitemap URLs enter at depth 1 — they are known-good but we still want
      // link-discovered shallow pages crawled first.
      for (const u of sitemapUrls) {
        const key = slashInsensitiveKey(u);
        if (!seen.has(key)) {
          seen.add(key);
          frontier.push({ url: u, depth: 1 });
        }
      }
    } catch {
      // A missing or broken sitemap is normal; keep crawling by links.
    }
  }

  const maxDepth = opts.maxDepth ?? 10;
  let stoppedReason: CrawlResult['stopped_reason'] = 'complete';
  const linkDiscovered = new Set<string>([slashInsensitiveKey(seed)]);

  // Process the frontier in depth-ordered waves so BFS holds under concurrency.
  while (frontier.length > 0) {
    if (opts.signal?.aborted) {
      stoppedReason = 'aborted';
      break;
    }
    if (pages.length >= opts.maxPages) {
      stoppedReason = 'max_pages';
      break;
    }

    const currentDepth = Math.min(...frontier.map((f) => f.depth));
    const wave = frontier.filter((f) => f.depth === currentDepth);
    for (let i = frontier.length - 1; i >= 0; i--) {
      if (frontier[i]!.depth === currentDepth) frontier.splice(i, 1);
    }

    const budget = opts.maxPages - pages.length;
    const batch = wave.slice(0, budget);
    for (const leftover of wave.slice(budget)) frontier.push(leftover);

    let cursor = 0;
    const workers = Array.from(
      { length: Math.max(1, Math.min(opts.concurrency, batch.length)) },
      async () => {
        for (;;) {
          if (opts.signal?.aborted) return;
          const idx = cursor++;
          if (idx >= batch.length) return;
          const item = batch[idx]!;

          if (opts.respectRobots && !isAllowed(robots, item.url)) {
            blockedByRobots++;
            continue;
          }

          try {
            const res = await httpFetch(item.url, {
              timeoutMs: opts.timeoutMs,
              userAgent: opts.userAgent,
              retries: 1,
              maxBytes: 4 * 1024 * 1024,
              ...(opts.signal ? { signal: opts.signal } : {}),
            });

            // Two queued URLs can still land on the same page after redirects
            // (e.g. an old path and its replacement). Record it once.
            const resolvedKey = slashInsensitiveKey(res.final_url);
            if (res.status < 400 && resolved.has(resolvedKey)) continue;
            if (res.status < 400) resolved.add(resolvedKey);

            const isHtml = (res.headers['content-type'] ?? '').includes('html');
            if (!isHtml && res.status < 400) {
              // Record non-HTML responses so link-checking rules can still see
              // that the target resolved, without parsing them as pages.
              pages.push(nonHtmlPage(item.url, res.final_url, res.status, res.headers, res.bytes, res.ms, item.depth));
              continue;
            }

            const page = extractPage({
              url: item.url,
              finalUrl: res.final_url,
              status: res.status,
              html: res.body,
              headers: res.headers,
              bytes: res.bytes,
              fetchMs: res.ms,
              redirectChain: res.redirect_chain,
              depth: item.depth,
            });
            pages.push(page);
            opts.onPage?.(page, pages.length);

            if (item.depth >= maxDepth) continue;
            // noindex pages still get crawled (we want to report them) but we
            // don't follow links out of a page marked nofollow.
            if (page.meta_robots && /\bnofollow\b/i.test(page.meta_robots)) continue;

            for (const link of page.links) {
              if (!link.internal || link.nofollow) continue;
              if (!looksLikeHtml(link.url)) continue;
              // Record discovery before the scope check: a sitemap URL on
              // another subdomain is still "linked", so it isn't an orphan.
              linkDiscovered.add(slashInsensitiveKey(link.url));
              if (!inScope(link.url)) continue;
              const key = slashInsensitiveKey(link.url);
              if (seen.has(key)) continue;
              if (!passesFilters(link.url, include, exclude)) continue;
              seen.add(key);
              frontier.push({ url: link.url, depth: item.depth + 1 });
            }
          } catch (err) {
            const e = normalizeError(err);
            errors.push({ url: item.url, error: e.message, code: e.code });
            pages.push(errorPage(item.url, item.depth, e.message));
          }
        }
      },
    );
    await Promise.all(workers);
  }

  // In the sitemap but never reachable by following internal links: these get
  // little or no PageRank and are a classic silent traffic leak.
  //
  // Only a *complete* crawl can conclude this. On a truncated crawl every
  // sitemap URL the page budget never reached looks orphaned — stripe.com with
  // max_pages=4 reported 1,930 orphan warnings and a health score of 0, burying
  // every real finding. Restricting it to pages actually fetched is not enough
  // either: the crawl seeds from the sitemap, so a seeded page has no inbound
  // link within the crawled subset even when page N+1 links to it straight away.
  // Since the whole claim is "nothing on the site links here", anything short of
  // full link discovery has to return nothing rather than guess. The tool warns
  // that the check was skipped.
  const discoveryComplete = stoppedReason === 'complete' && frontier.length === 0;
  const orphans = discoveryComplete
    ? sitemapUrls.filter((u) => !linkDiscovered.has(slashInsensitiveKey(u)))
    : [];

  return {
    site: seedParsed.hostname,
    origin,
    pages,
    queued_not_crawled: frontier.map((f) => f.url),
    orphans,
    sitemap_urls: sitemapUrls,
    robots: {
      exists: robots.exists,
      blocked_count: blockedByRobots,
      sitemaps: robots.sitemaps,
      crawl_delay: robots.crawlDelay,
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    errors,
    stopped_reason: stoppedReason,
  };
}

function compilePatterns(patterns?: string[]): Array<RegExp | string> {
  if (!patterns || patterns.length === 0) return [];
  return patterns.map((p) => {
    if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
      const end = p.lastIndexOf('/');
      try {
        return new RegExp(p.slice(1, end), p.slice(end + 1));
      } catch {
        return p;
      }
    }
    return p;
  });
}

function matchesAny(url: string, patterns: Array<RegExp | string>): boolean {
  return patterns.some((p) => (typeof p === 'string' ? url.includes(p) : p.test(url)));
}

function passesFilters(
  url: string,
  include: Array<RegExp | string>,
  exclude: Array<RegExp | string>,
): boolean {
  if (exclude.length > 0 && matchesAny(url, exclude)) return false;
  if (include.length > 0 && !matchesAny(url, include)) return false;
  return true;
}

function nonHtmlPage(
  url: string,
  finalUrl: string,
  status: number,
  headers: Record<string, string>,
  bytes: number,
  ms: number,
  depth: number,
): PageData {
  return {
    url,
    final_url: finalUrl,
    status,
    redirect_chain: [],
    content_type: headers['content-type'] ?? null,
    bytes,
    fetch_ms: ms,
    title: null,
    meta_description: null,
    meta_robots: null,
    canonical: null,
    lang: null,
    headings: [],
    h1: [],
    text: '',
    word_count: 0,
    links: [],
    images: [],
    jsonld: [],
    social: {},
    hreflang: [],
    depth,
  };
}

function errorPage(url: string, depth: number, error: string): PageData {
  return { ...nonHtmlPage(url, url, 0, {}, 0, 0, depth), error };
}

/** Fetch and model a single URL without crawling outward. */
export async function fetchPage(
  url: string,
  opts: Pick<CrawlOptions, 'timeoutMs' | 'userAgent'> & { depth?: number },
): Promise<{ page: PageData; html: string }> {
  const n = normalizeUrl(url);
  if (!n) {
    throw new SeoAgentError('INVALID_INPUT', `Not a usable URL: ${url}`, 'Pass an absolute http(s) URL.');
  }
  const res = await httpFetch(n, {
    timeoutMs: opts.timeoutMs,
    userAgent: opts.userAgent,
    retries: 2,
    maxBytes: 6 * 1024 * 1024,
  });
  const page = extractPage({
    url: n,
    finalUrl: res.final_url,
    status: res.status,
    html: res.body,
    headers: res.headers,
    bytes: res.bytes,
    fetchMs: res.ms,
    redirectChain: res.redirect_chain,
    depth: opts.depth ?? 0,
  });
  return { page, html: res.body };
}
