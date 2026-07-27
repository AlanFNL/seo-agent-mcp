import type { SerpData, SerpResult } from '../core/types.js';
import { fetchJson } from '../core/http.js';
import { cached, cacheKey, TTL } from '../core/cache.js';
import { reserve, record } from '../core/budget.js';
import { providerNotConfigured, SeoAgentError } from '../core/errors.js';
import { domainOf } from '../core/url.js';
import type { Config } from '../config.js';

/**
 * SERP providers.
 *
 * Live SERP data has to come from a paid API. I verified this before committing
 * to the design: Bing's HTML endpoint serves a CAPTCHA to server traffic and
 * DuckDuckGo's lite endpoint returns an empty document, so there is no viable
 * free scraping path. Rather than ship something that works on a laptop and
 * breaks in CI, SERP access is an explicit, pluggable, *optional* capability.
 *
 * Three providers are supported because they have genuinely different
 * trade-offs: Serper is cheapest and fastest, SerpApi has the richest feature
 * parsing, DataForSEO is the only one that also does keyword volume and
 * backlinks (so one credential unlocks three capabilities).
 *
 * Every provider normalises into the same `SerpData`, so no tool above this
 * layer knows or cares which one is configured.
 */

export interface SerpQuery {
  keyword: string;
  location?: string;
  language?: string;
  device?: 'desktop' | 'mobile';
  /** Number of organic results to request. */
  depth?: number;
}

export interface SerpProvider {
  readonly name: string;
  /** Approximate provider units consumed per search, for budget accounting. */
  readonly costPerSearch: number;
  search(query: SerpQuery): Promise<SerpData>;
}

/** Feature names we normalise to, so audit and difficulty logic stays provider-agnostic. */
export const SERP_FEATURES = [
  'featured_snippet',
  'people_also_ask',
  'ai_overview',
  'knowledge_graph',
  'local_pack',
  'image_pack',
  'video',
  'top_stories',
  'shopping',
  'ads',
  'related_searches',
  'sitelinks',
  'discussions_and_forums',
  'twitter',
  'reviews',
  'faq',
] as const;

// ---------------------------------------------------------------------------
// Serper.dev
// ---------------------------------------------------------------------------

export interface SerperResponse {
  organic?: Array<{ position?: number; title?: string; link?: string; snippet?: string; sitelinks?: unknown[] }>;
  peopleAlsoAsk?: Array<{ question?: string }>;
  relatedSearches?: Array<{ query?: string }>;
  answerBox?: { snippet?: string; title?: string };
  knowledgeGraph?: { title?: string };
  ads?: unknown[];
  topStories?: unknown[];
  images?: unknown[];
  videos?: unknown[];
  places?: unknown[];
  shopping?: unknown[];
  credits?: number;
}

/**
 * Serper response -> SerpData.
 *
 * Extracted from the provider class so the parsing can be tested without a
 * network call or an API key. Provider response shapes are the part of this
 * codebase most likely to be quietly wrong — they were written against vendor
 * documentation, and a field renamed upstream fails silently as an empty result
 * rather than an error.
 */
export function normalizeSerperResponse(json: SerperResponse, query: SerpQuery): SerpData {
  const results: SerpResult[] = (json.organic ?? [])
    .filter((r) => typeof r.link === 'string')
    .map((r, i) => ({
      position: r.position ?? i + 1,
      url: r.link as string,
      title: r.title ?? '',
      snippet: r.snippet ?? '',
      domain: domainOf(r.link as string),
    }));

  const features: string[] = [];
  if (json.answerBox) features.push('featured_snippet');
  if (json.peopleAlsoAsk?.length) features.push('people_also_ask');
  if (json.knowledgeGraph) features.push('knowledge_graph');
  if (json.places?.length) features.push('local_pack');
  if (json.images?.length) features.push('image_pack');
  if (json.videos?.length) features.push('video');
  if (json.topStories?.length) features.push('top_stories');
  if (json.shopping?.length) features.push('shopping');
  if (json.ads?.length) features.push('ads');
  if (json.relatedSearches?.length) features.push('related_searches');
  if ((json.organic ?? []).some((r) => Array.isArray(r.sitelinks) && r.sitelinks.length > 0)) {
    features.push('sitelinks');
  }

  return {
    keyword: query.keyword,
    location: query.location ?? 'United States',
    device: query.device ?? 'desktop',
    results,
    features,
    people_also_ask: (json.peopleAlsoAsk ?? []).map((p) => p.question ?? '').filter(Boolean),
    related_searches: (json.relatedSearches ?? []).map((r) => r.query ?? '').filter(Boolean),
    fetched_at: new Date().toISOString(),
  };
}

class SerperProvider implements SerpProvider {
  readonly name = 'serper';
  readonly costPerSearch = 1;

  constructor(private readonly apiKey: string) {}

  async search(query: SerpQuery): Promise<SerpData> {
    const json = await fetchJson<SerperResponse>('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        q: query.keyword,
        gl: countryCode(query.location),
        hl: query.language ?? 'en',
        num: Math.min(query.depth ?? 10, 100),
        ...(query.device === 'mobile' ? { device: 'mobile' } : {}),
      }),
      retries: 2,
      timeoutMs: 25_000,
    });
    return normalizeSerperResponse(json, query);
  }
}

// ---------------------------------------------------------------------------
// SerpApi
// ---------------------------------------------------------------------------

export interface SerpApiResponse {
  organic_results?: Array<{ position?: number; title?: string; link?: string; snippet?: string; sitelinks?: unknown }>;
  related_questions?: Array<{ question?: string }>;
  related_searches?: Array<{ query?: string }>;
  answer_box?: unknown;
  knowledge_graph?: unknown;
  local_results?: unknown;
  inline_images?: unknown;
  inline_videos?: unknown;
  top_stories?: unknown;
  shopping_results?: unknown;
  ads?: unknown;
  ai_overview?: unknown;
  discussions_and_forums?: unknown;
  error?: string;
}

/** SerpApi response -> SerpData. Pure so it can be tested without a key. */
export function normalizeSerpApiResponse(json: SerpApiResponse, query: SerpQuery): SerpData {
  const results: SerpResult[] = (json.organic_results ?? [])
    .filter((r) => typeof r.link === 'string')
    .map((r, i) => ({
      position: r.position ?? i + 1,
      url: r.link as string,
      title: r.title ?? '',
      snippet: r.snippet ?? '',
      domain: domainOf(r.link as string),
    }));

  const features: string[] = [];
  if (json.answer_box) features.push('featured_snippet');
  if (json.related_questions?.length) features.push('people_also_ask');
  if (json.ai_overview) features.push('ai_overview');
  if (json.knowledge_graph) features.push('knowledge_graph');
  if (json.local_results) features.push('local_pack');
  if (json.inline_images) features.push('image_pack');
  if (json.inline_videos) features.push('video');
  if (json.top_stories) features.push('top_stories');
  if (json.shopping_results) features.push('shopping');
  if (json.ads) features.push('ads');
  if (json.discussions_and_forums) features.push('discussions_and_forums');
  if (json.related_searches?.length) features.push('related_searches');

  return {
    keyword: query.keyword,
    location: query.location ?? 'United States',
    device: query.device ?? 'desktop',
    results,
    features,
    people_also_ask: (json.related_questions ?? []).map((p) => p.question ?? '').filter(Boolean),
    related_searches: (json.related_searches ?? []).map((r) => r.query ?? '').filter(Boolean),
    fetched_at: new Date().toISOString(),
  };
}

class SerpApiProvider implements SerpProvider {
  readonly name = 'serpapi';
  readonly costPerSearch = 1;

  constructor(private readonly apiKey: string) {}

  async search(query: SerpQuery): Promise<SerpData> {
    const params = new URLSearchParams({
      engine: 'google',
      q: query.keyword,
      api_key: this.apiKey,
      hl: query.language ?? 'en',
      gl: countryCode(query.location),
      num: String(Math.min(query.depth ?? 10, 100)),
      device: query.device ?? 'desktop',
    });
    if (query.location) params.set('location', query.location);

    const json = await fetchJson<SerpApiResponse>(`https://serpapi.com/search.json?${params.toString()}`, {
      retries: 2,
      timeoutMs: 30_000,
    });
    // SerpApi signals failure in the body with HTTP 200, so this must be checked
    // explicitly rather than relying on the status code.
    if (json.error) {
      throw new SeoAgentError('PROVIDER_ERROR', `SerpApi: ${json.error}`, 'Check SERPAPI_KEY and your remaining quota.');
    }
    return normalizeSerpApiResponse(json, query);
  }
}

// ---------------------------------------------------------------------------
// DataForSEO
// ---------------------------------------------------------------------------

export interface DfsSerpItem {
  type?: string;
  rank_group?: number;
  rank_absolute?: number;
  url?: string;
  title?: string;
  description?: string;
  domain?: string;
  items?: Array<{ title?: string; seed_question?: string; question?: string }>;
}

export interface DfsResponse {
  status_code?: number;
  status_message?: string;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: Array<{ keyword?: string; item_types?: string[]; items?: DfsSerpItem[] }>;
  }>;
}

export function dataForSeoAuthHeader(login: string, password: string): string {
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

/** DataForSEO item types -> our normalised feature names. */
const DFS_FEATURE_MAP: Record<string, string> = {
  featured_snippet: 'featured_snippet',
  people_also_ask: 'people_also_ask',
  ai_overview: 'ai_overview',
  knowledge_graph: 'knowledge_graph',
  local_pack: 'local_pack',
  images: 'image_pack',
  video: 'video',
  short_videos: 'video',
  top_stories: 'top_stories',
  shopping: 'shopping',
  popular_products: 'shopping',
  paid: 'ads',
  related_searches: 'related_searches',
  discussions_and_forums: 'discussions_and_forums',
  twitter: 'twitter',
  answer_box: 'featured_snippet',
  questions_and_answers: 'faq',
};

/**
 * DataForSEO response -> SerpData.
 *
 * Throws on a task-level error: DataForSEO returns HTTP 200 with a status_code
 * of 40000+ in the body, so the HTTP layer never sees the failure.
 */
export function normalizeDataForSeoResponse(json: DfsResponse, query: SerpQuery): SerpData {
  const task = json.tasks?.[0];
  if (!task || (task.status_code ?? 0) >= 40000) {
    throw new SeoAgentError(
      'PROVIDER_ERROR',
      `DataForSEO: ${task?.status_message ?? json.status_message ?? 'unknown error'}`,
      'Verify DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD and that the account has credit.',
      { status_code: task?.status_code ?? json.status_code },
    );
  }
  const result = task.result?.[0];
  const items = result?.items ?? [];

  const results: SerpResult[] = items
    .filter((it) => it.type === 'organic' && typeof it.url === 'string')
    .map((it, i) => ({
      position: it.rank_group ?? i + 1,
      url: it.url as string,
      title: it.title ?? '',
      snippet: it.description ?? '',
      domain: it.domain ?? domainOf(it.url as string),
    }));

  const features = [
    ...new Set(
      (result?.item_types ?? items.map((i) => i.type ?? ''))
        .map((t) => DFS_FEATURE_MAP[t])
        .filter((t): t is string => Boolean(t)),
    ),
  ];

  const paa = items
    .filter((it) => it.type === 'people_also_ask')
    .flatMap((it) => (it.items ?? []).map((sub) => sub.seed_question ?? sub.question ?? sub.title ?? ''))
    .filter(Boolean);

  const related = items
    .filter((it) => it.type === 'related_searches')
    .flatMap((it) => (it.items ?? []).map((sub) => (typeof sub === 'string' ? sub : (sub.title ?? ''))))
    .filter(Boolean);

  return {
    keyword: query.keyword,
    location: query.location ?? 'United States',
    device: query.device ?? 'desktop',
    results,
    features,
    people_also_ask: paa,
    related_searches: related,
    fetched_at: new Date().toISOString(),
  };
}

class DataForSeoSerpProvider implements SerpProvider {
  readonly name = 'dataforseo';
  /** DataForSEO bills per task; the live advanced endpoint is the pricier one. */
  readonly costPerSearch = 2;

  constructor(private readonly login: string, private readonly password: string) {}

  async search(query: SerpQuery): Promise<SerpData> {
    const json = await fetchJson<DfsResponse>(
      'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
      {
        method: 'POST',
        headers: {
          authorization: dataForSeoAuthHeader(this.login, this.password),
          'content-type': 'application/json',
        },
        // The API takes an array of tasks; we send exactly one.
        body: JSON.stringify([
          {
            keyword: query.keyword,
            location_name: query.location ?? 'United States',
            language_code: query.language ?? 'en',
            device: query.device ?? 'desktop',
            depth: Math.min(query.depth ?? 10, 100),
          },
        ]),
        retries: 2,
        timeoutMs: 45_000,
      },
    );
    return normalizeDataForSeoResponse(json, query);
  }
}

// ---------------------------------------------------------------------------
// Factory + caching wrapper
// ---------------------------------------------------------------------------

export function createSerpProvider(cfg: Config): SerpProvider | null {
  switch (cfg.serp.provider) {
    case 'serper':
      return new SerperProvider(cfg.serp.serperKey as string);
    case 'serpapi':
      return new SerpApiProvider(cfg.serp.serpapiKey as string);
    case 'dataforseo':
      return new DataForSeoSerpProvider(
        cfg.dataforseo?.login as string,
        cfg.dataforseo?.password as string,
      );
    default:
      return null;
  }
}

export function requireSerpProvider(cfg: Config): SerpProvider {
  const p = createSerpProvider(cfg);
  if (!p) {
    throw providerNotConfigured(
      'live SERP data',
      ['SERPER_API_KEY', 'SERPAPI_KEY', 'DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD'],
      'seo_gsc_performance for your own rankings, seo_keyword_ideas for discovery, and seo_page_inspect to analyse any competitor URL directly',
    );
  }
  return p;
}

export interface SerpFetch {
  data: SerpData;
  cached: boolean;
  provider: string;
  cost: number;
}

/**
 * Cached, budget-checked SERP fetch. Every tool goes through this rather than
 * calling a provider directly — that's what keeps an agent's retry loop from
 * turning into a surprise invoice.
 */
export async function getSerp(cfg: Config, query: SerpQuery, opts: { bypassCache?: boolean } = {}): Promise<SerpFetch> {
  const provider = requireSerpProvider(cfg);
  const key = cacheKey('serp', {
    provider: provider.name,
    keyword: query.keyword,
    location: query.location ?? cfg.defaults.location,
    language: query.language ?? cfg.defaults.language,
    device: query.device ?? cfg.defaults.device,
    depth: query.depth ?? 10,
  });

  const result = await cached<SerpData>(
    key,
    TTL.serp,
    async () => {
      reserve(provider.costPerSearch);
      const data = await provider.search({
        ...query,
        location: query.location ?? cfg.defaults.location,
        language: query.language ?? cfg.defaults.language,
        device: query.device ?? cfg.defaults.device,
      });
      record(provider.name, 'serp', provider.costPerSearch);
      return data;
    },
    { source: provider.name, ...(opts.bypassCache ? { bypass: true } : {}) },
  );

  return {
    data: result.value,
    cached: result.cached,
    provider: provider.name,
    cost: result.cached ? 0 : provider.costPerSearch,
  };
}

/** Rough country code from a location string, for providers that want `gl`. */
export function countryCode(location?: string): string {
  if (!location) return 'us';
  const map: Record<string, string> = {
    'united states': 'us', usa: 'us', us: 'us',
    'united kingdom': 'gb', uk: 'gb', england: 'gb',
    canada: 'ca', australia: 'au', germany: 'de', france: 'fr', spain: 'es',
    italy: 'it', netherlands: 'nl', belgium: 'be', sweden: 'se', norway: 'no',
    denmark: 'dk', finland: 'fi', poland: 'pl', portugal: 'pt', ireland: 'ie',
    india: 'in', japan: 'jp', 'south korea': 'kr', brazil: 'br', mexico: 'mx',
    argentina: 'ar', 'south africa': 'za', singapore: 'sg', 'new zealand': 'nz',
    switzerland: 'ch', austria: 'at', israel: 'il', turkey: 'tr', uae: 'ae',
    'united arab emirates': 'ae',
  };
  const lower = location.toLowerCase().trim();
  if (map[lower]) return map[lower] as string;
  // "Austin, Texas, United States" -> take the last comma-separated part.
  const last = lower.split(',').pop()?.trim() ?? '';
  return map[last] ?? 'us';
}
