/** URL handling. Getting this wrong quietly corrupts every downstream metric. */

/**
 * Multi-part public suffixes we need to handle so that `example.co.uk` is read
 * as one registrable domain rather than `co.uk`. Not the full PSL — that's a
 * 15k-line dependency — but it covers the suffixes that actually show up in
 * commercial SEO work.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.za', 'org.za', 'net.za', 'web.za', 'gov.za',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'net.hk', 'gov.hk',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl',
  'co.il', 'org.il', 'net.il', 'gov.il',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw',
  'co.id', 'or.id', 'go.id', 'web.id',
  'com.my', 'net.my', 'org.my', 'gov.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua',
  'com.es', 'com.pt', 'com.it', 'com.de', 'com.fr',
  'co.th', 'in.th', 'go.th',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com',
]);

/** Tracking parameters that never change the content served. Stripped on normalize. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'dclid', 'twclid', 'igshid', 'ttclid', 'yclid',
  'mc_cid', 'mc_eid', 'ref', 'referrer', '_hsenc', '_hsmi', 'hsa_acc', 'hsa_cam',
  'campaignid', 'adgroupid', 'sscid', 'irclickid', 'vero_id', 'wickedid',
]);

/** Matches any RFC-3986 scheme prefix, e.g. "mailto:", "tel:", "javascript:". */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function parseUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed);
    // A bare host like "example.com" is a convenience we accept. Anything with
    // some *other* scheme is not a web page and must be rejected — blindly
    // prefixing https:// turned "mailto:x@y.com" into the plausible-looking
    // "https://mailto:x@y.com/", which would then be crawled or stored as a
    // canonical target.
    if (HAS_SCHEME.test(trimmed)) return null;
    return new URL(`https://${trimmed}`);
  } catch {
    return null;
  }
}

/**
 * Canonical string form used as the identity of a page everywhere in this
 * codebase (cache keys, link graph nodes, dedupe). Two URLs that serve the same
 * content must normalize to the same string or metrics double-count.
 */
export function normalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(input, base) : (parseUrl(input) as URL);
    if (!u) return null;
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');

  // Default ports are noise.
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
    u.port = '';
  }

  for (const p of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
  }
  u.searchParams.sort();

  // "/index.html" and "/" are the same page to a search engine.
  u.pathname = u.pathname.replace(/\/(index|default)\.(html?|php|aspx?)$/i, '/');
  if (u.pathname === '') u.pathname = '/';
  // Collapse duplicate slashes, which routinely appear from bad template concatenation.
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');

  // The trailing slash is preserved deliberately.
  //
  // Stripping it looks like harmless tidying and is actively destructive: most
  // static-site hosts 308-redirect `/docs` to `/docs/`, so a stripped URL means
  // we request the non-canonical form and then report the server's own
  // correction as a redirect problem. On a real crawl of an Eleventy site this
  // manufactured 19 phantom redirect chains and 550 phantom
  // "link points at a redirect" issues, which swamped every genuine finding.
  //
  // Deduplication of the two forms happens at the crawler level instead, keyed
  // on the URL each one actually resolves to.
  return u.toString();
}

/**
 * The trailing-slash-insensitive identity of a URL.
 *
 * Only for grouping and dedupe — never fetch this, fetch the real URL.
 */
export function slashInsensitiveKey(url: string): string {
  const u = parseUrl(url);
  if (!u) return url;
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : u.pathname;
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/** The registrable domain: "blog.example.co.uk" -> "example.co.uk". */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

export function domainOf(url: string): string {
  const u = parseUrl(url);
  return u ? registrableDomain(u.hostname) : '';
}

/** Same registrable domain — subdomains count as internal, matching how crawlers treat a "site". */
export function sameSite(a: string, b: string): boolean {
  const da = domainOf(a);
  return da !== '' && da === domainOf(b);
}

/** Path segments, no empties. Used for depth and URL-structure rules. */
export function pathSegments(url: string): string[] {
  const u = parseUrl(url);
  if (!u) return [];
  return u.pathname.split('/').filter(Boolean);
}

/** Turn a slug or path into readable words: "/blog/best-crm-2026" -> "best crm 2026". */
export function slugToWords(url: string): string {
  const segs = pathSegments(url);
  const last = segs[segs.length - 1] ?? '';
  return last
    .replace(/\.(html?|php|aspx?)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Build a URL-safe slug from arbitrary text. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const NON_HTML_EXT =
  /\.(jpg|jpeg|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mkv|mp3|wav|ogg|flac|pdf|zip|gz|tar|rar|7z|dmg|exe|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|atom|csv|xlsx?|docx?|pptx?)$/i;

/** Cheap pre-filter so the crawler doesn't waste requests on assets. */
export function looksLikeHtml(url: string): boolean {
  const u = parseUrl(url);
  if (!u) return false;
  return !NON_HTML_EXT.test(u.pathname);
}
