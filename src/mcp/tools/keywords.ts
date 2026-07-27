import { z } from 'zod';
import { defineTool, limitSchema, locationSchema, languageSchema } from '../runtime.js';
import { expandKeyword, rankSuggestions, type SuggestEngine } from '../../keywords/suggest.js';
import { classifyIntent, isQuestion } from '../../keywords/intent.js';
import { difficultyFromLexical, difficultyFromSerp, personalizeDifficulty } from '../../keywords/difficulty.js';
import { scoreKeywords, scoreOpportunity, estimateClicks } from '../../keywords/score.js';
import { clusterByLexical, clusterBySerp, toKeywords, clusterPageSpec } from '../../keywords/cluster.js';
import { getKeywordMetrics, createKeywordMetricsProvider } from '../../providers/keyword-metrics.js';
import { getSerp, createSerpProvider } from '../../providers/serp.js';
import { getAuthorityScores } from '../../providers/backlinks.js';
import { saveKeywords, getKeywords } from '../../store/index.js';
import { spill } from '../../core/envelope.js';
import { invalidInput } from '../../core/errors.js';
import { mapLimit } from '../../core/http.js';
import type { Keyword, SerpData } from '../../core/types.js';
import { round } from '../../core/text.js';

/**
 * Keyword research.
 *
 * Discovery is free (autocomplete mining); metrics are provider-gated. The tools
 * are designed so the free path is genuinely useful on its own rather than a
 * teaser — you can build a full content plan with no keys, you just won't have
 * absolute search volumes.
 */

export const keywordIdeasTool = defineTool({
  name: 'seo_keyword_ideas',
  title: 'Discover keywords from a seed',
  description:
    'Mine hundreds of real keyword ideas from search-engine autocomplete (Google, Bing, DuckDuckGo). ' +
    'Uses alphabet-soup, question, preposition and commercial-modifier expansion — the same technique behind ' +
    "Ahrefs' Search Suggestions report. Every suggestion is a query real people typed. " +
    'Returns intent classification and opportunity scores. Enriches with volume/CPC/difficulty when a metrics ' +
    'provider is configured, and still ranks results sensibly when one is not. Needs no API keys.',
  inputSchema: {
    seed: z.string().describe('Seed keyword or topic, e.g. "project management software".'),
    engines: z.array(z.enum(['google', 'bing', 'duckduckgo'])).optional()
      .describe('Autocomplete sources. More engines means broader coverage and cross-source agreement scoring.'),
    strategies: z.array(z.enum(['plain', 'alphabet', 'digits', 'questions', 'prepositions', 'comparisons', 'commercial'])).optional()
      .describe('Expansion strategies. Default covers plain, alphabet, questions, prepositions and commercial modifiers.'),
    depth: z.number().int().min(1).max(2).optional().default(1)
      .describe('Set to 2 to re-expand the strongest results for deeper long-tail. Roughly 10x the requests.'),
    include_only: z.enum(['all', 'questions', 'commercial', 'long_tail']).optional().default('all')
      .describe('Filter the result set. "long_tail" keeps 4+ word phrases.'),
    with_metrics: z.boolean().optional().default(true)
      .describe('Fetch volume/CPC/difficulty if a provider is configured. Costs provider credits.'),
    location: locationSchema,
    language: languageSchema,
    save_to_project: z.string().optional().describe('Persist the results under this project name.'),
    limit: limitSchema(1000, 100),
  },
  async handler(args, ctx) {
    const country = (args.location ?? ctx.cfg.defaults.location).toLowerCase().includes('united kingdom') ? 'gb' : 'us';
    const expansion = await expandKeyword(args.seed, {
      engines: (args.engines ?? ['google']) as SuggestEngine[],
      ...(args.strategies ? { strategies: args.strategies } : {}),
      depth: args.depth,
      language: args.language ?? ctx.cfg.defaults.language,
      country,
    });

    const ranked = rankSuggestions(expansion.suggestions, expansion.agreement);
    let keywords = toKeywords(
      ranked.map((r) => ({ keyword: r.keyword, source: 'suggest' })),
      { source: 'suggest' },
    );

    switch (args.include_only) {
      case 'questions':
        keywords = keywords.filter((k) => isQuestion(k.keyword));
        break;
      case 'commercial':
        keywords = keywords.filter((k) => k.intent === 'commercial' || k.intent === 'transactional');
        break;
      case 'long_tail':
        keywords = keywords.filter((k) => k.words >= 4);
        break;
      default:
        break;
    }

    const warnings: string[] = [];
    let cost = 0;
    let source = 'google-suggest';

    if (args.with_metrics && createKeywordMetricsProvider(ctx.cfg)) {
      try {
        // Only enrich the top slice — enriching 2,000 keywords burns credits on
        // a tail the agent will never look at.
        const toEnrich = keywords.slice(0, Math.min(args.limit * 2, 400)).map((k) => k.keyword);
        const { metrics, cost: c, provider } = await getKeywordMetrics(ctx.cfg, toEnrich, {
          ...(args.location ? { location: args.location } : {}),
          ...(args.language ? { language: args.language } : {}),
        });
        cost += c;
        source = `google-suggest + ${provider}`;
        keywords = keywords.map((k) => {
          const m = metrics.get(k.keyword) ?? metrics.get(k.keyword.toLowerCase());
          if (!m) return k;
          return { ...k, volume: m.volume, cpc: m.cpc, difficulty: m.difficulty };
        });
      } catch (err) {
        warnings.push(
          `Keyword metrics unavailable, returning discovery data only: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Any keyword still missing metrics gets a clearly-labelled lexical
    // difficulty estimate, and the agent is always told why volume is null.
    // Returning a wall of nulls with no explanation invites an agent to treat
    // "unknown" as "zero demand" — and silently returning a *guessed* volume
    // would be worse still, so the honest answer is null plus a warning.
    if (keywords.some((k) => k.volume === null)) {
      warnings.push(
        args.with_metrics
          ? 'No keyword metrics provider configured, so volume, CPC and provider difficulty are null. ' +
            'Keywords are ranked by autocomplete position, cross-engine agreement and intent instead — ' +
            'a sound relative ordering, but not absolute demand. Difficulty values below are lexical ' +
            'estimates (low confidence). Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD for real volumes.'
          : 'with_metrics was false, so volume and CPC are null by request. Difficulty values below are ' +
            'lexical estimates (low confidence), and ordering is by autocomplete rank, cross-engine ' +
            'agreement and intent rather than by real search demand.',
      );
    }
    keywords = keywords.map((k) =>
      k.difficulty === null ? { ...k, difficulty: difficultyFromLexical(k.keyword).difficulty } : k,
    );

    const scored = scoreKeywords(keywords);
    if (args.save_to_project) saveKeywords(args.save_to_project, scored);

    const spilled = spill('seo_keyword_ideas', scored, args.limit);
    const withVolume = scored.filter((k) => k.volume !== null);

    return {
      summary:
        `Found ${scored.length} keyword ideas for "${args.seed}" from ${expansion.queries_made} autocomplete queries` +
        (withVolume.length > 0
          ? `; ${withVolume.length} have volume data totalling ${withVolume.reduce((s, k) => s + (k.volume ?? 0), 0)} searches/mo.`
          : ' (no volume data — see warnings).'),
      data: {
        seed: args.seed,
        total_found: scored.length,
        queries_made: expansion.queries_made,
        engines_used: expansion.engines_used,
        intent_breakdown: countBy(scored, (k) => k.intent),
        question_count: scored.filter((k) => isQuestion(k.keyword)).length,
        keywords: spilled.rows,
      },
      warnings,
      meta: {
        source,
        cost,
        ...spilled.meta,
        next: [
          'seo_cluster_keywords to group these into pages to write',
          'pseo_discover_patterns to find templatable programmatic-SEO opportunities',
          'seo_content_brief on the highest-opportunity keyword before writing',
        ],
      },
    };
  },
});

export const keywordMetricsTool = defineTool({
  name: 'seo_keyword_metrics',
  title: 'Get volume, CPC and difficulty',
  description:
    'Fetch search volume, CPC, competition, 12-month trend and keyword difficulty for a specific list of keywords. ' +
    'Requires a keyword metrics provider (DataForSEO). Results are cached for a week since the upstream data is monthly. ' +
    'Also returns a site-relative difficulty verdict when a backlinks provider is available.',
  inputSchema: {
    keywords: z.array(z.string()).min(1).max(1000).describe('Keywords to look up.'),
    location: locationSchema,
    language: languageSchema,
    your_domain: z.string().optional()
      .describe('Your domain. Enables personalised difficulty ("is this realistic for us?") rather than absolute difficulty.'),
    save_to_project: z.string().optional(),
  },
  async handler(args, ctx) {
    const { metrics, cost, cached_count, provider } = await getKeywordMetrics(ctx.cfg, args.keywords, {
      ...(args.location ? { location: args.location } : {}),
      ...(args.language ? { language: args.language } : {}),
    });

    let siteAuthority: number | null = null;
    if (args.your_domain) {
      const scores = await getAuthorityScores(ctx.cfg, [args.your_domain]);
      siteAuthority = [...scores.values()][0] ?? null;
    }

    const rows = args.keywords.map((kw) => {
      const m = metrics.get(kw) ?? metrics.get(kw.toLowerCase());
      const intentResult = classifyIntent(kw);
      const difficulty = m?.difficulty ?? null;
      const opportunity = scoreOpportunity({
        keyword: kw,
        volume: m?.volume ?? null,
        difficulty,
        cpc: m?.cpc ?? null,
        intent: intentResult.intent,
      });
      return {
        keyword: kw,
        volume: m?.volume ?? null,
        cpc: m?.cpc ?? null,
        competition: m?.competition ?? null,
        difficulty,
        trend_pct: m?.trend ?? null,
        monthly_volumes: m?.monthly_volumes ?? null,
        intent: intentResult.intent,
        intent_confidence: intentResult.confidence,
        opportunity: opportunity.opportunity,
        estimated_clicks_at_position_5: m?.volume ? estimateClicks(m.volume, 5) : null,
        ...(difficulty !== null && args.your_domain ? personalizeDifficulty(difficulty, siteAuthority) : {}),
      };
    });

    if (args.save_to_project) {
      saveKeywords(
        args.save_to_project,
        rows.map((r) => ({
          keyword: r.keyword,
          volume: r.volume,
          difficulty: r.difficulty,
          cpc: r.cpc,
          intent: r.intent,
          source: provider,
          words: r.keyword.split(/\s+/).length,
          opportunity: r.opportunity,
        })),
      );
    }

    const withData = rows.filter((r) => r.volume !== null);
    return {
      summary:
        `Metrics for ${args.keywords.length} keyword(s); ${withData.length} returned volume data ` +
        `(${withData.reduce((s, r) => s + (r.volume ?? 0), 0)} total searches/mo). ${cached_count} served from cache.`,
      data: {
        keywords: rows,
        total_volume: withData.reduce((s, r) => s + (r.volume ?? 0), 0),
        your_domain_authority: siteAuthority,
      },
      warnings:
        withData.length < args.keywords.length
          ? [`${args.keywords.length - withData.length} keyword(s) have no volume data upstream — usually means genuinely near-zero search volume.`]
          : [],
      meta: { source: provider, cost },
    };
  },
});

export const clusterKeywordsTool = defineTool({
  name: 'seo_cluster_keywords',
  title: 'Group keywords into pages',
  description:
    'Cluster a keyword list into topic groups, one per page to build. Each cluster gets a primary keyword, ' +
    'secondary keywords, recommended page type, and a suggested title/slug/H1. ' +
    'This is the step that turns a keyword list into a publishing queue. ' +
    'Uses SERP-overlap clustering (the accurate method) when a SERP provider is configured and use_serp is true, ' +
    'otherwise lexical clustering, which is free and works well on long-tail sets.',
  inputSchema: {
    keywords: z.array(z.string()).min(2).max(2000).optional()
      .describe('Keywords to cluster. Omit to use keywords stored under `project`.'),
    project: z.string().optional().describe('Load keywords from this stored project instead of passing them inline.'),
    use_serp: z.boolean().optional().default(false)
      .describe('Cluster by shared SERP results — much more accurate but costs one SERP call per keyword.'),
    min_overlap: z.number().min(0.1).max(1).optional().default(0.5)
      .describe('Lexical clustering threshold. Lower merges more aggressively.'),
    language: languageSchema,
    separate_questions: z.boolean().optional().default(false)
      .describe('Keep question keywords in their own clusters (they often belong in an FAQ, not a page).'),
    location: locationSchema,
    limit: limitSchema(300, 50),
  },
  async handler(args, ctx) {
    let keywords: Keyword[];
    if (args.keywords && args.keywords.length > 0) {
      keywords = toKeywords(args.keywords, { source: 'input' });
    } else if (args.project) {
      keywords = getKeywords(args.project, { limit: 2000 });
      if (keywords.length < 2) {
        // A plain Error here is reported as INTERNAL, whose remedy tells the
        // agent it found a bug in seo-agent and should report it. That is the
        // wrong instruction for a fixable argument problem: the agent stops
        // instead of passing keywords.
        throw invalidInput(
          `Project "${args.project}" has fewer than 2 stored keywords.`,
          'Run seo_keyword_ideas with save_to_project set to this project first, or pass the `keywords` array directly.',
        );
      }
    } else {
      throw invalidInput(
        'Neither `keywords` nor `project` was provided.',
        'Pass a `keywords` array, or a `project` that has stored keywords from a previous seo_keyword_ideas call with save_to_project.',
      );
    }

    // Difficulty feeds cluster ordering; supply a lexical estimate where missing.
    keywords = keywords.map((k) =>
      k.difficulty === null ? { ...k, difficulty: difficultyFromLexical(k.keyword).difficulty } : k,
    );
    keywords = scoreKeywords(keywords);

    const warnings: string[] = [];
    let cost = 0;
    let result;

    if (args.use_serp && createSerpProvider(ctx.cfg)) {
      const serps = new Map<string, SerpData>();
      // Cap SERP fetching: 2,000 keywords at one call each is an expensive
      // accident waiting to happen.
      const toFetch = keywords.slice(0, 100);
      if (keywords.length > toFetch.length) {
        warnings.push(
          `SERP clustering was applied to the top ${toFetch.length} keywords by opportunity; the remaining ` +
            `${keywords.length - toFetch.length} were clustered lexically to control cost.`,
        );
      }
      const fetched = await mapLimit(toFetch, 4, async (k) => {
        const r = await getSerp(ctx.cfg, { keyword: k.keyword, ...(args.location ? { location: args.location } : {}) });
        return { keyword: k.keyword, data: r.data, cost: r.cost };
      });
      for (const f of fetched) {
        if (!f.ok) continue;
        serps.set(f.value.keyword, f.value.data);
        cost += f.value.cost;
      }
      result = clusterBySerp(keywords, serps, {
        minOverlap: args.min_overlap,
        separateQuestions: args.separate_questions,
      });
    } else {
      if (args.use_serp) {
        warnings.push(
          'use_serp was requested but no SERP provider is configured; fell back to lexical clustering. ' +
            'Lexical clustering groups by shared word stems, so it will not merge synonyms that share no words.',
        );
      }
      result = clusterByLexical(keywords, {
        minOverlap: args.min_overlap,
        separateQuestions: args.separate_questions,
      });
    }

    const withSpecs = result.clusters.map((c) => ({
      ...c,
      keyword_count: c.keywords.length,
      page: clusterPageSpec(c, args.language ?? ctx.cfg.defaults.language),
    }));
    const spilled = spill('seo_cluster_keywords', withSpecs, args.limit);

    return {
      summary:
        `${keywords.length} keywords grouped into ${result.clusters.length} clusters using ${result.method} clustering` +
        (result.total_volume > 0 ? `, covering ${result.total_volume} searches/mo.` : '.') +
        ` Each cluster maps to one page to build.`,
      data: {
        method: result.method,
        cluster_count: result.clusters.length,
        total_volume: result.total_volume,
        unclustered: result.unclustered.slice(0, 50),
        clusters: spilled.rows,
      },
      warnings,
      meta: {
        source: result.method === 'serp' ? ctx.cfg.serp.provider : 'lexical',
        cost,
        ...spilled.meta,
        next: ['seo_content_brief on each cluster head before writing', 'pseo_discover_patterns if the clusters look templatable'],
      },
    };
  },
});

export const keywordDifficultyTool = defineTool({
  name: 'seo_keyword_difficulty',
  title: 'Estimate ranking difficulty',
  description:
    'Estimate how hard a keyword is to rank for, and whether it is realistic for your specific domain. ' +
    'With a SERP provider this analyses the actual top 10 (big brands, homepages, UGC, SERP features); ' +
    'with a backlinks provider it factors in real domain authority. Without either it returns a clearly-labelled ' +
    'lexical estimate with low confidence — always check the `method` and `confidence` fields before trusting the number.',
  inputSchema: {
    keywords: z.array(z.string()).min(1).max(50),
    your_domain: z.string().optional().describe('Your domain, for a site-relative "is this realistic" verdict.'),
    location: locationSchema,
  },
  async handler(args, ctx) {
    const hasSerp = Boolean(createSerpProvider(ctx.cfg));
    let cost = 0;
    const warnings: string[] = [];

    let siteAuthority: number | null = null;
    if (args.your_domain) {
      const scores = await getAuthorityScores(ctx.cfg, [args.your_domain]);
      siteAuthority = [...scores.values()][0] ?? null;
      if (siteAuthority === null) {
        warnings.push(
          'No backlinks provider configured, so no domain authority for your site. ' +
            'Personalised difficulty falls back to absolute difficulty.',
        );
      }
    }

    const results = await mapLimit(args.keywords, 3, async (kw) => {
      if (!hasSerp) return { keyword: kw, estimate: difficultyFromLexical(kw), serp_top3: [] as string[] };
      const { data, cost: c } = await getSerp(ctx.cfg, {
        keyword: kw,
        ...(args.location ? { location: args.location } : {}),
      });
      cost += c;
      const domains = data.results.slice(0, 10).map((r) => r.domain);
      const authority = await getAuthorityScores(ctx.cfg, domains);
      return {
        keyword: kw,
        estimate: difficultyFromSerp(data, authority),
        serp_top3: data.results.slice(0, 3).map((r) => r.url),
      };
    });

    if (!hasSerp) {
      warnings.push(
        'No SERP provider configured. Difficulty scores are lexical estimates with ~0.35 confidence — ' +
          'usable to sort a keyword list, not to decide whether to target a single keyword. ' +
          'Set SERPER_API_KEY, SERPAPI_KEY or DataForSEO credentials for real SERP-derived difficulty.',
      );
    }

    const rows = results
      .filter((r): r is { ok: true; value: NonNullable<typeof r extends { ok: true; value: infer V } ? V : never> } => r.ok)
      .map((r) => {
        const v = r.value as { keyword: string; estimate: ReturnType<typeof difficultyFromLexical>; serp_top3: string[] };
        return {
          keyword: v.keyword,
          difficulty: v.estimate.difficulty,
          method: v.estimate.method,
          confidence: v.estimate.confidence,
          factors: v.estimate.factors,
          top_3: v.serp_top3,
          ...(args.your_domain ? personalizeDifficulty(v.estimate.difficulty, siteAuthority) : {}),
        };
      });

    const avg = rows.length > 0 ? round(rows.reduce((s, r) => s + r.difficulty, 0) / rows.length, 1) : 0;

    return {
      summary:
        `Difficulty for ${rows.length} keyword(s), average ${avg}/100, method "${rows[0]?.method ?? 'lexical'}"` +
        (args.your_domain && siteAuthority !== null ? ` (your domain authority: ${siteAuthority}).` : '.'),
      data: { keywords: rows, average_difficulty: avg, your_domain_authority: siteAuthority },
      warnings,
      meta: { source: hasSerp ? ctx.cfg.serp.provider : 'lexical', cost },
    };
  },
});

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    const k = key(i);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
