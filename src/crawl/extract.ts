import * as cheerio from 'cheerio';
import type { PageData, PageLink, ImageRef, Heading } from '../core/types.js';
import { normalizeUrl, sameSite } from '../core/url.js';
import { tokenize } from '../core/text.js';

/**
 * HTML -> structured page model.
 *
 * Everything an audit rule or content scorer needs is derived here, once, so
 * the raw HTML never has to be re-parsed downstream. Body-text extraction
 * strips chrome (nav, footer, cookie banners) because leaving it in inflates
 * word counts and makes every page on a site look near-duplicate.
 */

/** Elements that never contain page content and would pollute text extraction. */
const BOILERPLATE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed',
  'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
  '[aria-hidden="true"]',
  '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.header', '.breadcrumb', '.breadcrumbs',
  '.cookie', '.cookie-banner', '.cookie-consent', '.gdpr',
  '.skip-link', '.screen-reader-text', '.sr-only', '.visually-hidden',
  '#nav', '#navbar', '#menu', '#sidebar', '#footer', '#header', '#comments',
];

/** Preferred containers for the actual article body, most specific first. */
const CONTENT_SELECTORS = [
  'main article',
  'article',
  'main',
  '[role="main"]',
  '#content',
  '.content',
  '.post-content',
  '.entry-content',
  '.article-body',
  '.prose',
];

export interface ExtractInput {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  headers: Record<string, string>;
  bytes: number;
  fetchMs: number;
  redirectChain: string[];
  depth: number;
}

export function extractPage(input: ExtractInput): PageData {
  const $ = cheerio.load(input.html);
  const base = $('base[href]').attr('href');
  const baseUrl = base ? (normalizeUrl(base, input.finalUrl) ?? input.finalUrl) : input.finalUrl;

  const title = text($('head > title').first()) || text($('title').first()) || null;
  const metaDescription = attr($, 'meta[name="description"]', 'content');
  const metaRobots =
    attr($, 'meta[name="robots"]', 'content') ?? attr($, 'meta[name="googlebot"]', 'content');
  const canonicalRaw = $('link[rel="canonical"]').first().attr('href');
  const canonical = canonicalRaw ? normalizeUrl(canonicalRaw, baseUrl) : null;
  const lang = $('html').attr('lang')?.trim() ?? null;

  const headings: Heading[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const tag = (el as { tagName?: string }).tagName ?? 'h1';
    const level = Number(tag.slice(1));
    const t = text($(el));
    if (t) headings.push({ level, text: t });
  });
  const h1 = headings.filter((h) => h.level === 1).map((h) => h.text);

  const links = extractLinks($, baseUrl);
  const images = extractImages($, baseUrl);
  const jsonld = extractJsonLd($);
  const social = extractSocial($);
  const hreflang = extractHreflang($, baseUrl);

  const bodyText = extractText($);
  const wordCount = tokenize(bodyText).length;

  return {
    url: input.url,
    final_url: input.finalUrl,
    status: input.status,
    redirect_chain: input.redirectChain,
    content_type: input.headers['content-type'] ?? null,
    bytes: input.bytes,
    fetch_ms: input.fetchMs,
    title,
    meta_description: metaDescription,
    meta_robots: metaRobots,
    canonical,
    lang,
    headings,
    h1,
    text: bodyText,
    word_count: wordCount,
    links,
    images,
    jsonld,
    social,
    hreflang,
    depth: input.depth,
  };
}

/** Structural type so this works for any cheerio selection without fighting generics. */
function text(el: { text(): string }): string {
  return el.text().replace(/\s+/g, ' ').trim();
}

function attr($: cheerio.CheerioAPI, selector: string, name: string): string | null {
  const v = $(selector).first().attr(name);
  return v ? v.trim() : null;
}

function extractLinks($: cheerio.CheerioAPI, baseUrl: string): PageLink[] {
  const seen = new Set<string>();
  const links: PageLink[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const trimmed = href.trim();
    if (
      trimmed === '' ||
      trimmed.startsWith('#') ||
      /^(mailto|tel|javascript|sms|ftp|data):/i.test(trimmed)
    ) {
      return;
    }
    const abs = normalizeUrl(trimmed, baseUrl);
    if (!abs) return;
    const rel = $(el).attr('rel')?.toLowerCase() ?? null;
    const anchor = text($(el)) || $(el).find('img[alt]').first().attr('alt') || '';
    // Dedupe by target+anchor: the same nav link on every page is one edge,
    // but two different anchors to one page is genuinely useful signal.
    const key = `${abs}|${anchor}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({
      url: abs,
      anchor: anchor.slice(0, 300),
      rel,
      internal: sameSite(abs, baseUrl),
      nofollow: rel ? /\bnofollow\b/.test(rel) : false,
    });
  });
  return links;
}

function extractImages($: cheerio.CheerioAPI, baseUrl: string): ImageRef[] {
  const images: ImageRef[] = [];
  $('img').each((_, el) => {
    const $el = $(el);
    // Lazy-loaded images put the real URL in a data attribute; a naive reader
    // reports them all as broken or missing.
    const src =
      $el.attr('src') ??
      $el.attr('data-src') ??
      $el.attr('data-lazy-src') ??
      $el.attr('data-original') ??
      $el.attr('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
    if (!src || src.startsWith('data:')) return;
    const abs = normalizeUrl(src, baseUrl);
    if (!abs) return;
    const w = Number($el.attr('width'));
    const h = Number($el.attr('height'));
    images.push({
      src: abs,
      alt: $el.attr('alt') ?? null,
      width: Number.isFinite(w) ? w : null,
      height: Number.isFinite(h) ? h : null,
      loading: $el.attr('loading') ?? null,
    });
  });
  return images;
}

function extractJsonLd($: cheerio.CheerioAPI): unknown[] {
  const out: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      // A @graph wrapper is extremely common; flatten it so consumers don't
      // have to special-case two shapes.
      if (parsed && typeof parsed === 'object' && '@graph' in parsed) {
        const graph = (parsed as { '@graph': unknown })['@graph'];
        if (Array.isArray(graph)) out.push(...graph);
        else out.push(parsed);
      } else if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      out.push({ __parse_error: raw.slice(0, 200) });
    }
  });
  return out;
}

function extractSocial($: cheerio.CheerioAPI): Record<string, string> {
  const social: Record<string, string> = {};
  $('meta[property^="og:"], meta[name^="twitter:"], meta[property^="twitter:"]').each((_, el) => {
    const key = $(el).attr('property') ?? $(el).attr('name');
    const value = $(el).attr('content');
    if (key && value) social[key.toLowerCase()] = value.trim();
  });
  return social;
}

function extractHreflang($: cheerio.CheerioAPI, baseUrl: string): Array<{ lang: string; href: string }> {
  const out: Array<{ lang: string; href: string }> = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = $(el).attr('hreflang');
    const href = $(el).attr('href');
    if (!lang || !href) return;
    const abs = normalizeUrl(href, baseUrl);
    if (abs) out.push({ lang: lang.toLowerCase(), href: abs });
  });
  return out;
}

/**
 * Main-content text.
 *
 * Strategy: strip known boilerplate, then prefer an explicit content container.
 * Fall back to <body> only if no container yields meaningful text, because a
 * bad container pick (an empty <main>) is worse than including some chrome.
 */
function extractText($: cheerio.CheerioAPI): string {
  const $c = cheerio.load($.html());
  $c(BOILERPLATE_SELECTORS.join(', ')).remove();

  for (const selector of CONTENT_SELECTORS) {
    const el = $c(selector).first();
    if (el.length === 0) continue;
    const t = normalizeWhitespace(el.text());
    if (tokenize(t).length >= 50) return t;
  }
  return normalizeWhitespace($c('body').text());
}

function normalizeWhitespace(s: string): string {
  return s
    // Non-breaking and other exotic spaces are rampant in CMS output and would
    // otherwise survive into token counts glued to adjacent words.
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

/** Signals that only matter for performance rules; computed on demand. */
export interface PerfSignals {
  render_blocking_css: number;
  render_blocking_js: number;
  inline_style_bytes: number;
  inline_script_bytes: number;
  images_without_dimensions: number;
  images_without_lazy: number;
  total_dom_nodes: number;
}

export function extractPerfSignals(html: string): PerfSignals {
  const $ = cheerio.load(html);
  let renderBlockingCss = 0;
  $('head link[rel="stylesheet"]').each((_, el) => {
    const media = $(el).attr('media');
    // media="print" and non-matching media queries don't block render.
    if (!media || media === 'all' || media === 'screen') renderBlockingCss++;
  });
  let renderBlockingJs = 0;
  $('head script[src]').each((_, el) => {
    if (!$(el).attr('async') && !$(el).attr('defer') && $(el).attr('type') !== 'module') {
      renderBlockingJs++;
    }
  });
  let inlineStyleBytes = 0;
  $('style').each((_, el) => {
    inlineStyleBytes += Buffer.byteLength($(el).contents().text());
  });
  let inlineScriptBytes = 0;
  $('script:not([src])').each((_, el) => {
    inlineScriptBytes += Buffer.byteLength($(el).contents().text());
  });
  let noDims = 0;
  let noLazy = 0;
  const imgs = $('img');
  imgs.each((i, el) => {
    const $el = $(el);
    if (!$el.attr('width') || !$el.attr('height')) noDims++;
    // The first couple of images are above the fold; lazy-loading them hurts LCP.
    if (i >= 2 && $el.attr('loading') !== 'lazy') noLazy++;
  });
  return {
    render_blocking_css: renderBlockingCss,
    render_blocking_js: renderBlockingJs,
    inline_style_bytes: inlineStyleBytes,
    inline_script_bytes: inlineScriptBytes,
    images_without_dimensions: noDims,
    images_without_lazy: noLazy,
    total_dom_nodes: $('*').length,
  };
}
