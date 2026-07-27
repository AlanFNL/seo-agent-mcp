import { httpFetch } from '../core/http.js';
import { normalizeUrl } from '../core/url.js';

/**
 * Sitemap discovery and parsing.
 *
 * Sitemaps are the cheapest possible way to learn a site's real URL inventory —
 * far better than link-discovery alone, which misses orphans by definition.
 * Comparing "in sitemap" against "reachable by crawling" is itself one of the
 * highest-signal audits we produce.
 */

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: number | null;
  /** Which sitemap file this entry came from. */
  source: string;
}

export interface SitemapResult {
  entries: SitemapEntry[];
  /** Every sitemap file fetched, including children of an index. */
  sitemaps: string[];
  errors: Array<{ url: string; error: string }>;
}

/** Regex parsing rather than an XML dep: sitemaps are a fixed, simple shape. */
function extractTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? '');
  return out;
}

function firstTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m?.[1]?.trim() ?? null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .trim();
}

export async function fetchSitemap(
  url: string,
  opts: { maxUrls?: number; maxDepth?: number; timeoutMs?: number } = {},
): Promise<SitemapResult> {
  const maxUrls = opts.maxUrls ?? 50_000;
  const maxDepth = opts.maxDepth ?? 3;
  const entries: SitemapEntry[] = [];
  const fetched = new Set<string>();
  const errors: Array<{ url: string; error: string }> = [];

  async function walk(target: string, depth: number): Promise<void> {
    if (depth > maxDepth || entries.length >= maxUrls || fetched.has(target)) return;
    fetched.add(target);

    let body: string;
    try {
      const res = await httpFetch(target, {
        retries: 1,
        timeoutMs: opts.timeoutMs ?? 20_000,
        maxBytes: 30 * 1024 * 1024,
      });
      if (res.status >= 400) {
        errors.push({ url: target, error: `HTTP ${res.status}` });
        return;
      }
      body = res.body;
    } catch (err) {
      errors.push({ url: target, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    // A sitemap index points at more sitemaps; recurse into it.
    if (/<sitemapindex/i.test(body)) {
      const children = extractTags(body, 'sitemap');
      for (const child of children) {
        const loc = firstTag(child, 'loc');
        if (!loc) continue;
        const n = normalizeUrl(decodeXmlEntities(loc));
        if (n) await walk(n, depth + 1);
        if (entries.length >= maxUrls) return;
      }
      return;
    }

    // Plain-text sitemaps (one URL per line) are legal and surprisingly common.
    if (!/<urlset/i.test(body) && !/<url>/i.test(body)) {
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t || !/^https?:\/\//i.test(t)) continue;
        const n = normalizeUrl(t);
        if (n) entries.push({ url: n, lastmod: null, changefreq: null, priority: null, source: target });
        if (entries.length >= maxUrls) return;
      }
      return;
    }

    for (const block of extractTags(body, 'url')) {
      const loc = firstTag(block, 'loc');
      if (!loc) continue;
      const n = normalizeUrl(decodeXmlEntities(loc));
      if (!n) continue;
      const priority = firstTag(block, 'priority');
      entries.push({
        url: n,
        lastmod: firstTag(block, 'lastmod'),
        changefreq: firstTag(block, 'changefreq'),
        priority: priority ? Number(priority) : null,
        source: target,
      });
      if (entries.length >= maxUrls) return;
    }
  }

  await walk(url, 0);
  return { entries, sitemaps: [...fetched], errors };
}

/** Try robots.txt-declared sitemaps first, then the conventional locations. */
export async function discoverSitemaps(origin: string, fromRobots: string[]): Promise<string[]> {
  if (fromRobots.length > 0) return fromRobots;
  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/sitemap/sitemap.xml`,
  ];
  const found: string[] = [];
  for (const c of candidates) {
    try {
      const res = await httpFetch(c, { method: 'GET', retries: 0, timeoutMs: 8000, maxBytes: 4096 });
      if (res.status < 400 && /<(urlset|sitemapindex)/i.test(res.body)) {
        found.push(c);
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return found;
}
