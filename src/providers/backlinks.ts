import { fetchJson } from '../core/http.js';
import { cached, cacheKey, TTL } from '../core/cache.js';
import { reserve, record } from '../core/budget.js';
import { providerNotConfigured, SeoAgentError } from '../core/errors.js';
import { dataForSeoAuthHeader } from './serp.js';
import { domainOf } from '../core/url.js';
import type { Config } from '../config.js';

/**
 * Backlink and authority data.
 *
 * There is no free path to a real backlink index. Common Crawl publishes crawl
 * data but no reverse-link index, so building one means processing petabytes of
 * WARC files — not something to do inside a tool call. So this is provider-gated,
 * with two tiers:
 *
 * - DataForSEO: a full index — referring domains, anchor text, link gap.
 * - Open PageRank: free tier, domain authority scores only. Cheap way to make
 *   `personalizeDifficulty` work without a paid subscription, which is most of
 *   the practical value of an authority metric for planning purposes.
 */

export interface DomainAuthority {
  domain: string;
  /** 0-100, Domain Rating / Authority equivalent. */
  authority: number | null;
  backlinks: number | null;
  referring_domains: number | null;
  /** Global traffic-independent rank, where lower is stronger. */
  rank: number | null;
  source: string;
}

export interface Backlink {
  url_from: string;
  url_to: string;
  domain_from: string;
  anchor: string;
  /** Authority of the linking page, when available. */
  page_authority: number | null;
  domain_authority: number | null;
  nofollow: boolean;
  first_seen: string | null;
  last_seen: string | null;
  /** "text", "image", "redirect", "canonical". */
  link_type: string;
}

export interface BacklinksProvider {
  readonly name: string;
  readonly costPerCall: number;
  authority(domains: string[]): Promise<DomainAuthority[]>;
  backlinks?(target: string, limit: number): Promise<Backlink[]>;
  /** Domains linking to competitors but not to us — Ahrefs' Link Intersect. */
  linkGap?(target: string, competitors: string[], limit: number): Promise<Array<{ domain: string; authority: number | null; links_to: string[] }>>;
}

// ---------------------------------------------------------------------------
// Open PageRank (free tier, authority only)
// ---------------------------------------------------------------------------

export interface OprResponse {
  status_code?: number;
  response?: Array<{
    domain?: string;
    page_rank_integer?: number;
    page_rank_decimal?: number;
    rank?: string | number | null;
    status_code?: number;
  }>;
  error?: string;
}

/**
 * Open PageRank response -> DomainAuthority[].
 *
 * The scaling is the part worth testing. Open PageRank reports 0-10 while
 * DataForSEO reports 0-1000 and every consumer here expects 0-100, so each
 * provider needs its own conversion. Get one wrong and difficulty
 * personalisation silently ranks every keyword as trivial or impossible —
 * plausible-looking numbers, no error.
 */
export function normalizeOpenPageRankResponse(json: OprResponse): DomainAuthority[] {
  const out: DomainAuthority[] = [];
  for (const r of json.response ?? []) {
    if (!r.domain) continue;
    const decimal = r.page_rank_decimal ?? r.page_rank_integer ?? null;
    out.push({
      domain: r.domain,
      // 0-10 -> 0-100, keeping one decimal place.
      authority: decimal !== null ? Math.round(decimal * 10 * 10) / 10 : null,
      backlinks: null,
      referring_domains: null,
      rank: r.rank !== null && r.rank !== undefined ? Number(r.rank) : null,
      source: 'openpagerank',
    });
  }
  return out;
}

class OpenPageRankProvider implements BacklinksProvider {
  readonly name = 'openpagerank';
  // Zero billable units: the Open PageRank free tier has a daily quota and no
  // billing. SEO_AGENT_BUDGET caps money, so charging against it here made
  // SEO_AGENT_BUDGET=0 — the documented way to stay free — block the free
  // provider. Calls are still recorded, so `seo_usage` shows the count.
  readonly costPerCall = 0;

  constructor(private readonly apiKey: string) {}

  async authority(domains: string[]): Promise<DomainAuthority[]> {
    const out: DomainAuthority[] = [];
    // The API accepts up to 100 domains per request.
    for (let i = 0; i < domains.length; i += 100) {
      const batch = domains.slice(i, i + 100);
      const params = batch.map((d, idx) => `domains%5B${idx}%5D=${encodeURIComponent(d)}`).join('&');
      const json = await fetchJson<OprResponse>(`https://openpagerank.com/api/v1.0/getPageRank?${params}`, {
        headers: { 'API-OPR': this.apiKey },
        retries: 2,
        timeoutMs: 20_000,
      });
      if (json.error) {
        throw new SeoAgentError('PROVIDER_ERROR', `Open PageRank: ${json.error}`, 'Check OPENPAGERANK_API_KEY.');
      }
      out.push(...normalizeOpenPageRankResponse(json));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// DataForSEO backlinks
// ---------------------------------------------------------------------------

interface DfsTaskResponse<T> {
  status_code?: number;
  status_message?: string;
  tasks?: Array<{ status_code?: number; status_message?: string; result?: T[] }>;
}

export interface DfsSummaryItem {
  target?: string;
  rank?: number;
  backlinks?: number;
  referring_domains?: number;
  referring_main_domains?: number;
  broken_backlinks?: number;
  referring_links_types?: Record<string, number>;
}

export interface DfsBacklinkItem {
  url_from?: string;
  url_to?: string;
  domain_from?: string;
  anchor?: string;
  page_from_rank?: number;
  domain_from_rank?: number;
  dofollow?: boolean;
  first_seen?: string;
  last_seen?: string;
  item_type?: string;
}

/** DataForSEO backlink summary -> DomainAuthority. Its `rank` is 0-1000. */
export function normalizeDfsSummary(domain: string, item: DfsSummaryItem | undefined): DomainAuthority {
  return {
    domain,
    // 0-1000 -> 0-100.
    authority: typeof item?.rank === 'number' ? Math.round((item.rank / 10) * 10) / 10 : null,
    backlinks: item?.backlinks ?? null,
    // referring_main_domains excludes subdomains and is the figure SEO tools
    // report as "referring domains"; fall back only if it is absent.
    referring_domains: item?.referring_main_domains ?? item?.referring_domains ?? null,
    rank: item?.rank ?? null,
    source: 'dataforseo',
  };
}

/** DataForSEO backlink rows -> Backlink[]. `dofollow: false` means nofollow. */
export function normalizeDfsBacklinks(items: DfsBacklinkItem[], target: string): Backlink[] {
  const out: Backlink[] = [];
  for (const it of items) {
    if (!it.url_from) continue;
    out.push({
      url_from: it.url_from,
      url_to: it.url_to ?? target,
      domain_from: it.domain_from ?? domainOf(it.url_from),
      anchor: it.anchor ?? '',
      page_authority: typeof it.page_from_rank === 'number' ? Math.round(it.page_from_rank / 10) : null,
      domain_authority: typeof it.domain_from_rank === 'number' ? Math.round(it.domain_from_rank / 10) : null,
      nofollow: it.dofollow === false,
      first_seen: it.first_seen ?? null,
      last_seen: it.last_seen ?? null,
      link_type: it.item_type ?? 'text',
    });
  }
  return out;
}

class DataForSeoBacklinksProvider implements BacklinksProvider {
  readonly name = 'dataforseo';
  readonly costPerCall = 2;

  constructor(private readonly login: string, private readonly password: string) {}

  private headers() {
    return {
      authorization: dataForSeoAuthHeader(this.login, this.password),
      'content-type': 'application/json',
    };
  }

  private unwrap<T>(json: DfsTaskResponse<T>, what: string): T[] {
    const task = json.tasks?.[0];
    if (!task || (task.status_code ?? 0) >= 40000) {
      throw new SeoAgentError(
        'PROVIDER_ERROR',
        `DataForSEO ${what}: ${task?.status_message ?? json.status_message ?? 'unknown error'}`,
        'Verify DataForSEO credentials and account credit.',
      );
    }
    return task.result ?? [];
  }

  async authority(domains: string[]): Promise<DomainAuthority[]> {
    const out: DomainAuthority[] = [];
    // The summary endpoint handles one target per task, so fan out.
    for (const domain of domains) {
      const json = await fetchJson<DfsTaskResponse<DfsSummaryItem>>(
        'https://api.dataforseo.com/v3/backlinks/summary/live',
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify([{ target: domain, internal_list_limit: 1, backlinks_status_type: 'live' }]),
          retries: 1,
          timeoutMs: 45_000,
        },
      );
      out.push(normalizeDfsSummary(domain, this.unwrap(json, 'backlink summary')[0]));
    }
    return out;
  }

  async backlinks(target: string, limit: number): Promise<Backlink[]> {
    const json = await fetchJson<DfsTaskResponse<{ items?: DfsBacklinkItem[] }>>(
      'https://api.dataforseo.com/v3/backlinks/backlinks/live',
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify([
          {
            target,
            limit: Math.min(limit, 1000),
            mode: 'as_is',
            backlinks_status_type: 'live',
            order_by: ['domain_from_rank,desc'],
          },
        ]),
        retries: 1,
        timeoutMs: 60_000,
      },
    );
    const out: Backlink[] = [];
    for (const result of this.unwrap(json, 'backlinks')) {
      out.push(...normalizeDfsBacklinks(result.items ?? [], target));
    }
    return out;
  }

  async linkGap(
    target: string,
    competitors: string[],
    limit: number,
  ): Promise<Array<{ domain: string; authority: number | null; links_to: string[] }>> {
    // `targets` is a 1-indexed map; the API returns domains linking to any of
    // them, with an `intersections` object telling us which.
    const targets: Record<string, string> = {};
    competitors.slice(0, 10).forEach((c, i) => {
      targets[String(i + 1)] = c;
    });
    const json = await fetchJson<
      DfsTaskResponse<{
        items?: Array<{
          domain?: string;
          rank?: number;
          intersections?: Record<string, unknown>;
        }>;
      }>
    >('https://api.dataforseo.com/v3/backlinks/domain_intersection/live', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify([
        {
          targets,
          exclude_targets: [target],
          limit: Math.min(limit, 1000),
          order_by: ['rank,desc'],
          backlinks_status_type: 'live',
        },
      ]),
      retries: 1,
      timeoutMs: 60_000,
    });

    const out: LinkGapRow[] = [];
    for (const result of this.unwrap(json, 'link gap')) {
      out.push(...normalizeLinkGap(result.items ?? [], targets));
    }
    return out;
  }
}

export interface LinkGapRow {
  domain: string;
  authority: number | null;
  links_to: string[];
}

export interface DfsIntersectionItem {
  domain?: string;
  rank?: number;
  intersections?: Record<string, unknown>;
}

/**
 * DataForSEO domain-intersection rows -> link-gap prospects.
 *
 * The `intersections` object is keyed by the 1-indexed position of each target
 * in the request, so translating it back requires the same map that was sent.
 * Get that mapping wrong and every prospect reports an empty `links_to` — the
 * report still renders, it just silently loses the "which competitors link to
 * them" signal that makes it actionable.
 */
export function normalizeLinkGap(
  items: DfsIntersectionItem[],
  targets: Record<string, string>,
): LinkGapRow[] {
  const out: LinkGapRow[] = [];
  for (const it of items) {
    if (!it.domain) continue;
    out.push({
      domain: it.domain,
      // Same 0-1000 -> 0-100 conversion as the summary endpoint.
      authority: typeof it.rank === 'number' ? Math.round(it.rank / 10) : null,
      links_to: Object.keys(it.intersections ?? {})
        .map((k) => targets[k])
        .filter((v): v is string => Boolean(v)),
    });
  }
  return out;
}

export function createBacklinksProvider(cfg: Config): BacklinksProvider | null {
  if (cfg.backlinks.provider === 'dataforseo' && cfg.dataforseo) {
    return new DataForSeoBacklinksProvider(cfg.dataforseo.login, cfg.dataforseo.password);
  }
  if (cfg.backlinks.provider === 'openpagerank' && cfg.backlinks.openPageRankKey) {
    return new OpenPageRankProvider(cfg.backlinks.openPageRankKey);
  }
  return null;
}

export function requireBacklinksProvider(cfg: Config): BacklinksProvider {
  const p = createBacklinksProvider(cfg);
  if (!p) {
    throw providerNotConfigured(
      'backlink and domain authority data',
      ['DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD', 'OPENPAGERANK_API_KEY (free tier, authority scores only)'],
      'seo_audit_issues and seo_internal_links for internal link equity analysis, which needs no keys',
    );
  }
  return p;
}

/** Cached authority lookup. Authority barely moves, so the TTL is generous. */
export async function getAuthority(
  cfg: Config,
  domains: string[],
  opts: { bypassCache?: boolean } = {},
): Promise<{ authority: Map<string, DomainAuthority>; cost: number; provider: string }> {
  const provider = requireBacklinksProvider(cfg);
  const normalized = [...new Set(domains.map((d) => domainOf(d) || d.toLowerCase()))].filter(Boolean);

  const result = new Map<string, DomainAuthority>();
  const misses: string[] = [];
  const { cacheGet, cacheSet } = await import('../core/cache.js');

  for (const d of normalized) {
    const key = cacheKey('authority', { provider: provider.name, domain: d });
    if (!opts.bypassCache) {
      const hit = cacheGet<DomainAuthority>(key);
      if (hit) {
        result.set(d, hit.value);
        continue;
      }
    }
    misses.push(d);
  }

  let cost = 0;
  if (misses.length > 0) {
    reserve(provider.costPerCall);
    const fetched = await provider.authority(misses);
    record(provider.name, 'authority', provider.costPerCall);
    cost += provider.costPerCall;
    for (const a of fetched) {
      const d = domainOf(a.domain) || a.domain;
      result.set(d, a);
      cacheSet(cacheKey('authority', { provider: provider.name, domain: d }), a, TTL.backlinks, provider.name);
    }
  }

  return { authority: result, cost, provider: provider.name };
}

/** Authority as a plain domain -> score map, for `difficultyFromSerp`. */
export async function getAuthorityScores(cfg: Config, domains: string[]): Promise<Map<string, number>> {
  try {
    const { authority } = await getAuthority(cfg, domains);
    const scores = new Map<string, number>();
    for (const [d, a] of authority) if (a.authority !== null) scores.set(d, a.authority);
    return scores;
  } catch {
    // No provider, or it failed. Difficulty falls back to SERP-only signals.
    return new Map();
  }
}

export { cached };
