import { fetchJson } from '../core/http.js';
import { cached, cacheKey } from '../core/cache.js';
import { providerNotConfigured, SeoAgentError } from '../core/errors.js';
import { round, clamp } from '../core/text.js';
import { action } from '../core/envelope.js';
import type { Action } from '../core/types.js';
import type { Config } from '../config.js';

/**
 * PageSpeed Insights / Core Web Vitals.
 *
 * The API is free but requires a key — I confirmed the unkeyed endpoint returns
 * 429 immediately, so there is no usable anonymous path.
 *
 * Worth distinguishing the two data sets it returns, because they answer
 * different questions and agents routinely conflate them: **field data** (CrUX)
 * is what real Chrome users experienced over the last 28 days and is what
 * actually feeds the ranking signal; **lab data** (Lighthouse) is a single
 * simulated load, useful for diagnosis but not a ranking input. When field data
 * exists, it wins.
 */

export interface CoreWebVitals {
  /** Largest Contentful Paint, milliseconds. Good < 2500. */
  lcp: number | null;
  /** Interaction to Next Paint, milliseconds. Good < 200. */
  inp: number | null;
  /** Cumulative Layout Shift, unitless. Good < 0.1. */
  cls: number | null;
  /** First Contentful Paint, milliseconds. */
  fcp: number | null;
  /** Time to First Byte, milliseconds. */
  ttfb: number | null;
}

export interface PageSpeedResult {
  url: string;
  strategy: 'mobile' | 'desktop';
  /** 0-100 Lighthouse performance score. Lab data. */
  performance_score: number | null;
  /** Real-user metrics from the Chrome UX Report. Null when the URL has too little traffic. */
  field_data: (CoreWebVitals & { overall: 'GOOD' | 'NEEDS_IMPROVEMENT' | 'POOR' | null }) | null;
  /** Simulated single-load metrics from Lighthouse. */
  lab_data: CoreWebVitals;
  /** Whether the page passes the Core Web Vitals assessment on field data. */
  passes_cwv: boolean | null;
  /** Lighthouse audits that failed, ordered by estimated savings. */
  opportunities: Array<{ id: string; title: string; description: string; savings_ms: number | null }>;
  fetched_at: string;
}

export interface PsiResponse {
  lighthouseResult?: {
    categories?: { performance?: { score?: number | null } };
    audits?: Record<
      string,
      {
        id?: string;
        title?: string;
        description?: string;
        score?: number | null;
        scoreDisplayMode?: string;
        numericValue?: number;
        details?: { overallSavingsMs?: number };
      }
    >;
  };
  loadingExperience?: {
    overall_category?: string;
    metrics?: Record<string, { percentile?: number; category?: string }>;
  };
  error?: { message?: string };
}

const FIELD_METRIC_KEYS = {
  lcp: 'LARGEST_CONTENTFUL_PAINT_MS',
  inp: 'INTERACTION_TO_NEXT_PAINT',
  cls: 'CUMULATIVE_LAYOUT_SHIFT_SCORE',
  fcp: 'FIRST_CONTENTFUL_PAINT_MS',
  ttfb: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE',
} as const;

export async function getPageSpeed(
  cfg: Config,
  url: string,
  strategy: 'mobile' | 'desktop' = 'mobile',
): Promise<{ result: PageSpeedResult; cached: boolean }> {
  if (!cfg.pagespeedKey) {
    throw providerNotConfigured(
      'PageSpeed Insights and Core Web Vitals',
      ['PAGESPEED_API_KEY'],
      'seo_crawl_site, which reports server response time, transfer size and render-blocking resource counts per page',
    );
  }

  const key = cacheKey('psi', { url, strategy });
  // Field data updates on a 28-day rolling window, so caching for hours costs
  // no accuracy and PSI is comparatively slow (10-30s per call).
  const { value, cached: wasCached } = await cached<PageSpeedResult>(
    key,
    6 * 3600,
    async () => {
      const params = new URLSearchParams({
        url,
        strategy,
        key: cfg.pagespeedKey as string,
      });
      params.append('category', 'PERFORMANCE');

      const json = await fetchJson<PsiResponse>(
        `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`,
        { retries: 1, timeoutMs: 90_000 },
      );
      if (json.error) {
        throw new SeoAgentError(
          'PROVIDER_ERROR',
          `PageSpeed Insights: ${json.error.message ?? 'unknown error'}`,
          'Check PAGESPEED_API_KEY is valid and the URL is publicly reachable.',
        );
      }
      return shapePageSpeedResponse(url, strategy, json);
    },
    { source: 'pagespeed-insights' },
  );

  return { result: value, cached: wasCached };
}

/**
 * PageSpeed Insights response -> PageSpeedResult.
 * Exported so the field mapping can be tested without a key or a 30s API call.
 */
export function shapePageSpeedResponse(url: string, strategy: 'mobile' | 'desktop', json: PsiResponse): PageSpeedResult {
  const audits = json.lighthouseResult?.audits ?? {};
  const num = (id: string): number | null => {
    const v = audits[id]?.numericValue;
    return typeof v === 'number' ? round(v, 0) : null;
  };

  const fieldMetrics = json.loadingExperience?.metrics;
  let fieldData: PageSpeedResult['field_data'] = null;
  if (fieldMetrics && Object.keys(fieldMetrics).length > 0) {
    const p = (k: keyof typeof FIELD_METRIC_KEYS): number | null => {
      const v = fieldMetrics[FIELD_METRIC_KEYS[k]]?.percentile;
      if (typeof v !== 'number') return null;
      // CrUX reports CLS ×100 as an integer; convert back to the real unit.
      return k === 'cls' ? round(v / 100, 3) : v;
    };
    const overall = json.loadingExperience?.overall_category;
    fieldData = {
      lcp: p('lcp'),
      inp: p('inp'),
      cls: p('cls'),
      fcp: p('fcp'),
      ttfb: p('ttfb'),
      overall: overall === 'FAST' ? 'GOOD' : (overall as PageSpeedResult['field_data'] extends null ? never : 'GOOD' | 'NEEDS_IMPROVEMENT' | 'POOR') ?? null,
    };
  }

  const opportunities = Object.values(audits)
    .filter((a) => a.scoreDisplayMode === 'numeric' || a.scoreDisplayMode === 'metricSavings')
    .filter((a) => typeof a.score === 'number' && (a.score as number) < 0.9)
    .map((a) => ({
      id: a.id ?? '',
      title: a.title ?? '',
      description: (a.description ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 300),
      savings_ms: typeof a.details?.overallSavingsMs === 'number' ? round(a.details.overallSavingsMs, 0) : null,
    }))
    .filter((o) => o.id && o.title)
    .sort((a, b) => (b.savings_ms ?? 0) - (a.savings_ms ?? 0))
    .slice(0, 15);

  const score = json.lighthouseResult?.categories?.performance?.score;

  return {
    url,
    strategy,
    performance_score: typeof score === 'number' ? round(score * 100, 0) : null,
    field_data: fieldData,
    lab_data: {
      lcp: num('largest-contentful-paint'),
      inp: num('interaction-to-next-paint'),
      cls: audits['cumulative-layout-shift']?.numericValue != null
        ? round(audits['cumulative-layout-shift'].numericValue as number, 3)
        : null,
      fcp: num('first-contentful-paint'),
      ttfb: num('server-response-time'),
    },
    passes_cwv: fieldData ? fieldData.overall === 'GOOD' : null,
    opportunities,
    fetched_at: new Date().toISOString(),
  };
}

/** Core Web Vitals thresholds, as published by Google. */
export const CWV_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
} as const;

export function pageSpeedToActions(result: PageSpeedResult): Action[] {
  const actions: Action[] = [];
  // Field data is the ranking signal; lab data is only a diagnostic proxy.
  const metrics = result.field_data ?? result.lab_data;
  const isField = result.field_data !== null;
  const sourceNote = isField
    ? 'Measured from real Chrome users over the last 28 days — this is the data Google uses as a ranking signal.'
    : 'No real-user data available for this URL (usually means low traffic), so these are lab measurements from a single simulated load. Treat them as directional.';

  const failing: Array<{ metric: string; value: number; threshold: number; unit: string }> = [];
  if (metrics.lcp !== null && metrics.lcp > CWV_THRESHOLDS.lcp.good) {
    failing.push({ metric: 'LCP', value: metrics.lcp, threshold: CWV_THRESHOLDS.lcp.good, unit: 'ms' });
  }
  if (metrics.inp !== null && metrics.inp > CWV_THRESHOLDS.inp.good) {
    failing.push({ metric: 'INP', value: metrics.inp, threshold: CWV_THRESHOLDS.inp.good, unit: 'ms' });
  }
  if (metrics.cls !== null && metrics.cls > CWV_THRESHOLDS.cls.good) {
    failing.push({ metric: 'CLS', value: metrics.cls, threshold: CWV_THRESHOLDS.cls.good, unit: '' });
  }

  if (failing.length > 0) {
    const worst = failing[0] as (typeof failing)[number];
    actions.push(
      action({
        id: `cwv.${result.url}`,
        priority: isField && failing.length >= 2 ? 'high' : 'medium',
        effort: 'medium',
        category: 'performance',
        title: `Fix ${failing.length} failing Core Web Vital${failing.length > 1 ? 's' : ''} on ${result.url}`,
        detail:
          `${failing.map((f) => `${f.metric} is ${f.value}${f.unit} (target under ${f.threshold}${f.unit})`).join('; ')}. ` +
          `${sourceNote} Start with: ${result.opportunities.slice(0, 3).map((o) => o.title).join('; ') || 'the opportunities list in data'}.`,
        target: result.url,
        impact_score: round(clamp(45 + failing.length * 12 + (isField ? 12 : 0), 0, 92), 1),
        evidence: {
          failing,
          data_source: isField ? 'field (CrUX)' : 'lab (Lighthouse)',
          performance_score: result.performance_score,
          top_opportunities: result.opportunities.slice(0, 5),
        },
        fix: { type: 'fix_core_web_vitals', to: worst.metric },
      }),
    );
  }

  return actions;
}
