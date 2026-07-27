import type { SerpData } from '../core/types.js';
import { clamp, round, contentTokens } from '../core/text.js';
import { domainOf } from '../core/url.js';

/**
 * Keyword difficulty estimation.
 *
 * Ahrefs computes KD from the backlink profiles of the top-ranking pages.
 * Semrush blends that with SERP features and domain authority. We can do a
 * credible version of both — but only when a SERP provider is configured.
 *
 * When one isn't, we still return a number, and we are loud about the fact that
 * it's a weak lexical estimate. A silently-guessed difficulty score is worse
 * than no score: an agent will plan a whole content calendar around it.
 */

export type DifficultyMethod = 'serp+authority' | 'serp' | 'lexical';

export interface DifficultyEstimate {
  /** 0-100. Higher is harder. */
  difficulty: number;
  method: DifficultyMethod;
  /** 0-1. Treat anything under 0.5 as directional only. */
  confidence: number;
  /** The observations behind the number, so the agent can sanity-check it. */
  factors: Record<string, number | string | boolean>;
}

/**
 * Domains that rank for almost everything on brand strength alone. Their
 * presence in a SERP tells you how contested the query is far more than an
 * average authority score would.
 */
const AUTHORITY_DOMAINS = new Set([
  'wikipedia.org', 'youtube.com', 'amazon.com', 'reddit.com', 'linkedin.com', 'facebook.com',
  'instagram.com', 'x.com', 'twitter.com', 'quora.com', 'medium.com', 'forbes.com',
  'nytimes.com', 'theguardian.com', 'bbc.com', 'cnn.com', 'businessinsider.com',
  'techcrunch.com', 'github.com', 'stackoverflow.com', 'apple.com', 'google.com',
  'microsoft.com', 'hubspot.com', 'salesforce.com', 'shopify.com', 'wix.com',
  'squarespace.com', 'wordpress.com', 'canva.com', 'zapier.com', 'notion.so',
  'investopedia.com', 'healthline.com', 'webmd.com', 'mayoclinic.org', 'nih.gov',
  'gov.uk', 'usa.gov', 'walmart.com', 'ebay.com', 'etsy.com', 'yelp.com', 'tripadvisor.com',
]);

/**
 * SERP-based difficulty, optionally refined with per-result authority metrics.
 *
 * `authority` maps a domain to a 0-100 authority score (DR/DA equivalent) when a
 * backlinks provider is available.
 */
export function difficultyFromSerp(
  serp: SerpData,
  authority?: Map<string, number>,
): DifficultyEstimate {
  const top10 = serp.results.slice(0, 10);
  if (top10.length === 0) {
    return {
      difficulty: 0,
      method: 'serp',
      confidence: 0.2,
      factors: { results: 0, note: 'empty SERP' },
    };
  }

  const domains = top10.map((r) => domainOf(r.url));
  const bigBrands = domains.filter((d) => AUTHORITY_DOMAINS.has(d)).length;
  const uniqueDomains = new Set(domains).size;

  // Homepages ranking means the query is treated as navigational/brand-level and
  // is therefore very hard to break into with a subpage.
  const homepages = top10.filter((r) => {
    try {
      return new URL(r.url).pathname.replace(/\/$/, '') === '';
    } catch {
      return false;
    }
  }).length;

  // Forums and UGC in the top 10 means Google is unsure — genuinely easier.
  const ugc = domains.filter((d) =>
    ['reddit.com', 'quora.com', 'stackexchange.com', 'stackoverflow.com', 'medium.com'].includes(d),
  ).length;

  let score = 12;
  score += bigBrands * 6.5;
  score += homepages * 3.2;
  // A SERP dominated by one site (uniqueDomains low) is usually a brand query.
  score += (10 - uniqueDomains) * 1.5;
  // Each SERP feature pushes organic results down, making the click harder to win.
  score += serp.features.length * 2;
  score -= ugc * 4.5;

  let method: DifficultyMethod = 'serp';
  let confidence = 0.6;

  if (authority && authority.size > 0) {
    const scores = domains.map((d) => authority.get(d)).filter((v): v is number => typeof v === 'number');
    if (scores.length >= 3) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const min = Math.min(...scores);
      // Real backlink authority is the strongest available signal, so once we
      // have it, let it dominate rather than merely nudge.
      score = score * 0.35 + avg * 0.55 + (100 - (100 - min)) * 0.1;
      method = 'serp+authority';
      confidence = 0.85;
      return {
        difficulty: round(clamp(score, 0, 100), 1),
        method,
        confidence,
        factors: {
          avg_authority: round(avg, 1),
          weakest_authority: round(min, 1),
          big_brands_in_top10: bigBrands,
          serp_features: serp.features.length,
          ugc_results: ugc,
        },
      };
    }
  }

  return {
    difficulty: round(clamp(score, 0, 100), 1),
    method,
    confidence,
    factors: {
      big_brands_in_top10: bigBrands,
      homepages_in_top10: homepages,
      unique_domains: uniqueDomains,
      serp_features: serp.features.length,
      ugc_results: ugc,
    },
  };
}

/**
 * Fallback estimate with no SERP access at all.
 *
 * Purely lexical: shorter, more commercial, more generic phrases are harder.
 * This correlates with real difficulty well enough to sort a keyword list, and
 * not nearly well enough to make a go/no-go call on a single keyword — which is
 * exactly what `confidence: 0.35` and `method: 'lexical'` are there to say.
 */
export function difficultyFromLexical(keyword: string): DifficultyEstimate {
  const tokens = contentTokens(keyword);
  const words = keyword.trim().split(/\s+/).length;

  // Head terms are contested; long tails are not.
  let score = clamp(78 - (words - 1) * 11, 12, 82);

  const kw = keyword.toLowerCase();
  // High-commercial modifiers attract every affiliate site on the internet.
  if (/\b(best|top|cheapest|reviews?)\b/.test(kw)) score += 9;
  if (/\b(software|tool|tools|app|platform|service)\b/.test(kw)) score += 5;
  if (/\b(vs|versus|alternative|alternatives)\b/.test(kw)) score -= 6;
  // Questions and long-tail informational queries are the easy end of the market.
  if (/^(what|why|how|when|where|who|can|does|is|are)\b/.test(kw)) score -= 8;
  if (/\b(near me|in \w+)\b/.test(kw)) score -= 5;
  if (words >= 6) score -= 6;
  // A very short single word is almost always a brand or a category monster.
  if (tokens.length === 1) score += 8;

  return {
    difficulty: round(clamp(score, 1, 95), 1),
    method: 'lexical',
    confidence: 0.35,
    factors: {
      words,
      content_tokens: tokens.length,
      note: 'Lexical estimate only — no SERP data available. Configure a SERP provider for a real difficulty score.',
    },
  };
}

/**
 * How realistic is it for *this* domain to rank, given its authority?
 *
 * Semrush calls this Personal Keyword Difficulty, and it's the single most
 * useful adjustment for an agent: an absolute KD of 45 is trivial for a DR 80
 * site and hopeless for a brand-new one.
 */
export function personalizeDifficulty(
  difficulty: number,
  siteAuthority: number | null,
): { personal_difficulty: number; verdict: 'easy' | 'realistic' | 'stretch' | 'unrealistic'; note: string } {
  if (siteAuthority === null) {
    return {
      personal_difficulty: difficulty,
      verdict: difficulty < 20 ? 'easy' : difficulty < 40 ? 'realistic' : difficulty < 65 ? 'stretch' : 'unrealistic',
      note: 'No domain authority available; using absolute difficulty. Configure a backlinks provider for a site-relative score.',
    };
  }
  // A site meaningfully stronger than the SERP average finds it easier; weaker,
  // harder. The gap matters more at the extremes than in the middle.
  const gap = siteAuthority - difficulty;
  const personal = clamp(difficulty - gap * 0.55, 0, 100);
  const verdict =
    personal < 20 ? 'easy' : personal < 40 ? 'realistic' : personal < 65 ? 'stretch' : 'unrealistic';
  return {
    personal_difficulty: round(personal, 1),
    verdict,
    note:
      gap >= 0
        ? `Your domain authority (${siteAuthority}) exceeds the SERP difficulty (${difficulty}), so this is ${verdict}.`
        : `Your domain authority (${siteAuthority}) is below the SERP difficulty (${difficulty}); expect to need links or a much better page.`,
  };
}
