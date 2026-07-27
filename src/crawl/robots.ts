import { httpFetch } from '../core/http.js';
import { cached, cacheKey, TTL } from '../core/cache.js';
import { normalizeUrl } from '../core/url.js';

/**
 * robots.txt parsing.
 *
 * We obey it by default. An agent crawling on someone's behalf can trivially
 * get an IP or a whole office blocked, and "the model decided to ignore
 * robots.txt" is not a defensible answer. Opt-out exists (SEO_AGENT_IGNORE_ROBOTS)
 * because auditing your *own* staging site behind a blanket Disallow is a real
 * and legitimate case.
 */

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export interface RobotsTxt {
  exists: boolean;
  /** Rules for the most specific matching user-agent group. */
  rules: RobotsRule[];
  sitemaps: string[];
  crawlDelay: number | null;
  raw: string;
}

const EMPTY: RobotsTxt = { exists: false, rules: [], sitemaps: [], crawlDelay: null, raw: '' };

export function parseRobots(text: string, userAgent: string): RobotsTxt {
  const uaLower = userAgent.toLowerCase();
  const groups: Array<{ agents: string[]; rules: RobotsRule[]; crawlDelay: number | null }> = [];
  const sitemaps: string[] = [];

  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') {
      const n = normalizeUrl(value);
      if (n) sitemaps.push(n);
      continue;
    }
    if (!current) continue;
    if (field === 'allow') current.rules.push({ type: 'allow', path: value });
    else if (field === 'disallow') current.rules.push({ type: 'disallow', path: value });
    else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }

  // Most specific match wins: exact UA token > substring > wildcard.
  let best: (typeof groups)[number] | undefined;
  let bestScore = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      let score = -1;
      if (a === '*') score = 0;
      else if (uaLower.includes(a)) score = a.length;
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
  }

  return {
    exists: true,
    rules: best?.rules ?? [],
    sitemaps,
    crawlDelay: best?.crawlDelay ?? null,
    raw: text,
  };
}

/**
 * Longest-match-wins, with Allow beating Disallow at equal length — the rule
 * Google actually implements, and the reason naive parsers over-block.
 */
export function isAllowed(robots: RobotsTxt, url: string): boolean {
  if (!robots.exists || robots.rules.length === 0) return true;
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return true;
  }

  let bestLen = -1;
  let allowed = true;
  for (const rule of robots.rules) {
    if (rule.path === '') {
      // "Disallow:" with an empty value means allow everything.
      if (rule.type === 'disallow' && bestLen < 0) allowed = true;
      continue;
    }
    if (!matchesPattern(path, rule.path)) continue;
    const len = rule.path.length;
    if (len > bestLen || (len === bestLen && rule.type === 'allow')) {
      bestLen = len;
      allowed = rule.type === 'allow';
    }
  }
  return allowed;
}

/** Supports the `*` and `$` wildcards Google honours. */
function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('$')) return path.startsWith(pattern);
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

export async function fetchRobots(origin: string, userAgent: string): Promise<RobotsTxt> {
  const key = cacheKey('robots', { origin, ua: userAgent });
  const { value } = await cached<RobotsTxt>(key, TTL.robots, async () => {
    try {
      const res = await httpFetch(`${origin}/robots.txt`, { retries: 1, timeoutMs: 10_000, maxBytes: 512 * 1024 });
      // A 4xx means "no restrictions"; a 5xx conservatively means "stay out",
      // but we treat it as open because blocking an entire audit on a flaky
      // robots endpoint is worse in practice.
      if (res.status >= 400) return EMPTY;
      // Soft 404: plenty of SPA hosts answer /robots.txt with 200 and their HTML
      // error page. Parsing that yields garbage rules, so reject it as absent.
      if (/^\s*<(!doctype|html)/i.test(res.body)) return EMPTY;
      const ct = res.headers['content-type'] ?? '';
      if (ct && !ct.includes('text/plain') && !ct.includes('text/') && !ct.includes('octet-stream')) {
        return EMPTY;
      }
      return parseRobots(res.body, userAgent);
    } catch {
      return EMPTY;
    }
  });
  return value;
}
