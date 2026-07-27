import { fetchJson } from '../core/http.js';
import { cached, cacheKey, TTL } from '../core/cache.js';
import { reserve, record } from '../core/budget.js';
import { providerNotConfigured, SeoAgentError } from '../core/errors.js';
import { dataForSeoAuthHeader } from './serp.js';
import type { Config } from '../config.js';

/**
 * Keyword volume, CPC and difficulty.
 *
 * Only DataForSEO is wired up, for a specific reason: it resells Google Ads
 * Keyword Planner data, which is the same source Ahrefs and Semrush ultimately
 * calibrate against, and the same credential also unlocks SERP and backlink
 * data. Supporting three half-overlapping metrics vendors would add surface area
 * without adding capability.
 *
 * Everything here degrades cleanly to `null` rather than a guess. A fabricated
 * search volume is the single most damaging thing this tool could return — an
 * agent will build a content calendar on it.
 */

export interface KeywordMetrics {
  keyword: string;
  volume: number | null;
  cpc: number | null;
  /** 0-1 paid competition, as reported by Keyword Planner. */
  competition: number | null;
  difficulty: number | null;
  /** Last 12 months of volume, oldest first. Reveals seasonality and trend. */
  monthly_volumes?: Array<{ year: number; month: number; volume: number }>;
  /** Percentage change from the earliest to the latest month we have. */
  trend?: number | null;
}

export interface KeywordMetricsProvider {
  readonly name: string;
  readonly costPerBatch: number;
  /** Batch size the provider accepts in one call. */
  readonly maxBatch: number;
  fetchMetrics(keywords: string[], location: string, language: string): Promise<KeywordMetrics[]>;
  /** Keyword ideas from the provider's own database (not autocomplete). */
  fetchIdeas?(seed: string, location: string, language: string, limit: number): Promise<KeywordMetrics[]>;
  /** Keywords a domain currently ranks for. */
  fetchRankedKeywords?(
    domain: string,
    location: string,
    language: string,
    limit: number,
  ): Promise<Array<KeywordMetrics & { position: number; url: string }>>;
}

export interface DfsTaskResponse<T> {
  status_code?: number;
  status_message?: string;
  tasks?: Array<{ status_code?: number; status_message?: string; result?: T[] }>;
}

export interface DfsVolumeItem {
  keyword?: string;
  search_volume?: number | null;
  cpc?: number | null;
  competition?: number | null;
  monthly_searches?: Array<{ year?: number; month?: number; search_volume?: number }>;
}

export interface DfsDifficultyItem {
  keyword?: string;
  keyword_difficulty?: number | null;
}

export interface DfsIdeaItem {
  keyword?: string;
  keyword_info?: {
    search_volume?: number | null;
    cpc?: number | null;
    competition?: number | null;
    monthly_searches?: Array<{ year?: number; month?: number; search_volume?: number }>;
  };
  keyword_properties?: { keyword_difficulty?: number | null };
  ranked_serp_element?: {
    serp_item?: { rank_group?: number; rank_absolute?: number; url?: string };
  };
}

class DataForSeoMetricsProvider implements KeywordMetricsProvider {
  readonly name = 'dataforseo';
  readonly costPerBatch = 1;
  /** Keyword Planner's own per-request ceiling. */
  readonly maxBatch = 1000;

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
        'Verify DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD and that the account has credit.',
        { status_code: task?.status_code ?? json.status_code },
      );
    }
    return task.result ?? [];
  }

  async fetchMetrics(keywords: string[], location: string, language: string): Promise<KeywordMetrics[]> {
    if (keywords.length === 0) return [];

    // Volume and difficulty live on different endpoints; fetch both and merge so
    // callers get one complete record per keyword.
    const volumePromise = fetchJson<DfsTaskResponse<DfsVolumeItem>>(
      'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live',
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify([{ keywords, location_name: location, language_code: language }]),
        retries: 2,
        timeoutMs: 60_000,
      },
    );

    const difficultyPromise = fetchJson<DfsTaskResponse<{ items?: DfsDifficultyItem[] }>>(
      'https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_keyword_difficulty/live',
      {
        method: 'POST',
        headers: this.headers(),
        // This endpoint caps at 1,000 keywords per call.
        body: JSON.stringify([
          { keywords: keywords.slice(0, 1000), location_name: location, language_code: language },
        ]),
        retries: 1,
        timeoutMs: 60_000,
      },
    ).catch(() => null);

    const [volumeJson, difficultyJson] = await Promise.all([volumePromise, difficultyPromise]);

    const difficultyByKeyword = new Map<string, number | null>();
    if (difficultyJson) {
      try {
        for (const result of this.unwrap(difficultyJson, 'keyword difficulty')) {
          for (const item of result.items ?? []) {
            if (item.keyword) difficultyByKeyword.set(item.keyword.toLowerCase(), item.keyword_difficulty ?? null);
          }
        }
      } catch {
        // Difficulty is a bonus; a failure there must not lose the volume data.
      }
    }

    const items = this.unwrap(volumeJson, 'search volume');
    return items
      .filter((i) => typeof i.keyword === 'string')
      .map((i) => toMetrics(i, difficultyByKeyword.get((i.keyword as string).toLowerCase()) ?? null));
  }

  async fetchIdeas(seed: string, location: string, language: string, limit: number): Promise<KeywordMetrics[]> {
    const json = await fetchJson<DfsTaskResponse<{ items?: DfsIdeaItem[] }>>(
      'https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live',
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify([
          {
            keywords: [seed],
            location_name: location,
            language_code: language,
            limit: Math.min(limit, 1000),
            order_by: ['keyword_info.search_volume,desc'],
          },
        ]),
        retries: 2,
        timeoutMs: 60_000,
      },
    );
    const out: KeywordMetrics[] = [];
    for (const result of this.unwrap(json, 'keyword ideas')) {
      for (const item of result.items ?? []) {
        if (!item.keyword) continue;
        out.push(ideaToMetrics(item));
      }
    }
    return out;
  }

  async fetchRankedKeywords(
    domain: string,
    location: string,
    language: string,
    limit: number,
  ): Promise<Array<KeywordMetrics & { position: number; url: string }>> {
    const json = await fetchJson<DfsTaskResponse<{ items?: DfsIdeaItem[] }>>(
      'https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live',
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify([
          {
            target: domain,
            location_name: location,
            language_code: language,
            limit: Math.min(limit, 1000),
            order_by: ['keyword_data.keyword_info.search_volume,desc'],
          },
        ]),
        retries: 2,
        timeoutMs: 60_000,
      },
    );
    const out: Array<KeywordMetrics & { position: number; url: string }> = [];
    for (const result of this.unwrap(json, 'ranked keywords')) {
      out.push(...normalizeRankedKeywords(result.items ?? []));
    }
    return out;
  }
}

export function toMetrics(i: DfsVolumeItem, difficulty: number | null): KeywordMetrics {
  const monthly = (i.monthly_searches ?? [])
    .filter((m) => typeof m.search_volume === 'number')
    .map((m) => ({ year: m.year ?? 0, month: m.month ?? 0, volume: m.search_volume as number }))
    .sort((a, b) => a.year - b.year || a.month - b.month);
  return {
    keyword: i.keyword as string,
    volume: i.search_volume ?? null,
    cpc: i.cpc ?? null,
    competition: i.competition ?? null,
    difficulty,
    ...(monthly.length > 0 ? { monthly_volumes: monthly, trend: computeTrend(monthly) } : {}),
  };
}

export function ideaToMetrics(item: DfsIdeaItem): KeywordMetrics {
  const info = item.keyword_info;
  const monthly = (info?.monthly_searches ?? [])
    .filter((m) => typeof m.search_volume === 'number')
    .map((m) => ({ year: m.year ?? 0, month: m.month ?? 0, volume: m.search_volume as number }))
    .sort((a, b) => a.year - b.year || a.month - b.month);
  return {
    keyword: item.keyword as string,
    volume: info?.search_volume ?? null,
    cpc: info?.cpc ?? null,
    competition: info?.competition ?? null,
    difficulty: item.keyword_properties?.keyword_difficulty ?? null,
    ...(monthly.length > 0 ? { monthly_volumes: monthly, trend: computeTrend(monthly) } : {}),
  };
}

/**
 * Percentage change between the first and last quarter of the series.
 * Comparing single months would mostly report seasonal noise as a trend.
 */
export function computeTrend(monthly: Array<{ volume: number }>): number | null {
  if (monthly.length < 6) return null;
  const q = Math.max(1, Math.floor(monthly.length / 4));
  const first = monthly.slice(0, q);
  const last = monthly.slice(-q);
  const avg = (xs: Array<{ volume: number }>) => xs.reduce((s, x) => s + x.volume, 0) / xs.length;
  const a = avg(first);
  const b = avg(last);
  if (a === 0) return b > 0 ? 100 : null;
  return Math.round(((b - a) / a) * 1000) / 10;
}

/**
 * DataForSEO ranked-keywords rows -> keyword metrics with position and URL.
 *
 * This powers `seo_content_gap`, and it is worth testing for a specific reason:
 * the ranked-keywords endpoint nests the keyword payload one level deeper than
 * the keyword-ideas endpoint (under `keyword_data`), while the SERP position
 * sits on the *outer* object. Read the nesting wrongly and the tool returns zero
 * gaps — a silently empty result, not an error, which reads as "you have no
 * content gaps" rather than "the parser is broken".
 */
export function normalizeRankedKeywords(
  items: DfsIdeaItem[],
): Array<KeywordMetrics & { position: number; url: string }> {
  const out: Array<KeywordMetrics & { position: number; url: string }> = [];
  for (const item of items) {
    // Accept both the nested shape and a flat one, so a future API change that
    // drops the wrapper degrades to working rather than to silence.
    const nested = (item as { keyword_data?: DfsIdeaItem }).keyword_data ?? item;
    if (!nested.keyword) continue;
    const serp = item.ranked_serp_element?.serp_item;
    out.push({
      ...ideaToMetrics(nested),
      position: serp?.rank_group ?? serp?.rank_absolute ?? 0,
      url: serp?.url ?? '',
    });
  }
  return out;
}

export function createKeywordMetricsProvider(cfg: Config): KeywordMetricsProvider | null {
  if (cfg.keywordData.provider === 'dataforseo' && cfg.dataforseo) {
    return new DataForSeoMetricsProvider(cfg.dataforseo.login, cfg.dataforseo.password);
  }
  return null;
}

export function requireKeywordMetricsProvider(cfg: Config): KeywordMetricsProvider {
  const p = createKeywordMetricsProvider(cfg);
  if (!p) {
    throw providerNotConfigured(
      'keyword volume, CPC and difficulty',
      ['DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD'],
      'seo_keyword_ideas (autocomplete-based discovery with relative scoring) and seo_cluster_keywords, which need no keys',
    );
  }
  return p;
}

/** Cached, batched, budget-checked metrics lookup. */
export async function getKeywordMetrics(
  cfg: Config,
  keywords: string[],
  opts: { location?: string; language?: string; bypassCache?: boolean } = {},
): Promise<{ metrics: Map<string, KeywordMetrics>; cost: number; cached_count: number; provider: string }> {
  const provider = requireKeywordMetricsProvider(cfg);
  const location = opts.location ?? cfg.defaults.location;
  const language = opts.language ?? cfg.defaults.language;

  const metrics = new Map<string, KeywordMetrics>();
  const misses: string[] = [];
  let cachedCount = 0;

  // Cache per keyword, not per batch: a batch key would miss whenever the agent
  // asks about a slightly different set, which it will constantly.
  for (const kw of keywords) {
    const key = cacheKey('kwmetrics', { provider: provider.name, kw, location, language });
    if (!opts.bypassCache) {
      const { cacheGet } = await import('../core/cache.js');
      const hit = cacheGet<KeywordMetrics>(key);
      if (hit) {
        metrics.set(kw, hit.value);
        cachedCount++;
        continue;
      }
    }
    misses.push(kw);
  }

  let cost = 0;
  const { cacheSet } = await import('../core/cache.js');
  for (let i = 0; i < misses.length; i += provider.maxBatch) {
    const batch = misses.slice(i, i + provider.maxBatch);
    reserve(provider.costPerBatch);
    const fetched = await provider.fetchMetrics(batch, location, language);
    record(provider.name, 'keyword_metrics', provider.costPerBatch);
    cost += provider.costPerBatch;

    const returned = new Set<string>();
    for (const m of fetched) {
      const kw = m.keyword.toLowerCase();
      returned.add(kw);
      metrics.set(kw, m);
      cacheSet(cacheKey('kwmetrics', { provider: provider.name, kw, location, language }), m, TTL.keyword_metrics, provider.name);
    }
    // Keyword Planner silently omits keywords with no data. Cache the null
    // result too, or every subsequent call re-requests the same dead keywords.
    for (const kw of batch) {
      if (returned.has(kw.toLowerCase())) continue;
      const empty: KeywordMetrics = { keyword: kw, volume: null, cpc: null, competition: null, difficulty: null };
      metrics.set(kw, empty);
      cacheSet(cacheKey('kwmetrics', { provider: provider.name, kw, location, language }), empty, TTL.keyword_metrics, provider.name);
    }
  }

  return { metrics, cost, cached_count: cachedCount, provider: provider.name };
}
