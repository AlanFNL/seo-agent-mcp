import type { PageData, Issue, Severity, Action } from '../core/types.js';
import { action } from '../core/envelope.js';
import { findNearDuplicates, truncate, clamp, round } from '../core/text.js';
import { normalizeUrl, sameSite, pathSegments, parseUrl } from '../core/url.js';
import type { CrawlResult } from './crawler.js';

/**
 * The audit rules engine.
 *
 * Every rule is declarative and independently testable. Two design choices
 * worth flagging:
 *
 * - Rules emit `Issue`s (facts). Actions (recommendations) are derived
 *   separately and *aggregated* — an agent doesn't want 400 separate "add alt
 *   text" actions, it wants one action that says "312 images across 48 pages
 *   are missing alt text, here are the worst offenders".
 * - Severity follows the errors/warnings/notices split both Ahrefs and Semrush
 *   use, because it maps cleanly onto "must fix / should fix / consider".
 */

export interface AuditContext {
  pages: PageData[];
  /** Normalized URL -> page, for link-target resolution. */
  byUrl: Map<string, PageData>;
  crawl: CrawlResult;
  /** Inbound internal link counts, computed once. */
  inLinks: Map<string, number>;
  outLinks: Map<string, number>;
}

export interface Rule {
  id: string;
  severity: Severity;
  category: string;
  description: string;
  check(ctx: AuditContext): Issue[];
}

// --- thresholds, in one place so they're easy to audit and tune -------------

export const LIMITS = {
  TITLE_MIN: 20,
  TITLE_MAX: 60,
  META_DESC_MIN: 70,
  META_DESC_MAX: 160,
  THIN_CONTENT_WORDS: 300,
  VERY_THIN_WORDS: 100,
  MAX_LINKS_PER_PAGE: 150,
  MAX_DEPTH: 4,
  MAX_URL_LENGTH: 115,
  SLOW_PAGE_MS: 1500,
  VERY_SLOW_PAGE_MS: 3000,
  LARGE_PAGE_BYTES: 2 * 1024 * 1024,
  /** Jaccard similarity at or above which two pages count as duplicate content. */
  DUPLICATE_SIMILARITY: 0.85,
  MIN_TEXT_HTML_RATIO: 0.08,
} as const;

function issue(
  rule: string,
  severity: Severity,
  url: string,
  message: string,
  evidence?: Record<string, unknown>,
): Issue {
  return { rule, severity, url, message, ...(evidence ? { evidence } : {}) };
}

/** Pages that are real HTML documents we successfully fetched. */
function htmlPages(ctx: AuditContext): PageData[] {
  return ctx.pages.filter(
    (p) => !p.error && p.status >= 200 && p.status < 300 && (p.content_type ?? '').includes('html'),
  );
}

function isIndexable(p: PageData): boolean {
  if (p.meta_robots && /\bnoindex\b/i.test(p.meta_robots)) return false;
  if (p.status < 200 || p.status >= 300) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Status & redirects
// ---------------------------------------------------------------------------

const statusRules: Rule[] = [
  {
    id: 'status.5xx',
    severity: 'error',
    category: 'technical',
    description: 'Page returns a server error.',
    check: (ctx) =>
      ctx.pages
        .filter((p) => p.status >= 500)
        .map((p) => issue('status.5xx', 'error', p.url, `Server error ${p.status}.`, { status: p.status })),
  },
  {
    id: 'status.4xx',
    severity: 'error',
    category: 'technical',
    description: 'Page returns a client error.',
    check: (ctx) =>
      ctx.pages
        .filter((p) => p.status >= 400 && p.status < 500)
        .map((p) =>
          issue('status.4xx', 'error', p.url, `Client error ${p.status}.`, {
            status: p.status,
            inbound_internal_links: ctx.inLinks.get(p.url) ?? 0,
          }),
        ),
  },
  {
    id: 'status.fetch_failed',
    severity: 'error',
    category: 'technical',
    description: 'Page could not be fetched at all.',
    check: (ctx) =>
      ctx.pages
        .filter((p) => Boolean(p.error))
        .map((p) => issue('status.fetch_failed', 'error', p.url, `Fetch failed: ${p.error}`, { error: p.error })),
  },
  {
    id: 'links.broken_internal',
    severity: 'error',
    category: 'internal-links',
    description: 'Internal link points to a URL that errors.',
    check: (ctx) => {
      const out: Issue[] = [];
      const broken = new Set(
        ctx.pages.filter((p) => p.status >= 400 || p.error).map((p) => p.url),
      );
      if (broken.size === 0) return out;
      // One issue per page, listing its broken targets — see links.to_redirect
      // for why per-occurrence reporting is unusable at crawl scale.
      for (const page of htmlPages(ctx)) {
        const hits = page.links.filter((l) => l.internal && broken.has(l.url));
        if (hits.length === 0) continue;
        const distinct = [...new Map(hits.map((l) => [l.url, l])).values()];
        out.push(
          issue(
            'links.broken_internal',
            'error',
            page.url,
            `${distinct.length} internal link(s) on this page point to broken URLs.`,
            {
              count: distinct.length,
              targets: distinct.slice(0, 5).map((l) => ({
                url: l.url,
                status: ctx.byUrl.get(l.url)?.status ?? 0,
                anchor: l.anchor,
              })),
            },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'redirect.chain',
    severity: 'warning',
    category: 'technical',
    description: 'URL redirects more than once before resolving.',
    check: (ctx) =>
      ctx.pages
        .filter((p) => p.redirect_chain.length > 0 && p.url !== p.final_url)
        .map((p) =>
          issue('redirect.chain', 'warning', p.url, `Redirects to ${p.final_url}.`, {
            final_url: p.final_url,
            hops: p.redirect_chain.length,
          }),
        ),
  },
  {
    id: 'links.to_redirect',
    severity: 'notice',
    category: 'internal-links',
    description: 'Internal link points at a redirecting URL instead of the destination.',
    check: (ctx) => {
      const redirects = new Map<string, string>();
      for (const p of ctx.pages) {
        if (p.url !== p.final_url && p.final_url) redirects.set(p.url, p.final_url);
      }
      if (redirects.size === 0) return [];
      const out: Issue[] = [];
      // Aggregated per page, not per link. A single redirecting URL in a site-wide
      // nav otherwise emits one issue per page per occurrence — on a 25-page
      // crawl that produced 550 findings for what is really one bad link.
      for (const page of htmlPages(ctx)) {
        const hits = page.links
          .filter((l) => l.internal && redirects.has(l.url))
          .map((l) => ({ from: l.url, to: redirects.get(l.url) as string }));
        if (hits.length === 0) continue;
        const distinct = [...new Map(hits.map((h) => [h.from, h])).values()];
        out.push(
          issue(
            'links.to_redirect',
            'notice',
            page.url,
            `${distinct.length} distinct internal link target(s) on this page redirect elsewhere.`,
            { count: distinct.length, examples: distinct.slice(0, 5) },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'security.http_link',
    severity: 'warning',
    category: 'technical',
    description: 'HTTPS page links to or loads an HTTP resource (mixed content).',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const page of htmlPages(ctx)) {
        if (!page.final_url.startsWith('https:')) continue;
        const httpImages = page.images.filter((i) => i.src.startsWith('http:'));
        if (httpImages.length > 0) {
          out.push(
            issue('security.http_link', 'warning', page.url, `${httpImages.length} image(s) loaded over HTTP on an HTTPS page.`, {
              examples: httpImages.slice(0, 3).map((i) => i.src),
            }),
          );
        }
      }
      return out;
    },
  },
];

// ---------------------------------------------------------------------------
// Indexability & canonicals
// ---------------------------------------------------------------------------

const indexRules: Rule[] = [
  {
    id: 'index.noindex',
    severity: 'warning',
    category: 'indexability',
    description: 'Page is marked noindex.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.meta_robots && /\bnoindex\b/i.test(p.meta_robots))
        .map((p) =>
          issue('index.noindex', 'warning', p.url, 'Page is set to noindex and cannot rank.', {
            meta_robots: p.meta_robots,
            inbound_internal_links: ctx.inLinks.get(p.url) ?? 0,
          }),
        ),
  },
  {
    id: 'index.noindex_in_sitemap',
    severity: 'error',
    category: 'indexability',
    description: 'A noindex page is listed in the sitemap, which sends Google contradictory signals.',
    check: (ctx) => {
      const inSitemap = new Set(ctx.crawl.sitemap_urls);
      return htmlPages(ctx)
        .filter((p) => inSitemap.has(p.url) && !isIndexable(p))
        .map((p) =>
          issue('index.noindex_in_sitemap', 'error', p.url, 'Page is in the sitemap but is not indexable.', {
            meta_robots: p.meta_robots,
            status: p.status,
          }),
        );
    },
  },
  {
    id: 'canonical.missing',
    severity: 'warning',
    category: 'indexability',
    description: 'Page has no canonical tag.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => !p.canonical && isIndexable(p))
        .map((p) => issue('canonical.missing', 'warning', p.url, 'No canonical tag. Add a self-referencing canonical.')),
  },
  {
    id: 'canonical.points_elsewhere',
    severity: 'notice',
    category: 'indexability',
    description: 'Canonical points at a different URL, so this page will not rank on its own.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.canonical && normalizeUrl(p.canonical) !== normalizeUrl(p.final_url))
        .map((p) =>
          issue('canonical.points_elsewhere', 'notice', p.url, `Canonicalised to ${p.canonical}.`, {
            canonical: p.canonical,
          }),
        ),
  },
  {
    id: 'canonical.broken',
    severity: 'error',
    category: 'indexability',
    description: 'Canonical points at a URL that errors or redirects.',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        if (!p.canonical) continue;
        const target = ctx.byUrl.get(p.canonical);
        if (!target) continue;
        if (target.status >= 400 || target.error) {
          out.push(
            issue('canonical.broken', 'error', p.url, `Canonical target ${p.canonical} returns ${target.status}.`, {
              canonical: p.canonical,
              target_status: target.status,
            }),
          );
        } else if (target.url !== target.final_url) {
          out.push(
            issue('canonical.broken', 'error', p.url, `Canonical target ${p.canonical} redirects to ${target.final_url}.`, {
              canonical: p.canonical,
              redirects_to: target.final_url,
            }),
          );
        }
      }
      return out;
    },
  },
  {
    id: 'canonical.chain',
    severity: 'warning',
    category: 'indexability',
    description: 'Canonical points at a page that itself canonicalises elsewhere.',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        if (!p.canonical) continue;
        const target = ctx.byUrl.get(p.canonical);
        if (!target?.canonical) continue;
        if (normalizeUrl(target.canonical) === normalizeUrl(target.final_url)) continue;
        if (normalizeUrl(p.canonical) === normalizeUrl(p.final_url)) continue;
        out.push(
          issue('canonical.chain', 'warning', p.url, `Canonical chain: ${p.url} -> ${p.canonical} -> ${target.canonical}.`, {
            chain: [p.url, p.canonical, target.canonical],
          }),
        );
      }
      return out;
    },
  },
  {
    id: 'index.orphan',
    severity: 'warning',
    category: 'internal-links',
    description: 'Page exists in the sitemap but no internal link points to it.',
    check: (ctx) =>
      ctx.crawl.orphans.map((url) =>
        issue('index.orphan', 'warning', url, 'Orphan page: in the sitemap but not linked from anywhere on the site.', {
          in_sitemap: true,
        }),
      ),
  },
  {
    id: 'index.not_in_sitemap',
    severity: 'notice',
    category: 'indexability',
    description: 'Indexable page is missing from the sitemap.',
    check: (ctx) => {
      if (ctx.crawl.sitemap_urls.length === 0) return [];
      const inSitemap = new Set(ctx.crawl.sitemap_urls);
      return htmlPages(ctx)
        .filter((p) => isIndexable(p) && !inSitemap.has(p.url) && !inSitemap.has(p.final_url))
        .filter((p) => !p.canonical || normalizeUrl(p.canonical) === normalizeUrl(p.final_url))
        .map((p) => issue('index.not_in_sitemap', 'notice', p.url, 'Indexable page is not listed in the sitemap.'));
    },
  },
  {
    id: 'sitemap.missing',
    severity: 'warning',
    category: 'technical',
    description: 'No XML sitemap was found.',
    check: (ctx) =>
      ctx.crawl.sitemap_urls.length === 0
        ? [issue('sitemap.missing', 'warning', ctx.crawl.origin, 'No XML sitemap found at the usual locations or in robots.txt.')]
        : [],
  },
  {
    id: 'robots.missing',
    severity: 'notice',
    category: 'technical',
    description: 'No robots.txt.',
    check: (ctx) =>
      ctx.crawl.robots.exists
        ? []
        : [issue('robots.missing', 'notice', `${ctx.crawl.origin}/robots.txt`, 'No robots.txt found. Add one that points at your sitemap.')],
  },
];

// ---------------------------------------------------------------------------
// On-page elements
// ---------------------------------------------------------------------------

const onPageRules: Rule[] = [
  {
    id: 'title.missing',
    severity: 'error',
    category: 'on-page',
    description: 'Page has no title tag.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => !p.title || p.title.trim() === '')
        .map((p) => issue('title.missing', 'error', p.url, 'Missing <title>. This is the single strongest on-page signal.')),
  },
  {
    id: 'title.too_long',
    severity: 'warning',
    category: 'on-page',
    description: 'Title will be truncated in search results.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.title && p.title.length > LIMITS.TITLE_MAX)
        .map((p) =>
          issue('title.too_long', 'warning', p.url, `Title is ${p.title!.length} chars; over ~${LIMITS.TITLE_MAX} gets truncated.`, {
            length: p.title!.length,
            title: p.title,
          }),
        ),
  },
  {
    id: 'title.too_short',
    severity: 'notice',
    category: 'on-page',
    description: 'Title is short enough that it is probably leaving keywords on the table.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.title && p.title.trim().length > 0 && p.title.length < LIMITS.TITLE_MIN)
        .map((p) =>
          issue('title.too_short', 'notice', p.url, `Title is only ${p.title!.length} chars.`, {
            length: p.title!.length,
            title: p.title,
          }),
        ),
  },
  {
    id: 'title.duplicate',
    severity: 'error',
    category: 'on-page',
    description: 'Multiple pages share the same title.',
    check: (ctx) => groupDuplicates(ctx, (p) => p.title?.trim().toLowerCase() ?? '', 'title.duplicate', 'title'),
  },
  {
    id: 'meta_description.missing',
    severity: 'warning',
    category: 'on-page',
    description: 'No meta description, so Google will invent a snippet.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => isIndexable(p) && (!p.meta_description || p.meta_description.trim() === ''))
        .map((p) => issue('meta_description.missing', 'warning', p.url, 'Missing meta description.')),
  },
  {
    id: 'meta_description.too_long',
    severity: 'notice',
    category: 'on-page',
    description: 'Meta description will be truncated.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.meta_description && p.meta_description.length > LIMITS.META_DESC_MAX)
        .map((p) =>
          issue('meta_description.too_long', 'notice', p.url, `Meta description is ${p.meta_description!.length} chars.`, {
            length: p.meta_description!.length,
          }),
        ),
  },
  {
    id: 'meta_description.too_short',
    severity: 'notice',
    category: 'on-page',
    description: 'Meta description is too short to be persuasive.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter(
          (p) =>
            p.meta_description &&
            p.meta_description.trim().length > 0 &&
            p.meta_description.length < LIMITS.META_DESC_MIN,
        )
        .map((p) =>
          issue('meta_description.too_short', 'notice', p.url, `Meta description is only ${p.meta_description!.length} chars.`, {
            length: p.meta_description!.length,
          }),
        ),
  },
  {
    id: 'meta_description.duplicate',
    severity: 'warning',
    category: 'on-page',
    description: 'Multiple pages share the same meta description.',
    check: (ctx) =>
      groupDuplicates(ctx, (p) => p.meta_description?.trim().toLowerCase() ?? '', 'meta_description.duplicate', 'meta description'),
  },
  {
    id: 'h1.missing',
    severity: 'error',
    category: 'on-page',
    description: 'Page has no H1.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.h1.length === 0 && p.word_count > 50)
        .map((p) => issue('h1.missing', 'error', p.url, 'No H1 heading.')),
  },
  {
    id: 'h1.multiple',
    severity: 'notice',
    category: 'on-page',
    description: 'More than one H1 dilutes the page topic.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.h1.length > 1)
        .map((p) => issue('h1.multiple', 'notice', p.url, `${p.h1.length} H1 tags found.`, { h1s: p.h1.slice(0, 5) })),
  },
  {
    id: 'h1.duplicate',
    severity: 'warning',
    category: 'on-page',
    description: 'Multiple pages share the same H1.',
    check: (ctx) => groupDuplicates(ctx, (p) => p.h1[0]?.trim().toLowerCase() ?? '', 'h1.duplicate', 'H1'),
  },
  {
    id: 'headings.skipped_level',
    severity: 'notice',
    category: 'on-page',
    description: 'Heading levels skip a step, which breaks document outline.',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        let prev = 0;
        for (const h of p.headings) {
          if (prev > 0 && h.level > prev + 1) {
            out.push(
              issue('headings.skipped_level', 'notice', p.url, `Heading jumps from H${prev} to H${h.level} ("${truncate(h.text, 60)}").`, {
                from: prev,
                to: h.level,
              }),
            );
            break;
          }
          prev = h.level;
        }
      }
      return out;
    },
  },
  {
    id: 'lang.missing',
    severity: 'notice',
    category: 'technical',
    description: 'No lang attribute on <html>.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => !p.lang)
        .map((p) => issue('lang.missing', 'notice', p.url, 'Missing lang attribute on <html>.')),
  },
];

// ---------------------------------------------------------------------------
// Content quality
// ---------------------------------------------------------------------------

const contentRules: Rule[] = [
  {
    id: 'content.thin',
    severity: 'warning',
    category: 'content',
    description: 'Page has too little content to compete.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => isIndexable(p) && p.word_count > 0 && p.word_count < LIMITS.THIN_CONTENT_WORDS)
        .map((p) =>
          issue(
            'content.thin',
            p.word_count < LIMITS.VERY_THIN_WORDS ? 'error' : 'warning',
            p.url,
            `Only ${p.word_count} words of body content.`,
            { word_count: p.word_count },
          ),
        ),
  },
  {
    id: 'content.empty',
    severity: 'error',
    category: 'content',
    description: 'Indexable page has essentially no text.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => isIndexable(p) && p.word_count === 0)
        .map((p) =>
          issue('content.empty', 'error', p.url, 'No extractable body text. If this renders client-side, Google may see nothing.', {
            bytes: p.bytes,
          }),
        ),
  },
  {
    id: 'content.low_text_ratio',
    severity: 'notice',
    category: 'content',
    description: 'Very little text relative to page weight.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => {
          if (p.bytes < 20_000 || p.word_count === 0) return false;
          return (p.text.length / p.bytes) < LIMITS.MIN_TEXT_HTML_RATIO;
        })
        .map((p) =>
          issue('content.low_text_ratio', 'notice', p.url, `Text is only ${round((p.text.length / p.bytes) * 100, 1)}% of page weight.`, {
            text_chars: p.text.length,
            bytes: p.bytes,
          }),
        ),
  },
  {
    id: 'content.duplicate',
    severity: 'error',
    category: 'content',
    description: 'Two or more pages have near-identical body content.',
    check: (ctx) => {
      const candidates = htmlPages(ctx).filter((p) => p.word_count >= 100 && isIndexable(p));
      if (candidates.length < 2) return [];

      const clusters = findNearDuplicates(
        candidates.map((p) => p.text),
        { threshold: LIMITS.DUPLICATE_SIMILARITY },
      );

      const out: Issue[] = [];
      for (const cluster of clusters) {
        const urls = cluster.members.map((i) => (candidates[i] as PageData).url);
        // Report on every member: an agent fixing this needs to see all the
        // pages involved from whichever one it happens to look at.
        for (const i of cluster.members) {
          const page = candidates[i] as PageData;
          const others = urls.filter((u) => u !== page.url);
          out.push(
            issue(
              'content.duplicate',
              'error',
              page.url,
              `Body content is ${round(cluster.similarity * 100, 1)}% identical to ${others.length} other page(s).`,
              {
                duplicates: others.slice(0, 5),
                similarity: cluster.similarity,
                cluster_size: cluster.members.length,
                word_count: page.word_count,
              },
            ),
          );
        }
      }
      return out;
    },
  },
];

// ---------------------------------------------------------------------------
// Links & architecture
// ---------------------------------------------------------------------------

const linkRules: Rule[] = [
  {
    id: 'links.deep_page',
    severity: 'notice',
    category: 'internal-links',
    description: 'Page is more than a few clicks from the homepage.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.depth > LIMITS.MAX_DEPTH)
        .map((p) =>
          issue('links.deep_page', 'notice', p.url, `${p.depth} clicks from the homepage; link to it from a shallower page.`, {
            depth: p.depth,
          }),
        ),
  },
  {
    id: 'links.few_inbound',
    severity: 'notice',
    category: 'internal-links',
    description: 'Indexable page receives very few internal links.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => isIndexable(p) && p.depth > 0 && (ctx.inLinks.get(p.url) ?? 0) <= 1)
        .map((p) =>
          issue('links.few_inbound', 'notice', p.url, `Only ${ctx.inLinks.get(p.url) ?? 0} internal link(s) point here.`, {
            inbound: ctx.inLinks.get(p.url) ?? 0,
          }),
        ),
  },
  {
    id: 'links.too_many',
    severity: 'notice',
    category: 'internal-links',
    description: 'Page has an unusually large number of links, diluting link equity.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.links.length > LIMITS.MAX_LINKS_PER_PAGE)
        .map((p) => issue('links.too_many', 'notice', p.url, `${p.links.length} links on one page.`, { links: p.links.length })),
  },
  {
    id: 'links.generic_anchor',
    severity: 'notice',
    category: 'internal-links',
    description: 'Internal links use anchors that carry no keyword signal.',
    check: (ctx) => {
      const generic = new Set([
        'click here', 'here', 'read more', 'more', 'learn more', 'this', 'link', 'this page',
        'continue reading', 'see more', 'details', 'download', 'view', 'go', 'next', 'previous',
      ]);
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        const bad = p.links.filter((l) => l.internal && generic.has(l.anchor.trim().toLowerCase()));
        if (bad.length === 0) continue;
        out.push(
          issue('links.generic_anchor', 'notice', p.url, `${bad.length} internal link(s) use non-descriptive anchor text.`, {
            examples: bad.slice(0, 5).map((l) => ({ anchor: l.anchor, target: l.url })),
          }),
        );
      }
      return out;
    },
  },
  {
    id: 'links.internal_nofollow',
    severity: 'notice',
    category: 'internal-links',
    description: 'Internal links marked nofollow waste internal link equity.',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        const nf = p.links.filter((l) => l.internal && l.nofollow);
        if (nf.length === 0) continue;
        out.push(
          issue('links.internal_nofollow', 'notice', p.url, `${nf.length} internal link(s) are nofollow.`, {
            examples: nf.slice(0, 5).map((l) => l.url),
          }),
        );
      }
      return out;
    },
  },
  {
    id: 'url.too_long',
    severity: 'notice',
    category: 'technical',
    description: 'URL is long enough to be truncated in results and hard to share.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.url.length > LIMITS.MAX_URL_LENGTH)
        .map((p) => issue('url.too_long', 'notice', p.url, `URL is ${p.url.length} characters.`, { length: p.url.length })),
  },
  {
    id: 'url.non_ideal_format',
    severity: 'notice',
    category: 'technical',
    description: 'URL contains uppercase letters, underscores, or a session-like parameter.',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        const u = parseUrl(p.url);
        if (!u) continue;
        const problems: string[] = [];
        if (/[A-Z]/.test(u.pathname)) problems.push('uppercase characters');
        if (u.pathname.includes('_')) problems.push('underscores (use hyphens)');
        if (u.searchParams.size > 2) problems.push(`${u.searchParams.size} query parameters`);
        if (problems.length === 0) continue;
        out.push(issue('url.non_ideal_format', 'notice', p.url, `URL has ${problems.join(', ')}.`, { problems }));
      }
      return out;
    },
  },
];

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const imageRules: Rule[] = [
  {
    id: 'images.missing_alt',
    severity: 'warning',
    category: 'on-page',
    description: 'Images have no alt text.',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        const missing = p.images.filter((i) => i.alt === null || i.alt.trim() === '');
        if (missing.length === 0) continue;
        out.push(
          issue('images.missing_alt', 'warning', p.url, `${missing.length} of ${p.images.length} images lack alt text.`, {
            missing: missing.length,
            total: p.images.length,
            examples: missing.slice(0, 5).map((i) => i.src),
          }),
        );
      }
      return out;
    },
  },
  {
    id: 'images.missing_dimensions',
    severity: 'notice',
    category: 'performance',
    description: 'Images without width/height cause layout shift (CLS).',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        const noDims = p.images.filter((i) => i.width === null || i.height === null);
        if (noDims.length === 0) continue;
        out.push(
          issue('images.missing_dimensions', 'notice', p.url, `${noDims.length} image(s) have no width/height, risking layout shift.`, {
            count: noDims.length,
          }),
        );
      }
      return out;
    },
  },
  {
    id: 'images.broken',
    severity: 'warning',
    category: 'technical',
    description: 'Image references a URL that returned an error during the crawl.',
    check: (ctx) => {
      const broken = new Set(ctx.pages.filter((p) => p.status >= 400).map((p) => p.url));
      if (broken.size === 0) return [];
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        const bad = p.images.filter((i) => broken.has(i.src));
        if (bad.length === 0) continue;
        out.push(
          issue('images.broken', 'warning', p.url, `${bad.length} broken image(s).`, {
            examples: bad.slice(0, 5).map((i) => i.src),
          }),
        );
      }
      return out;
    },
  },
];

// ---------------------------------------------------------------------------
// Structured data & social
// ---------------------------------------------------------------------------

const schemaRules: Rule[] = [
  {
    id: 'schema.missing',
    severity: 'notice',
    category: 'structured-data',
    description: 'Page has no structured data, forfeiting rich results.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => isIndexable(p) && p.jsonld.length === 0 && p.word_count > 200)
        .map((p) => issue('schema.missing', 'notice', p.url, 'No JSON-LD structured data found.')),
  },
  {
    id: 'schema.parse_error',
    severity: 'error',
    category: 'structured-data',
    description: 'A JSON-LD block is malformed and will be ignored by search engines.',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        for (const block of p.jsonld) {
          if (block && typeof block === 'object' && '__parse_error' in block) {
            out.push(
              issue('schema.parse_error', 'error', p.url, 'JSON-LD block failed to parse.', {
                snippet: (block as { __parse_error: string }).__parse_error,
              }),
            );
          }
        }
      }
      return out;
    },
  },
  {
    id: 'schema.incomplete',
    severity: 'warning',
    category: 'structured-data',
    description: 'Structured data is missing properties Google requires for rich results.',
    check: (ctx) => {
      // Only the required-property sets that actually gate rich results.
      const required: Record<string, string[]> = {
        Article: ['headline', 'image', 'datePublished'],
        BlogPosting: ['headline', 'image', 'datePublished'],
        NewsArticle: ['headline', 'image', 'datePublished'],
        Product: ['name', 'image'],
        Recipe: ['name', 'image', 'recipeIngredient', 'recipeInstructions'],
        FAQPage: ['mainEntity'],
        HowTo: ['name', 'step'],
        Event: ['name', 'startDate', 'location'],
        JobPosting: ['title', 'datePosted', 'hiringOrganization'],
        LocalBusiness: ['name', 'address'],
        Organization: ['name'],
        BreadcrumbList: ['itemListElement'],
        VideoObject: ['name', 'thumbnailUrl', 'uploadDate'],
        SoftwareApplication: ['name', 'applicationCategory'],
      };
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        for (const block of p.jsonld) {
          if (!block || typeof block !== 'object') continue;
          const obj = block as Record<string, unknown>;
          const rawType = obj['@type'];
          const types = Array.isArray(rawType) ? rawType : [rawType];
          for (const t of types) {
            if (typeof t !== 'string') continue;
            const req = required[t];
            if (!req) continue;
            const missing = req.filter((k) => obj[k] === undefined || obj[k] === null || obj[k] === '');
            if (missing.length === 0) continue;
            out.push(
              issue('schema.incomplete', 'warning', p.url, `${t} schema is missing required propert${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}.`, {
                type: t,
                missing,
              }),
            );
          }
        }
      }
      return out;
    },
  },
  {
    id: 'social.missing_og',
    severity: 'notice',
    category: 'on-page',
    description: 'Missing Open Graph tags, so shared links render poorly.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => isIndexable(p) && (!p.social['og:title'] || !p.social['og:image']))
        .map((p) =>
          issue('social.missing_og', 'notice', p.url, 'Missing og:title or og:image.', {
            has_og_title: Boolean(p.social['og:title']),
            has_og_image: Boolean(p.social['og:image']),
          }),
        ),
  },
];

// ---------------------------------------------------------------------------
// Internationalisation
// ---------------------------------------------------------------------------

const hreflangRules: Rule[] = [
  {
    id: 'hreflang.no_return_link',
    severity: 'error',
    category: 'international',
    description: 'hreflang annotations must be reciprocal; a one-way reference is ignored.',
    check: (ctx) => {
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        if (p.hreflang.length === 0) continue;
        for (const alt of p.hreflang) {
          if (alt.lang === 'x-default') continue;
          const target = ctx.byUrl.get(alt.href);
          if (!target || target.hreflang.length === 0) continue;
          const returns = target.hreflang.some((h) => normalizeUrl(h.href) === normalizeUrl(p.final_url));
          if (returns) continue;
          out.push(
            issue('hreflang.no_return_link', 'error', p.url, `hreflang points to ${alt.href} but that page does not link back.`, {
              target: alt.href,
              lang: alt.lang,
            }),
          );
        }
      }
      return out;
    },
  },
  {
    id: 'hreflang.invalid_code',
    severity: 'error',
    category: 'international',
    description: 'hreflang value is not a valid language or language-region code.',
    check: (ctx) => {
      const valid = /^([a-z]{2,3}(-[a-z]{4})?(-[a-z]{2}|-\d{3})?|x-default)$/i;
      const out: Issue[] = [];
      for (const p of htmlPages(ctx)) {
        for (const alt of p.hreflang) {
          if (valid.test(alt.lang)) continue;
          out.push(issue('hreflang.invalid_code', 'error', p.url, `Invalid hreflang value "${alt.lang}".`, { lang: alt.lang }));
        }
      }
      return out;
    },
  },
  {
    id: 'hreflang.missing_x_default',
    severity: 'notice',
    category: 'international',
    description: 'A multi-language cluster has no x-default fallback.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.hreflang.length > 1 && !p.hreflang.some((h) => h.lang === 'x-default'))
        .map((p) => issue('hreflang.missing_x_default', 'notice', p.url, 'hreflang set has no x-default entry.')),
  },
];

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

const perfRules: Rule[] = [
  {
    id: 'performance.slow_response',
    severity: 'warning',
    category: 'performance',
    description: 'Server response is slow enough to hurt crawl budget and rankings.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.fetch_ms > LIMITS.SLOW_PAGE_MS)
        .map((p) =>
          issue(
            'performance.slow_response',
            p.fetch_ms > LIMITS.VERY_SLOW_PAGE_MS ? 'error' : 'warning',
            p.url,
            `Took ${p.fetch_ms}ms to respond.`,
            { fetch_ms: p.fetch_ms },
          ),
        ),
  },
  {
    id: 'performance.large_page',
    severity: 'warning',
    category: 'performance',
    description: 'HTML document is unusually heavy.',
    check: (ctx) =>
      htmlPages(ctx)
        .filter((p) => p.bytes > LIMITS.LARGE_PAGE_BYTES)
        .map((p) =>
          issue('performance.large_page', 'warning', p.url, `HTML alone is ${round(p.bytes / 1024 / 1024, 2)}MB.`, {
            bytes: p.bytes,
          }),
        ),
  },
];

export const ALL_RULES: Rule[] = [
  ...statusRules,
  ...indexRules,
  ...onPageRules,
  ...contentRules,
  ...linkRules,
  ...imageRules,
  ...schemaRules,
  ...hreflangRules,
  ...perfRules,
];

function groupDuplicates(
  ctx: AuditContext,
  keyFn: (p: PageData) => string,
  ruleId: string,
  label: string,
): Issue[] {
  const groups = new Map<string, PageData[]>();
  for (const p of htmlPages(ctx)) {
    if (!isIndexable(p)) continue;
    // Canonicalised pages are *supposed* to share metadata with their canonical.
    if (p.canonical && normalizeUrl(p.canonical) !== normalizeUrl(p.final_url)) continue;
    const key = keyFn(p);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const out: Issue[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    for (const p of list) {
      out.push(
        issue(ruleId, ruleId.includes('title') ? 'error' : 'warning', p.url, `Shares its ${label} with ${list.length - 1} other page(s).`, {
          value: truncate(key, 120),
          duplicate_count: list.length,
          others: list.filter((o) => o.url !== p.url).slice(0, 5).map((o) => o.url),
        }),
      );
    }
  }
  return out;
}

export function buildContext(crawl: CrawlResult): AuditContext {
  const byUrl = new Map<string, PageData>();
  for (const p of crawl.pages) {
    byUrl.set(p.url, p);
    if (p.final_url !== p.url) byUrl.set(p.final_url, p);
  }
  const inLinks = new Map<string, number>();
  const outLinks = new Map<string, number>();
  for (const p of crawl.pages) {
    const internal = p.links.filter((l) => l.internal);
    outLinks.set(p.url, internal.length);
    for (const l of internal) {
      if (l.url === p.url) continue;
      inLinks.set(l.url, (inLinks.get(l.url) ?? 0) + 1);
    }
  }
  return { pages: crawl.pages, byUrl, crawl, inLinks, outLinks };
}

export interface AuditReport {
  issues: Issue[];
  by_rule: Array<{ rule: string; severity: Severity; category: string; count: number; description: string }>;
  by_severity: Record<Severity, number>;
  health_score: number;
  pages_audited: number;
}

export function runAudit(crawl: CrawlResult, only?: string[]): AuditReport {
  const ctx = buildContext(crawl);
  const rules = only && only.length > 0 ? ALL_RULES.filter((r) => only.includes(r.id) || only.includes(r.category)) : ALL_RULES;

  const issues: Issue[] = [];
  const byRule: AuditReport['by_rule'] = [];
  for (const rule of rules) {
    let found: Issue[];
    try {
      found = rule.check(ctx);
    } catch {
      // One broken rule must not sink the whole audit.
      continue;
    }
    if (found.length > 0) {
      issues.push(...found);
      byRule.push({
        rule: rule.id,
        severity: rule.severity,
        category: rule.category,
        count: found.length,
        description: rule.description,
      });
    }
  }
  byRule.sort((a, b) => severityWeight(b.severity) * b.count - severityWeight(a.severity) * a.count);

  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, notice: 0 };
  let siteLevel = 0;
  for (const i of issues) {
    bySeverity[i.severity]++;
    if (SITE_LEVEL_RULES.has(i.rule)) siteLevel++;
  }

  return {
    issues,
    by_rule: byRule,
    by_severity: bySeverity,
    health_score: healthScore(bySeverity, crawl.pages.length, siteLevel),
    pages_audited: crawl.pages.length,
  };
}

function severityWeight(s: Severity): number {
  return s === 'error' ? 10 : s === 'warning' ? 3 : 1;
}

/**
 * Rules that describe the site as a whole, not a page.
 *
 * These have to be excluded from per-page normalisation. A missing sitemap is
 * one problem whether the site has 1 page or 10,000 — dividing it by page count
 * made small sites score catastrophically for issues that are trivial to fix.
 */
const SITE_LEVEL_RULES = new Set(['sitemap.missing', 'robots.missing']);

/**
 * 0-100 health score.
 *
 * Page-level issues are normalised per page, so a 5,000-page site with 200
 * issues scores better than a 10-page site with 200 issues — that matches how a
 * human SEO reads severity and keeps the number comparable across crawls of the
 * same site over time.
 *
 * Two corrections that matter in practice:
 * - The denominator is smoothed (min 8) so a tiny site isn't judged on a sample
 *   of one. Without it, example.com scored 7.5/100 for seven trivial issues.
 * - Site-level rules are scored as a flat deduction rather than being divided
 *   by page count.
 */
export function healthScore(
  bySeverity: Record<Severity, number>,
  pageCount: number,
  siteLevelIssues = 0,
): number {
  if (pageCount === 0) return 0;
  const pages = Math.max(pageCount, 8);

  // Notices are advisory. A site with zero errors and zero warnings should never
  // score badly no matter how many notices it accumulates, so their total
  // contribution is capped rather than summed without bound — otherwise
  // "consider adding structured data" on every page tanks the score to 0.
  const noticeWeighted = Math.min(bySeverity.notice * 1, pages * 2.5);
  const pageWeighted = Math.max(
    0,
    bySeverity.error * 10 + bySeverity.warning * 3 + noticeWeighted - siteLevelIssues * 3,
  );
  const perPage = pageWeighted / pages;
  // perPage 0 -> 100; ~6 weighted points per page -> ~50; 20+ -> near 0.
  const pageScore = 100 * Math.exp(-perPage / 8.5);
  // Each site-wide misconfiguration costs a flat 4 points.
  return round(clamp(pageScore - siteLevelIssues * 4, 0, 100), 1);
}

/**
 * Roll issues up into a small number of high-leverage actions.
 *
 * This is where the tool stops being a linter and starts being useful to an
 * agent: 400 raw issues become 12 things to actually do, ordered.
 */
export function issuesToActions(report: AuditReport, ctx: AuditContext): Action[] {
  const actions: Action[] = [];
  const byRule = new Map<string, Issue[]>();
  for (const i of report.issues) {
    const list = byRule.get(i.rule);
    if (list) list.push(i);
    else byRule.set(i.rule, [i]);
  }

  /**
   * `title` is an imperative template — `{n}` becomes "3 pages" / "1 page".
   * Reusing the raw issue message here produced titles like "1 page: no
   * canonical tag", which reads like a log line rather than an instruction.
   */
  const meta: Record<
    string,
    { priority: Action['priority']; effort: Effort2; fix: string; title: string; how: string; siteLevel?: boolean }
  > = {
    'status.5xx': { priority: 'critical', effort: 'medium', fix: 'fix_server_error', title: 'Fix server errors on {n}', how: 'These pages are entirely unavailable to users and search engines.' },
    'status.4xx': { priority: 'critical', effort: 'small', fix: 'fix_broken_page', title: 'Resolve {n} returning 4xx', how: 'Restore the page or 301 it to the closest equivalent, then update the links pointing at it.' },
    'links.broken_internal': { priority: 'high', effort: 'trivial', fix: 'update_internal_link', title: 'Repair broken internal links on {n}', how: 'Point each link at a live URL. Broken internal links waste crawl budget and leak link equity.' },
    'title.missing': { priority: 'critical', effort: 'trivial', fix: 'set_title', title: 'Add a title tag to {n}', how: 'Write a 50-60 character title with the target keyword near the front. This is the strongest on-page signal there is.' },
    'title.duplicate': { priority: 'high', effort: 'small', fix: 'rewrite_title', title: 'Give unique titles to {n} sharing a title', how: 'Duplicate titles make Google pick one page and ignore the rest.' },
    'title.too_long': { priority: 'low', effort: 'trivial', fix: 'shorten_title', title: 'Shorten over-long titles on {n}', how: 'Titles past ~60 characters get truncated in results, cutting CTR.' },
    'h1.missing': { priority: 'high', effort: 'trivial', fix: 'add_h1', title: 'Add an H1 to {n}', how: 'One H1 per page, matching the page topic.' },
    'h1.duplicate': { priority: 'medium', effort: 'small', fix: 'rewrite_h1', title: 'Differentiate duplicate H1s across {n}', how: 'Identical H1s signal to Google that the pages are interchangeable.' },
    'meta_description.missing': { priority: 'medium', effort: 'trivial', fix: 'set_meta_description', title: 'Write meta descriptions for {n}', how: 'Write 140-160 characters that earn the click. Affects CTR rather than rankings directly.' },
    'meta_description.duplicate': { priority: 'low', effort: 'small', fix: 'rewrite_meta_description', title: 'Rewrite duplicate meta descriptions on {n}', how: 'Duplicates get discarded and replaced with an auto-generated snippet.' },
    'canonical.broken': { priority: 'critical', effort: 'small', fix: 'fix_canonical', title: 'Fix canonicals pointing at dead URLs on {n}', how: 'A canonical pointing at a 404 or a redirect can deindex the page entirely.' },
    'canonical.missing': { priority: 'medium', effort: 'trivial', fix: 'add_canonical', title: 'Add self-referencing canonicals to {n}', how: 'Pre-empts duplicate-URL problems from parameters and trailing slashes.' },
    'canonical.chain': { priority: 'medium', effort: 'small', fix: 'fix_canonical', title: 'Collapse canonical chains on {n}', how: 'Point each canonical directly at the final destination.' },
    'index.noindex_in_sitemap': { priority: 'high', effort: 'trivial', fix: 'remove_from_sitemap', title: 'Resolve contradictory indexing signals on {n}', how: 'Either drop the noindex or drop the URL from the sitemap. Right now the two signals contradict.' },
    'content.duplicate': { priority: 'high', effort: 'large', fix: 'consolidate_pages', title: 'Consolidate near-duplicate content across {n}', how: 'Merge and 301 the weaker page, or differentiate the content substantially.' },
    'content.thin': { priority: 'medium', effort: 'large', fix: 'expand_content', title: 'Expand thin content on {n}', how: 'Expand to fully answer the query, or consolidate into one stronger page.' },
    'content.empty': { priority: 'critical', effort: 'medium', fix: 'fix_rendering', title: 'Fix pages rendering no text on {n}', how: 'No server-rendered text means Google may index an empty page. Check client-side rendering.' },
    'content.low_text_ratio': { priority: 'low', effort: 'medium', fix: 'reduce_page_weight', title: 'Improve text-to-markup ratio on {n}', how: 'Very little content relative to page weight looks low-value to a crawler.' },
    'index.orphan': { priority: 'high', effort: 'small', fix: 'add_internal_link', title: 'Link to {n} currently orphaned', how: 'Link from relevant existing pages. Orphans receive almost no internal PageRank and get crawled rarely.' },
    'images.missing_alt': { priority: 'low', effort: 'small', fix: 'add_alt_text', title: 'Add alt text to images on {n}', how: 'Describe the image. Helps image search and accessibility.' },
    'performance.slow_response': { priority: 'high', effort: 'medium', fix: 'improve_ttfb', title: 'Speed up slow responses on {n}', how: 'Slow responses cut crawl budget and hurt Core Web Vitals.' },
    'performance.large_page': { priority: 'medium', effort: 'medium', fix: 'reduce_page_weight', title: 'Reduce page weight on {n}', how: 'Heavy HTML delays render and inflates LCP.' },
    'sitemap.missing': { priority: 'medium', effort: 'small', fix: 'create_sitemap', title: 'Publish an XML sitemap', how: 'Generate a sitemap and reference it from robots.txt so Google can discover every URL.', siteLevel: true },
    'robots.missing': { priority: 'low', effort: 'trivial', fix: 'create_robots_txt', title: 'Add a robots.txt', how: 'Add one that points at your sitemap, even if it disallows nothing.', siteLevel: true },
    'schema.parse_error': { priority: 'medium', effort: 'trivial', fix: 'fix_jsonld', title: 'Fix malformed JSON-LD on {n}', how: 'Malformed JSON-LD is silently discarded, so you get no rich results from it at all.' },
    'schema.incomplete': { priority: 'medium', effort: 'small', fix: 'complete_schema', title: 'Complete structured data on {n}', how: 'Add the required properties so the markup becomes eligible for rich results.' },
    'schema.missing': { priority: 'low', effort: 'small', fix: 'add_schema', title: 'Add structured data to {n}', how: 'Pick the schema type matching each page to compete for rich results.' },
    'hreflang.no_return_link': { priority: 'high', effort: 'small', fix: 'fix_hreflang', title: 'Fix non-reciprocal hreflang on {n}', how: 'One-way hreflang is ignored entirely, so the whole language cluster stops working.' },
    'hreflang.invalid_code': { priority: 'high', effort: 'trivial', fix: 'fix_hreflang', title: 'Correct invalid hreflang codes on {n}', how: 'An invalid code invalidates that annotation.' },
    'links.few_inbound': { priority: 'medium', effort: 'small', fix: 'add_internal_link', title: 'Strengthen internal linking to {n}', how: 'Add contextual links from related, higher-authority pages.' },
    'links.deep_page': { priority: 'medium', effort: 'medium', fix: 'reduce_crawl_depth', title: 'Reduce crawl depth for {n}', how: 'Link from a shallower hub so these sit within 3 clicks of the homepage.' },
    'links.to_redirect': { priority: 'low', effort: 'trivial', fix: 'update_internal_link', title: 'Point internal links straight at their destination on {n}', how: 'Linking via a redirect wastes a hop and a little link equity.' },
    'links.generic_anchor': { priority: 'low', effort: 'small', fix: 'improve_anchor_text', title: 'Replace generic anchor text on {n}', how: '"Click here" passes no keyword signal to the target page.' },
    'security.http_link': { priority: 'medium', effort: 'small', fix: 'fix_mixed_content', title: 'Fix mixed content on {n}', how: 'HTTP resources on an HTTPS page get blocked by browsers.' },
  };

  for (const [rule, list] of byRule) {
    const m = meta[rule];
    if (!m) continue;
    const first = list[0]!;
    // Impact scales with how much of the site is affected, but a site-level rule
    // is a single fixed-size problem so it gets no coverage bonus.
    const coverage = m.siteLevel ? 0 : clamp(list.length / Math.max(report.pages_audited, 8), 0, 1);
    const base = first.severity === 'error' ? 70 : first.severity === 'warning' ? 45 : 22;
    const impact = clamp(base + coverage * 30, 0, 100);
    const examples = list.slice(0, 8).map((i) => i.url);

    actions.push(
      action({
        id: `audit.${rule}`,
        priority: m.priority,
        effort: m.effort,
        category: 'technical-seo',
        title: m.title.replace('{n}', describeCount(list.length)),
        detail: m.siteLevel
          ? m.how
          : `${m.how} Affects ${list.length} of ${report.pages_audited} pages crawled.`,
        target: list.length === 1 ? first.url : undefined,
        impact_score: round(impact, 1),
        evidence: {
          rule,
          affected_pages: list.length,
          examples,
          ...(list.length === 1 && first.evidence ? first.evidence : {}),
        },
        fix: { type: m.fix, affected: examples },
      }),
    );
  }

  // The single most useful architectural signal, and it has no per-page rule.
  const deep = ctx.pages.filter((p) => p.depth > LIMITS.MAX_DEPTH).length;
  if (deep > ctx.pages.length * 0.3 && ctx.pages.length > 20) {
    actions.push(
      action({
        id: 'audit.architecture.too_deep',
        priority: 'high',
        effort: 'large',
        category: 'technical-seo',
        title: `Flatten site architecture: ${deep} pages sit more than ${LIMITS.MAX_DEPTH} clicks deep`,
        detail:
          'Crawl depth strongly predicts how often Google recrawls a page and how much internal PageRank it receives. ' +
          'Add hub pages or category links so important pages sit within 3 clicks of the homepage.',
        impact_score: 78,
        evidence: { deep_pages: deep, total_pages: ctx.pages.length },
        fix: { type: 'add_hub_pages', affected: [] },
      }),
    );
  }

  return actions;
}

type Effort2 = 'trivial' | 'small' | 'medium' | 'large';

function describeCount(n: number): string {
  return n === 1 ? '1 page' : `${n} pages`;
}
