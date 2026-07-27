import { describe, it, expect } from 'vitest';
import { describeCapabilities, loadConfig, type Config } from '../src/config.js';
import {
  normalizeSerperResponse,
  normalizeSerpApiResponse,
  normalizeDataForSeoResponse,
  dataForSeoAuthHeader,
  countryCode,
  type SerperResponse,
  type SerpApiResponse,
  type DfsResponse,
} from '../src/providers/serp.js';
import {
  toMetrics,
  ideaToMetrics,
  computeTrend,
  normalizeRankedKeywords,
  type DfsVolumeItem,
  type DfsIdeaItem,
} from '../src/providers/keyword-metrics.js';
import {
  shapePageSpeedResponse,
  pageSpeedToActions,
  CWV_THRESHOLDS,
  type PsiResponse,
} from '../src/providers/pagespeed.js';
import {
  analyzeMention,
  defaultPrompts,
  aiVisibilityToActions,
  analyzeSentiment,
} from '../src/providers/ai-visibility.js';
import {
  normalizeOpenPageRankResponse,
  normalizeDfsSummary,
  normalizeDfsBacklinks,
  normalizeLinkGap,
} from '../src/providers/backlinks.js';
import { daysAgo, GSC_LAG_DAYS } from '../src/providers/gsc.js';

/**
 * Provider response parsing.
 *
 * These are the highest-risk lines in the codebase: written against vendor
 * documentation, exercised only when someone has a paid key, and failing
 * *silently* when a field is misread — a renamed key yields an empty result set,
 * not an error. The integration suite can't reach them without credentials, so
 * the parsers are tested here against fixtures shaped like the documented
 * responses.
 *
 * The fixtures are inputs, not expected outputs: each test asserts on what the
 * shipped normalizer produces from them.
 */

// ---------------------------------------------------------------------------
// Serper
// ---------------------------------------------------------------------------

const serperFixture: SerperResponse = {
  organic: [
    {
      position: 1,
      title: 'Best CRM Software of 2026',
      link: 'https://www.example.com/best-crm',
      snippet: 'We tested 40 CRMs.',
      sitelinks: [{ title: 'Pricing', link: 'https://www.example.com/pricing' }],
    },
    { position: 2, title: 'Top CRMs', link: 'https://blog.other.co.uk/top-crms', snippet: 'Our picks.' },
    // No explicit position — the normalizer must fall back to index order.
    { title: 'Third', link: 'https://third.io/page', snippet: '' },
    // Malformed row with no link: must be dropped rather than crashing.
    { title: 'Broken', snippet: 'no link here' },
  ],
  peopleAlsoAsk: [{ question: 'What is a CRM?' }, { question: 'How much does a CRM cost?' }, {}],
  relatedSearches: [{ query: 'crm for small business' }, {}],
  answerBox: { snippet: 'A CRM is...', title: 'CRM' },
  knowledgeGraph: { title: 'Customer relationship management' },
  ads: [{}],
  credits: 1,
};

describe('Serper normalizer', () => {
  const out = normalizeSerperResponse(serperFixture, { keyword: 'best crm', location: 'United Kingdom' });

  it('maps organic results and drops rows with no link', () => {
    expect(out.results).toHaveLength(3);
    expect(out.results[0]?.url).toBe('https://www.example.com/best-crm');
    expect(out.results[0]?.title).toBe('Best CRM Software of 2026');
  });

  it('falls back to index order when position is absent', () => {
    expect(out.results[2]?.position).toBe(3);
  });

  it('derives the registrable domain, including multi-part suffixes', () => {
    expect(out.results[0]?.domain).toBe('example.com');
    expect(out.results[1]?.domain).toBe('other.co.uk');
  });

  it('detects the SERP features that are present and none that are not', () => {
    expect(out.features).toContain('featured_snippet');
    expect(out.features).toContain('people_also_ask');
    expect(out.features).toContain('knowledge_graph');
    expect(out.features).toContain('ads');
    expect(out.features).toContain('sitelinks');
    expect(out.features).not.toContain('local_pack');
    expect(out.features).not.toContain('shopping');
  });

  it('extracts People Also Ask and related searches, skipping empty entries', () => {
    expect(out.people_also_ask).toEqual(['What is a CRM?', 'How much does a CRM cost?']);
    expect(out.related_searches).toEqual(['crm for small business']);
  });

  it('carries the query context through', () => {
    expect(out.keyword).toBe('best crm');
    expect(out.location).toBe('United Kingdom');
    expect(out.device).toBe('desktop');
  });

  it('returns an empty but valid shape for an empty response', () => {
    const empty = normalizeSerperResponse({}, { keyword: 'x' });
    expect(empty.results).toEqual([]);
    expect(empty.features).toEqual([]);
    expect(empty.people_also_ask).toEqual([]);
    expect(empty.location).toBe('United States');
  });
});

// ---------------------------------------------------------------------------
// SerpApi
// ---------------------------------------------------------------------------

const serpApiFixture: SerpApiResponse = {
  organic_results: [
    { position: 1, title: 'One', link: 'https://a.com/1', snippet: 'first' },
    { position: 2, title: 'Two', link: 'https://b.com/2', snippet: 'second' },
    { title: 'No link' },
  ],
  related_questions: [{ question: 'Why?' }],
  related_searches: [{ query: 'related term' }],
  ai_overview: { text: 'overview' },
  inline_videos: [{}],
  local_results: { places: [] },
};

describe('SerpApi normalizer', () => {
  const out = normalizeSerpApiResponse(serpApiFixture, { keyword: 'k', device: 'mobile' });

  it('maps organic_results and drops linkless rows', () => {
    expect(out.results).toHaveLength(2);
    expect(out.results.map((r) => r.domain)).toEqual(['a.com', 'b.com']);
  });

  it('recognises the AI overview, which is SerpApi-specific', () => {
    expect(out.features).toContain('ai_overview');
    expect(out.features).toContain('video');
    expect(out.features).toContain('local_pack');
  });

  it('maps related_questions to the shared people_also_ask field', () => {
    expect(out.people_also_ask).toEqual(['Why?']);
  });

  it('preserves the requested device', () => {
    expect(out.device).toBe('mobile');
  });
});

// ---------------------------------------------------------------------------
// DataForSEO
// ---------------------------------------------------------------------------

const dfsFixture: DfsResponse = {
  status_code: 20000,
  tasks: [
    {
      status_code: 20000,
      result: [
        {
          keyword: 'best crm',
          item_types: ['organic', 'people_also_ask', 'related_searches', 'paid', 'ai_overview'],
          items: [
            {
              type: 'organic',
              rank_group: 1,
              rank_absolute: 2,
              url: 'https://one.com/a',
              title: 'One',
              description: 'desc one',
              domain: 'one.com',
            },
            {
              type: 'organic',
              rank_group: 2,
              url: 'https://two.com/b',
              title: 'Two',
              description: 'desc two',
            },
            { type: 'paid', url: 'https://ad.com', title: 'Ad' },
            {
              type: 'people_also_ask',
              items: [{ seed_question: 'What is it?' }, { title: 'Fallback title question' }],
            },
            { type: 'related_searches', items: [{ title: 'related one' }] },
          ],
        },
      ],
    },
  ],
};

describe('DataForSEO normalizer', () => {
  const out = normalizeDataForSeoResponse(dfsFixture, { keyword: 'best crm' });

  it('keeps only organic items and uses rank_group for position', () => {
    expect(out.results).toHaveLength(2);
    // rank_absolute is 2 but rank_group is 1 — rank_group is the organic position.
    expect(out.results[0]?.position).toBe(1);
    expect(out.results.every((r) => !r.url.includes('ad.com'))).toBe(true);
  });

  it('falls back to deriving the domain when the field is absent', () => {
    expect(out.results[0]?.domain).toBe('one.com');
    expect(out.results[1]?.domain).toBe('two.com');
  });

  it('maps DataForSEO item types onto the shared feature vocabulary', () => {
    // "paid" must surface as "ads" so difficulty scoring is provider-agnostic.
    expect(out.features).toContain('ads');
    expect(out.features).toContain('people_also_ask');
    expect(out.features).toContain('ai_overview');
    expect(out.features).not.toContain('paid');
  });

  it('extracts nested PAA questions, including the title fallback', () => {
    expect(out.people_also_ask).toEqual(['What is it?', 'Fallback title question']);
    expect(out.related_searches).toEqual(['related one']);
  });

  it('throws a structured error on a task-level failure returned with HTTP 200', () => {
    const failed: DfsResponse = {
      status_code: 20000,
      tasks: [{ status_code: 40501, status_message: 'Invalid Field: keyword' }],
    };
    expect(() => normalizeDataForSeoResponse(failed, { keyword: 'x' })).toThrow(/Invalid Field/);
  });

  it('throws when the tasks array is missing entirely', () => {
    expect(() => normalizeDataForSeoResponse({ status_message: 'auth failed' }, { keyword: 'x' })).toThrow(
      /auth failed/,
    );
  });
});

describe('dataForSeoAuthHeader', () => {
  it('produces a decodable HTTP Basic header', () => {
    const header = dataForSeoAuthHeader('user@example.com', 'secret');
    expect(header.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(header.slice(6), 'base64').toString()).toBe('user@example.com:secret');
  });
});

describe('countryCode', () => {
  it('maps common location strings to gl codes', () => {
    expect(countryCode('United Kingdom')).toBe('gb');
    expect(countryCode('Germany')).toBe('de');
    expect(countryCode(undefined)).toBe('us');
  });

  it('reads the country from a comma-separated city string', () => {
    expect(countryCode('Austin, Texas, United States')).toBe('us');
    expect(countryCode('London,England,United Kingdom')).toBe('gb');
  });

  it('defaults to us for anything unrecognised', () => {
    expect(countryCode('Atlantis')).toBe('us');
  });
});

// ---------------------------------------------------------------------------
// Keyword metrics
// ---------------------------------------------------------------------------

describe('keyword metrics normalizers', () => {
  const volumeItem: DfsVolumeItem = {
    keyword: 'best crm',
    search_volume: 12_100,
    cpc: 14.32,
    competition: 0.87,
    monthly_searches: [
      // Deliberately out of order — the normalizer must sort chronologically.
      { year: 2026, month: 1, search_volume: 14_000 },
      { year: 2025, month: 8, search_volume: 9_000 },
      { year: 2025, month: 9, search_volume: 9_500 },
      { year: 2025, month: 10, search_volume: 10_000 },
      { year: 2025, month: 11, search_volume: 11_000 },
      { year: 2025, month: 12, search_volume: 13_000 },
    ],
  };

  it('maps volume, CPC and competition', () => {
    const m = toMetrics(volumeItem, 62);
    expect(m.volume).toBe(12_100);
    expect(m.cpc).toBe(14.32);
    expect(m.competition).toBe(0.87);
    expect(m.difficulty).toBe(62);
  });

  it('sorts monthly volumes chronologically', () => {
    const months = toMetrics(volumeItem, null).monthly_volumes ?? [];
    expect(months[0]).toMatchObject({ year: 2025, month: 8 });
    expect(months[months.length - 1]).toMatchObject({ year: 2026, month: 1 });
  });

  it('reports a rising trend as positive', () => {
    const m = toMetrics(volumeItem, null);
    expect(m.trend).not.toBeNull();
    expect(m.trend as number).toBeGreaterThan(0);
  });

  it('preserves explicit nulls rather than coercing them to zero', () => {
    // Keyword Planner returns null for keywords with no data; a zero would read
    // as "measured, no demand" instead of "unknown".
    const m = toMetrics({ keyword: 'obscure', search_volume: null, cpc: null }, null);
    expect(m.volume).toBeNull();
    expect(m.cpc).toBeNull();
    expect(m.monthly_volumes).toBeUndefined();
  });

  it('reads the nested keyword_info shape used by the ideas endpoint', () => {
    const idea: DfsIdeaItem = {
      keyword: 'crm for startups',
      keyword_info: { search_volume: 480, cpc: 9.1, competition: 0.4 },
      keyword_properties: { keyword_difficulty: 31 },
    };
    const m = ideaToMetrics(idea);
    expect(m.keyword).toBe('crm for startups');
    expect(m.volume).toBe(480);
    expect(m.difficulty).toBe(31);
  });

  it('survives an idea item with no metrics attached', () => {
    const m = ideaToMetrics({ keyword: 'bare' });
    expect(m.volume).toBeNull();
    expect(m.difficulty).toBeNull();
  });
});

describe('computeTrend', () => {
  it('returns null below six months, where a trend would be noise', () => {
    expect(computeTrend([{ volume: 1 }, { volume: 2 }, { volume: 3 }])).toBeNull();
  });

  it('is positive for growth and negative for decline', () => {
    const rising = Array.from({ length: 12 }, (_, i) => ({ volume: 100 + i * 50 }));
    const falling = Array.from({ length: 12 }, (_, i) => ({ volume: 700 - i * 50 }));
    expect(computeTrend(rising) as number).toBeGreaterThan(0);
    expect(computeTrend(falling) as number).toBeLessThan(0);
  });

  it('is near zero for a flat series', () => {
    expect(Math.abs(computeTrend(Array.from({ length: 12 }, () => ({ volume: 500 }))) as number)).toBeLessThan(1);
  });

  it('does not divide by zero when the series starts at zero', () => {
    const t = computeTrend([...Array(6).fill({ volume: 0 }), ...Array(6).fill({ volume: 100 })]);
    expect(t === null || Number.isFinite(t)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PageSpeed Insights
// ---------------------------------------------------------------------------

const psiFixture: PsiResponse = {
  lighthouseResult: {
    categories: { performance: { score: 0.43 } },
    audits: {
      'largest-contentful-paint': { id: 'largest-contentful-paint', title: 'LCP', numericValue: 4210.7, score: 0.2 },
      'cumulative-layout-shift': { id: 'cumulative-layout-shift', title: 'CLS', numericValue: 0.2431, score: 0.4 },
      'first-contentful-paint': { id: 'first-contentful-paint', title: 'FCP', numericValue: 1800, score: 0.8 },
      'server-response-time': { id: 'server-response-time', title: 'TTFB', numericValue: 620, score: 0.6 },
      'unused-javascript': {
        id: 'unused-javascript',
        title: 'Reduce unused JavaScript',
        description: 'See the [docs](https://web.dev/unused-js) for details.',
        score: 0.3,
        scoreDisplayMode: 'metricSavings',
        details: { overallSavingsMs: 1500 },
      },
      'render-blocking-resources': {
        id: 'render-blocking-resources',
        title: 'Eliminate render-blocking resources',
        description: 'Resources block first paint.',
        score: 0.5,
        scoreDisplayMode: 'numeric',
        details: { overallSavingsMs: 300 },
      },
      'passing-audit': { id: 'passing-audit', title: 'Passes', score: 1, scoreDisplayMode: 'numeric' },
      'not-applicable': { id: 'not-applicable', title: 'N/A', score: null, scoreDisplayMode: 'notApplicable' },
    },
  },
  loadingExperience: {
    overall_category: 'SLOW',
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4100, category: 'SLOW' },
      INTERACTION_TO_NEXT_PAINT: { percentile: 340, category: 'SLOW' },
      // CrUX reports CLS multiplied by 100.
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 18, category: 'AVERAGE' },
      FIRST_CONTENTFUL_PAINT_MS: { percentile: 2200, category: 'AVERAGE' },
    },
  },
};

describe('PageSpeed normalizer', () => {
  const out = shapePageSpeedResponse('https://slow.example', 'mobile', psiFixture);

  it('converts the 0-1 Lighthouse score to 0-100', () => {
    expect(out.performance_score).toBe(43);
  });

  it('converts CrUX CLS back from its x100 integer form', () => {
    // 18 in the API means a real CLS of 0.18.
    expect(out.field_data?.cls).toBeCloseTo(0.18, 3);
  });

  it('keeps field and lab data separate', () => {
    expect(out.field_data?.lcp).toBe(4100);
    expect(out.lab_data.lcp).toBe(4211);
    expect(out.lab_data.cls).toBeCloseTo(0.243, 3);
  });

  it('maps a non-GOOD overall_category to a failing assessment', () => {
    expect(out.passes_cwv).toBe(false);
  });

  it('lists only failing audits, ordered by estimated savings', () => {
    const ids = out.opportunities.map((o) => o.id);
    expect(ids).toContain('unused-javascript');
    expect(ids).not.toContain('passing-audit');
    expect(ids).not.toContain('not-applicable');
    expect(out.opportunities[0]?.id).toBe('unused-javascript');
  });

  it('strips markdown links out of audit descriptions', () => {
    const audit = out.opportunities.find((o) => o.id === 'unused-javascript');
    expect(audit?.description).toContain('docs');
    expect(audit?.description).not.toContain('](');
  });

  it('reports field_data as null when the URL has no CrUX data', () => {
    const noField = shapePageSpeedResponse('https://tiny.example', 'mobile', {
      lighthouseResult: psiFixture.lighthouseResult,
    });
    expect(noField.field_data).toBeNull();
    // Unknown is not the same as passing.
    expect(noField.passes_cwv).toBeNull();
    expect(noField.lab_data.lcp).toBe(4211);
  });

  it('handles a completely empty response without throwing', () => {
    const empty = shapePageSpeedResponse('https://x.example', 'desktop', {});
    expect(empty.performance_score).toBeNull();
    expect(empty.opportunities).toEqual([]);
  });
});

describe('pageSpeedToActions', () => {
  it('raises an action naming each failing vital, and says the data is real-user', () => {
    const actions = pageSpeedToActions(shapePageSpeedResponse('https://slow.example', 'mobile', psiFixture));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toMatch(/Core Web Vital/);
    expect(actions[0]?.detail).toMatch(/LCP is 4100ms/);
    expect(actions[0]?.detail).toMatch(/real Chrome users/);
  });

  it('says nothing when every vital passes', () => {
    const good = shapePageSpeedResponse('https://fast.example', 'mobile', {
      loadingExperience: {
        overall_category: 'FAST',
        metrics: {
          LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1200 },
          INTERACTION_TO_NEXT_PAINT: { percentile: 120 },
          CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 },
        },
      },
    });
    expect(good.passes_cwv).toBe(true);
    expect(pageSpeedToActions(good)).toHaveLength(0);
  });

  it('labels lab-only results as directional rather than a ranking signal', () => {
    const labOnly = shapePageSpeedResponse('https://x.example', 'mobile', {
      lighthouseResult: psiFixture.lighthouseResult,
    });
    const actions = pageSpeedToActions(labOnly);
    expect(actions[0]?.detail).toMatch(/No real-user data/);
    expect(actions[0]?.evidence?.['data_source']).toBe('lab (Lighthouse)');
  });

  it('uses Google\'s published thresholds', () => {
    expect(CWV_THRESHOLDS.lcp.good).toBe(2500);
    expect(CWV_THRESHOLDS.inp.good).toBe(200);
    expect(CWV_THRESHOLDS.cls.good).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// AI visibility
// ---------------------------------------------------------------------------

describe('analyzeMention', () => {
  const answer =
    'For most teams I would start with Notion, which handles docs and databases together. ' +
    'Airtable is stronger for relational data. Coda sits between the two.';

  it('finds the brand and records where it appears', () => {
    const r = analyzeMention(answer, 'Notion', 'notion.so', ['Airtable', 'Coda'], ['notion.so', 'g2.com']);
    expect(r.brand_mentioned).toBe(true);
    expect(r.mention_position).toBeLessThan(0.5);
    expect(r.domain_cited).toBe(true);
  });

  it('lists competitors in order of first appearance', () => {
    const r = analyzeMention(answer, 'Notion', '', ['Coda', 'Airtable'], []);
    expect(r.competitors_mentioned).toEqual(['Airtable', 'Coda']);
  });

  it('does not match a brand inside a longer word', () => {
    // "Coda" must not match inside "Codator".
    const r = analyzeMention('We recommend Codator for this.', 'Coda', '', [], []);
    expect(r.brand_mentioned).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(analyzeMention('try NOTION today', 'Notion', '', [], []).brand_mentioned).toBe(true);
  });

  it('returns the sentence containing the mention, for tone review', () => {
    const r = analyzeMention(answer, 'Airtable', '', [], []);
    expect(r.mention_context).toContain('Airtable is stronger');
  });

  it('reports absence cleanly rather than throwing', () => {
    const r = analyzeMention(answer, 'Salesforce', 'salesforce.com', ['Airtable'], ['g2.com']);
    expect(r.brand_mentioned).toBe(false);
    expect(r.mention_position).toBeNull();
    expect(r.mention_context).toBeNull();
    expect(r.domain_cited).toBe(false);
    // A competitor named while we are absent is the signal that matters.
    expect(r.competitors_mentioned).toEqual(['Airtable']);
  });

  it('does not count the brand as its own competitor', () => {
    const r = analyzeMention(answer, 'Notion', '', ['Notion', 'Airtable'], []);
    expect(r.competitors_mentioned).not.toContain('Notion');
  });

  it('escapes regex metacharacters in a brand name', () => {
    expect(() => analyzeMention('We like C++ here', 'C++', '', [], [])).not.toThrow();
    expect(analyzeMention('We like C++ here', 'C++', '', [], []).brand_mentioned).toBe(true);
  });

  it('matches brands that end in punctuation', () => {
    // `\b` after a non-word character never matches, so a naive
    // `\bC\+\+\b` reports every punctuated brand as absent.
    for (const [brand, text] of [
      ['C++', 'We like C++ here'],
      ['Yahoo!', 'Try Yahoo! for search'],
      ['AT&T', 'AT&T offers fibre'],
    ] as const) {
      expect(analyzeMention(text, brand, '', [], []).brand_mentioned, `${brand} not found`).toBe(true);
    }
  });

  it('still refuses a partial match for a punctuated brand', () => {
    expect(analyzeMention('We use C++builder daily', 'C++', '', [], []).brand_mentioned).toBe(false);
  });

  it('handles an empty answer', () => {
    const r = analyzeMention('', 'Brand', 'brand.com', ['X'], []);
    expect(r.brand_mentioned).toBe(false);
    expect(r.answer_excerpt).toBe('');
  });
});

describe('defaultPrompts', () => {
  it('covers the buyer-intent query shapes', () => {
    const categories = defaultPrompts('project management software').map((p) => p.category);
    expect(categories).toContain('recommendation');
    expect(categories).toContain('comparison');
    expect(categories).toContain('pricing');
  });

  it('adds brand-direct and defensive prompts once a brand is known', () => {
    const withBrand = defaultPrompts('crm', 'Acme');
    const categories = withBrand.map((p) => p.category);
    expect(categories).toContain('brand-direct');
    expect(categories).toContain('brand-defensive');
    expect(withBrand.some((p) => p.prompt.includes('Acme'))).toBe(true);
  });
});

describe('aiVisibilityToActions', () => {
  it('flags low visibility as a high-priority problem', () => {
    const actions = aiVisibilityToActions({
      brand: 'Acme',
      domain: 'acme.com',
      model: 'claude-opus-5',
      queries_run: 5,
      visibility_rate: 20,
      citation_rate: 0,
      visibility_score: 18,
      results: [],
      competitor_share: [{ name: 'Rival', mentions: 4, share_pct: 40 }],
      losing_prompts: ['What is the best crm?'],
    });
    expect(actions.some((a) => a.id === 'ai.low_visibility' && a.priority === 'high')).toBe(true);
    expect(actions.some((a) => a.id === 'ai.competitor_dominance')).toBe(true);
  });

  it('flags the mentioned-but-not-cited case separately', () => {
    const actions = aiVisibilityToActions({
      brand: 'Acme',
      domain: 'acme.com',
      model: 'claude-opus-5',
      queries_run: 5,
      visibility_rate: 80,
      citation_rate: 10,
      visibility_score: 62,
      results: [],
      competitor_share: [],
      losing_prompts: [],
    });
    expect(actions.some((a) => a.id === 'ai.mentioned_not_cited')).toBe(true);
    expect(actions.some((a) => a.id === 'ai.low_visibility')).toBe(false);
  });

  it('says nothing when visibility is strong', () => {
    expect(
      aiVisibilityToActions({
        brand: 'Acme',
        domain: 'acme.com',
        model: 'claude-opus-5',
        queries_run: 5,
        visibility_rate: 95,
        citation_rate: 70,
        visibility_score: 90,
        results: [],
        competitor_share: [{ name: 'Rival', mentions: 1, share_pct: 8 }],
        losing_prompts: [],
      }),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Search Console helpers
// ---------------------------------------------------------------------------

describe('GSC date helpers', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(daysAgo(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('goes backwards in time', () => {
    expect(daysAgo(30) < daysAgo(0)).toBe(true);
  });

  it('leaves a lag window, since Search Console data is not final for ~3 days', () => {
    // Ending a range on today produces a fake decline an agent would report as
    // a ranking drop.
    expect(GSC_LAG_DAYS).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Backlinks and domain authority
// ---------------------------------------------------------------------------

describe('Open PageRank normalizer', () => {
  it('scales the 0-10 score onto the shared 0-100 authority range', () => {
    const out = normalizeOpenPageRankResponse({
      status_code: 200,
      response: [
        { domain: 'strong.com', page_rank_decimal: 8.4, rank: '1250' },
        { domain: 'weak.com', page_rank_decimal: 1.2, rank: '9000000' },
      ],
    });
    expect(out[0]?.authority).toBeCloseTo(84, 1);
    expect(out[1]?.authority).toBeCloseTo(12, 1);
  });

  it('falls back to the integer score when the decimal is absent', () => {
    const out = normalizeOpenPageRankResponse({ response: [{ domain: 'a.com', page_rank_integer: 5 }] });
    expect(out[0]?.authority).toBeCloseTo(50, 1);
  });

  it('coerces the string rank to a number', () => {
    const out = normalizeOpenPageRankResponse({ response: [{ domain: 'a.com', page_rank_decimal: 3, rank: '4200' }] });
    expect(out[0]?.rank).toBe(4200);
  });

  it('returns null authority for an unrated domain rather than zero', () => {
    // Zero would read as "measured, no authority" instead of "unknown".
    const out = normalizeOpenPageRankResponse({ response: [{ domain: 'unknown.com', rank: null }] });
    expect(out[0]?.authority).toBeNull();
    expect(out[0]?.rank).toBeNull();
  });

  it('skips entries with no domain and handles an empty response', () => {
    expect(normalizeOpenPageRankResponse({ response: [{ page_rank_decimal: 5 }] })).toHaveLength(0);
    expect(normalizeOpenPageRankResponse({})).toEqual([]);
  });
});

describe('DataForSEO backlink normalizers', () => {
  it('scales the 0-1000 rank onto the shared 0-100 authority range', () => {
    const a = normalizeDfsSummary('strong.com', { rank: 840, backlinks: 120_000, referring_main_domains: 4_300 });
    expect(a.authority).toBeCloseTo(84, 1);
    expect(a.backlinks).toBe(120_000);
    expect(a.referring_domains).toBe(4_300);
  });

  it('agrees with Open PageRank once both are scaled', () => {
    // The whole point of the two conversions is that a DR-84 site reads as 84
    // regardless of which provider measured it.
    const viaOpr = normalizeOpenPageRankResponse({ response: [{ domain: 'x.com', page_rank_decimal: 8.4 }] })[0];
    const viaDfs = normalizeDfsSummary('x.com', { rank: 840 });
    expect(viaOpr?.authority).toBeCloseTo(viaDfs.authority as number, 1);
  });

  it('prefers referring_main_domains but falls back when it is absent', () => {
    expect(normalizeDfsSummary('a.com', { referring_domains: 99 }).referring_domains).toBe(99);
    expect(
      normalizeDfsSummary('a.com', { referring_domains: 99, referring_main_domains: 40 }).referring_domains,
    ).toBe(40);
  });

  it('returns nulls for a domain with no summary data', () => {
    const a = normalizeDfsSummary('nothing.com', undefined);
    expect(a.authority).toBeNull();
    expect(a.backlinks).toBeNull();
    expect(a.domain).toBe('nothing.com');
  });

  it('maps backlink rows and reads dofollow:false as nofollow', () => {
    const links = normalizeDfsBacklinks(
      [
        {
          url_from: 'https://ref.com/post',
          url_to: 'https://target.com/page',
          anchor: 'great tool',
          domain_from_rank: 620,
          page_from_rank: 410,
          dofollow: true,
          first_seen: '2025-01-01 00:00:00 +00:00',
          item_type: 'anchor',
        },
        { url_from: 'https://spam.io/x', dofollow: false },
        { anchor: 'no url' },
      ],
      'https://target.com',
    );

    expect(links).toHaveLength(2);
    expect(links[0]?.nofollow).toBe(false);
    expect(links[0]?.domain_authority).toBe(62);
    expect(links[0]?.page_authority).toBe(41);
    // domain_from omitted, so it must be derived from url_from.
    expect(links[0]?.domain_from).toBe('ref.com');
    expect(links[1]?.nofollow).toBe(true);
    // url_to omitted on the second row: falls back to the requested target.
    expect(links[1]?.url_to).toBe('https://target.com');
  });

  it('treats an absent dofollow flag as followed', () => {
    // Only an explicit false means nofollow; undefined must not be coerced.
    expect(normalizeDfsBacklinks([{ url_from: 'https://a.com/x' }], 't')[0]?.nofollow).toBe(false);
  });
});

describe('ranked-keywords normalizer (powers seo_content_gap)', () => {
  it('reads the nested keyword_data shape and the outer SERP position', () => {
    const rows = normalizeRankedKeywords([
      {
        keyword_data: {
          keyword: 'best crm',
          keyword_info: { search_volume: 12_100, cpc: 14.3 },
          keyword_properties: { keyword_difficulty: 71 },
        },
        ranked_serp_element: { serp_item: { rank_group: 4, rank_absolute: 6, url: 'https://rival.com/crm' } },
      } as never,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyword).toBe('best crm');
    expect(rows[0]?.volume).toBe(12_100);
    expect(rows[0]?.difficulty).toBe(71);
    // rank_group, not rank_absolute, is the organic position.
    expect(rows[0]?.position).toBe(4);
    expect(rows[0]?.url).toBe('https://rival.com/crm');
  });

  it('also accepts a flat row, so a dropped wrapper degrades to working', () => {
    const rows = normalizeRankedKeywords([
      { keyword: 'flat shape', keyword_info: { search_volume: 90 } } as never,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.volume).toBe(90);
  });

  it('falls back to rank_absolute when rank_group is absent', () => {
    const rows = normalizeRankedKeywords([
      {
        keyword_data: { keyword: 'k' },
        ranked_serp_element: { serp_item: { rank_absolute: 9, url: 'https://x.com' } },
      } as never,
    ]);
    expect(rows[0]?.position).toBe(9);
  });

  it('skips rows with no keyword and survives a missing SERP element', () => {
    const rows = normalizeRankedKeywords([
      { keyword_data: {} } as never,
      { keyword_data: { keyword: 'no serp' } } as never,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.position).toBe(0);
    expect(rows[0]?.url).toBe('');
  });

  it('returns an empty list rather than throwing on empty input', () => {
    expect(normalizeRankedKeywords([])).toEqual([]);
  });
});

describe('link-gap normalizer', () => {
  // The request maps 1-indexed keys to competitor domains; the response echoes
  // those keys inside `intersections`.
  const targets = { '1': 'rival-a.com', '2': 'rival-b.com', '3': 'rival-c.com' };

  it('translates intersection keys back into competitor domains', () => {
    const rows = normalizeLinkGap(
      [{ domain: 'prospect.com', rank: 540, intersections: { '1': {}, '3': {} } }],
      targets,
    );
    expect(rows[0]?.links_to).toEqual(['rival-a.com', 'rival-c.com']);
    expect(rows[0]?.links_to).not.toContain('rival-b.com');
    // Same 0-1000 -> 0-100 scaling as the summary endpoint.
    expect(rows[0]?.authority).toBe(54);
  });

  it('drops intersection keys that are not in the request map', () => {
    const rows = normalizeLinkGap([{ domain: 'p.com', intersections: { '1': {}, '99': {} } }], targets);
    expect(rows[0]?.links_to).toEqual(['rival-a.com']);
  });

  it('yields an empty links_to rather than failing when intersections is absent', () => {
    const rows = normalizeLinkGap([{ domain: 'p.com', rank: 100 }], targets);
    expect(rows[0]?.links_to).toEqual([]);
    expect(rows[0]?.authority).toBe(10);
  });

  it('skips rows with no domain', () => {
    expect(normalizeLinkGap([{ rank: 500 }], targets)).toHaveLength(0);
  });
});

describe('AI brand sentiment', () => {
  /** Minimal stand-in for the SDK surface `analyzeSentiment` uses. */
  const fakeClient = (text: string | null, throws = false) =>
    ({
      messages: {
        create: async () => {
          if (throws) throw new Error('api down');
          return { content: text === null ? [] : [{ type: 'text', text }] };
        },
      },
    }) as never;

  const mentions = [
    { prompt: 'best crm?', context: 'Acme is the best value for small teams.' },
    { prompt: 'acme review?', context: 'Acme is cheap but its API is unreliable.' },
  ];

  it('scores an even split of praise and criticism as mixed, not neutral', async () => {
    const out = await analyzeSentiment(
      fakeClient(
        JSON.stringify({
          mentions: [
            { index: 0, sentiment: 'positive', claim: 'best value for small teams' },
            { index: 1, sentiment: 'negative', claim: 'API is unreliable' },
          ],
          strengths: ['value for money'],
          weaknesses: ['unreliable API'],
          inaccuracies: [],
        }),
      ),
      'claude-opus-5',
      'Acme',
      mentions,
    );
    // An even split averages to 0, which must not be reported as indifference.
    expect(out?.score).toBe(0);
    expect(out?.label).toBe('mixed');
    expect(out?.weaknesses).toEqual(['unreliable API']);
  });

  it('labels uniform praise positive and uniform criticism negative', async () => {
    const pos = await analyzeSentiment(
      fakeClient(JSON.stringify({
        mentions: [{ index: 0, sentiment: 'positive', claim: 'great' }, { index: 1, sentiment: 'positive', claim: 'solid' }],
        strengths: ['reliable'], weaknesses: [], inaccuracies: [],
      })),
      'claude-opus-5', 'Acme', mentions,
    );
    expect(pos?.label).toBe('positive');
    expect(pos?.score).toBe(100);

    const neg = await analyzeSentiment(
      fakeClient(JSON.stringify({
        mentions: [{ index: 0, sentiment: 'negative', claim: 'buggy' }, { index: 1, sentiment: 'negative', claim: 'slow' }],
        strengths: [], weaknesses: ['buggy', 'slow'], inaccuracies: [],
      })),
      'claude-opus-5', 'Acme', mentions,
    );
    expect(neg?.label).toBe('negative');
    expect(neg?.score).toBe(-100);
  });

  it('maps verdicts back to the prompt that produced them', async () => {
    const out = await analyzeSentiment(
      fakeClient(JSON.stringify({
        mentions: [{ index: 1, sentiment: 'negative', claim: 'API is unreliable' }],
        strengths: [], weaknesses: ['unreliable API'], inaccuracies: [],
      })),
      'claude-opus-5', 'Acme', mentions,
    );
    expect(out?.mentions[0]?.prompt).toBe('acme review?');
  });

  it('discards out-of-range indices rather than crashing', async () => {
    const out = await analyzeSentiment(
      fakeClient(JSON.stringify({
        mentions: [
          { index: 99, sentiment: 'positive', claim: 'phantom' },
          { index: 0, sentiment: 'positive', claim: 'real' },
        ],
        strengths: [], weaknesses: [], inaccuracies: [],
      })),
      'claude-opus-5', 'Acme', mentions,
    );
    expect(out?.mentions).toHaveLength(1);
    expect(out?.mentions[0]?.claim).toBe('real');
  });

  it('returns null with no mentions, so no request is made', async () => {
    expect(await analyzeSentiment(fakeClient(null, true), 'claude-opus-5', 'Acme', [])).toBeNull();
  });

  it('degrades to null rather than failing the whole report', async () => {
    expect(await analyzeSentiment(fakeClient(null, true), 'claude-opus-5', 'Acme', mentions)).toBeNull();
    expect(await analyzeSentiment(fakeClient('not json at all'), 'claude-opus-5', 'Acme', mentions)).toBeNull();
  });
});

describe('sentiment-driven actions', () => {
  const base = {
    brand: 'Acme', domain: 'acme.com', model: 'claude-opus-5', queries_run: 5,
    visibility_rate: 90, citation_rate: 60, visibility_score: 85,
    results: [], competitor_share: [], losing_prompts: [],
  };

  it('raises an action when the narrative is negative, even at high visibility', () => {
    // Being named often is not success if the description is bad.
    const actions = aiVisibilityToActions({
      ...base,
      sentiment: {
        score: -60, label: 'negative',
        mentions: [{ prompt: 'p', sentiment: 'negative', claim: 'unreliable' }],
        strengths: [], weaknesses: ['unreliable API', 'poor support'], inaccuracies: [],
      },
    });
    const a = actions.find((x) => x.id === 'ai.negative_narrative');
    expect(a?.priority).toBe('high');
    expect(a?.detail).toMatch(/unreliable API/);
  });

  it('flags factually wrong claims as their own cheap fix', () => {
    const actions = aiVisibilityToActions({
      ...base,
      sentiment: {
        score: 40, label: 'positive', mentions: [],
        strengths: ['fast'], weaknesses: [],
        inaccuracies: ['claims pricing starts at $99 when it starts at $29'],
      },
    });
    const a = actions.find((x) => x.id === 'ai.factual_inaccuracies');
    expect(a?.priority).toBe('high');
    expect(a?.effort).toBe('small');
  });

  it('stays quiet when sentiment is positive and accurate', () => {
    expect(
      aiVisibilityToActions({
        ...base,
        sentiment: { score: 80, label: 'positive', mentions: [], strengths: ['reliable'], weaknesses: [], inaccuracies: [] },
      }),
    ).toHaveLength(0);
  });

  it('stays quiet when sentiment analysis was skipped', () => {
    expect(aiVisibilityToActions({ ...base, sentiment: null })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Capability reporting
// ---------------------------------------------------------------------------
//
// `Capability.tools` is documented as "tools that work at full fidelity". Open
// PageRank implements authority() only, so listing seo_backlinks and
// seo_link_gap under it told an agent to call two tools that then throw
// INVALID_INPUT. A partially-available capability has to say so.

describe('describeCapabilities: backlinks fidelity', () => {
  const backlinksCap = (over: Partial<Config['backlinks']>) =>
    describeCapabilities(
      loadConfig({ backlinks: { provider: 'none', ...over } as Config['backlinks'] }),
    ).find((c) => c.name === 'backlinks')!;

  it('reports only the authority tool under Open PageRank', () => {
    const cap = backlinksCap({ provider: 'openpagerank', openPageRankKey: 'test-key' });
    expect(cap.available).toBe(true);
    expect(cap.tools).toEqual(['seo_domain_authority']);
    expect(cap.tools).not.toContain('seo_backlinks');
    expect(cap.tools).not.toContain('seo_link_gap');
  });

  it('tells the agent what to set to get link-level data', () => {
    const cap = backlinksCap({ provider: 'openpagerank', openPageRankKey: 'test-key' });
    expect(cap.unlock_with).toEqual(['DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD']);
    expect(cap.degraded_to).toMatch(/seo_backlinks and seo_link_gap are unavailable/);
  });

  it('reports all three tools under DataForSEO, with nothing left to unlock', () => {
    const cap = backlinksCap({ provider: 'dataforseo', login: 'u', password: 'p' });
    expect(cap.tools).toEqual(['seo_backlinks', 'seo_domain_authority', 'seo_link_gap']);
    expect(cap.unlock_with).toBeUndefined();
  });

  it('offers both the free and paid route when nothing is configured', () => {
    const cap = backlinksCap({});
    expect(cap.available).toBe(false);
    expect(cap.unlock_with).toContain('OPENPAGERANK_API_KEY');
  });
});
