import { z } from 'zod';
import { defineTool, limitSchema, locationSchema, languageSchema, deviceSchema } from '../runtime.js';
import { getSerp, createSerpProvider } from '../../providers/serp.js';
import { getAuthority, getAuthorityScores, requireBacklinksProvider, createBacklinksProvider } from '../../providers/backlinks.js';
import { createKeywordMetricsProvider, requireKeywordMetricsProvider } from '../../providers/keyword-metrics.js';
import { saveRanks, getRankChanges, getRankHistory, rankDates } from '../../store/index.js';
import { diffRanks } from '../../store/diff.js';
import { spill, action } from '../../core/envelope.js';
import { mapLimit, partitionResults } from '../../core/http.js';
import { domainOf } from '../../core/url.js';
import { round, clamp } from '../../core/text.js';
import { classifyIntent } from '../../keywords/intent.js';
import { estimateClicks } from '../../keywords/score.js';
import { invalidInput } from '../../core/errors.js';
import type { Action } from '../../core/types.js';

/**
 * SERP, competitor and backlink tools.
 *
 * These all require a paid provider. Each one names the specific free
 * alternative in its error `remedy`, so an unconfigured agent is redirected
 * rather than blocked.
 */

export const serpTool = defineTool({
  name: 'seo_serp',
  title: 'Get live search results',
  description:
    'Fetch the live Google SERP for a keyword: organic results, SERP features (featured snippet, AI overview, ' +
    'local pack, ads), People Also Ask questions, and related searches. ' +
    'Requires a SERP provider. Results are cached for 6 hours to avoid burning credits on repeated calls.',
  inputSchema: {
    keyword: z.string().describe('The search query.'),
    location: locationSchema,
    language: languageSchema,
    device: deviceSchema,
    depth: z.number().int().min(10).max(100).optional().default(10).describe('Number of organic results to retrieve.'),
    with_authority: z.boolean().optional().default(false)
      .describe('Also fetch domain authority for each ranking domain. Costs backlink-provider credits.'),
  },
  async handler(args, ctx) {
    const { data, cached, provider, cost } = await getSerp(ctx.cfg, {
      keyword: args.keyword,
      ...(args.location ? { location: args.location } : {}),
      ...(args.language ? { language: args.language } : {}),
      ...(args.device ? { device: args.device } : {}),
      depth: args.depth,
    });

    let authority: Map<string, number> = new Map();
    if (args.with_authority) {
      authority = await getAuthorityScores(ctx.cfg, data.results.map((r) => r.domain));
    }

    return {
      summary:
        `${data.results.length} organic results for "${args.keyword}" in ${data.location}. ` +
        `SERP features: ${data.features.length > 0 ? data.features.join(', ') : 'none'}. ` +
        `${data.people_also_ask.length} People Also Ask question(s).`,
      data: {
        keyword: data.keyword,
        location: data.location,
        device: data.device,
        features: data.features,
        results: data.results.map((r) => ({
          ...r,
          ...(authority.has(r.domain) ? { domain_authority: authority.get(r.domain) } : {}),
        })),
        people_also_ask: data.people_also_ask,
        related_searches: data.related_searches,
        fetched_at: data.fetched_at,
      },
      meta: {
        source: provider,
        cached,
        cost,
        next: ['seo_content_brief to turn this SERP into a writing brief'],
      },
    };
  },
});

export const rankCheckTool = defineTool({
  name: 'seo_rank_check',
  title: 'Check where a domain ranks',
  description:
    'Check the current position of a domain for specific keywords via live SERP lookups, and store the result ' +
    'as a tracking snapshot so seo_rank_changes can show movement over time. ' +
    'For your own site, prefer seo_gsc_performance — it is free, covers every keyword you rank for rather than ' +
    'just the ones you thought to check, and reports real impressions and clicks. Use this for competitors, ' +
    'or when you need a position for a specific keyword right now.',
  inputSchema: {
    domain: z.string().describe('Domain to look for in the results, e.g. "example.com".'),
    keywords: z.array(z.string()).min(1).max(100),
    location: locationSchema,
    device: deviceSchema,
    project: z.string().optional().describe('Store snapshots under this project for trend tracking.'),
  },
  async handler(args, ctx) {
    const target = domainOf(args.domain) || args.domain.toLowerCase();
    let cost = 0;

    const results = await mapLimit(args.keywords, 3, async (kw) => {
      const { data, cost: c } = await getSerp(ctx.cfg, {
        keyword: kw,
        ...(args.location ? { location: args.location } : {}),
        ...(args.device ? { device: args.device } : {}),
        depth: 100,
      });
      cost += c;
      const hit = data.results.find((r) => r.domain === target);
      return {
        keyword: kw,
        position: hit?.position ?? null,
        url: hit?.url ?? null,
        // Knowing who beats you is half the value of a rank check.
        outranked_by: hit
          ? data.results.filter((r) => r.position < hit.position).slice(0, 3).map((r) => r.domain)
          : data.results.slice(0, 3).map((r) => r.domain),
        serp_features: data.features,
      };
    });

    // If every lookup failed, this must not report "ranks for 0 of 0 keywords"
    // as a success — that reads as "you rank for nothing".
    const { values: rows, warning: lookupWarning } = partitionResults(results, 'SERP lookup');

    if (args.project) {
      saveRanks(
        rows.map((r) => ({
          project: args.project as string,
          keyword: r.keyword,
          position: r.position,
          url: r.url,
          source: ctx.cfg.serp.provider,
          location: args.location ?? ctx.cfg.defaults.location,
          device: args.device ?? ctx.cfg.defaults.device,
        })),
      );
    }

    const ranking = rows.filter((r) => r.position !== null);
    const avg = ranking.length > 0 ? round(ranking.reduce((s, r) => s + (r.position as number), 0) / ranking.length, 1) : null;

    return {
      summary:
        `${target} ranks for ${ranking.length} of ${rows.length} keyword(s) checked` +
        (avg !== null ? `, average position ${avg}.` : '.') +
        (args.project ? ' Snapshots stored for trend tracking.' : ''),
      data: {
        domain: target,
        checked: rows.length,
        ranking_count: ranking.length,
        average_position: avg,
        top_10_count: ranking.filter((r) => (r.position as number) <= 10).length,
        results: rows,
      },
      ...(lookupWarning ? { warnings: [lookupWarning] } : {}),
      meta: {
        source: ctx.cfg.serp.provider,
        cost,
        next: args.project ? ['seo_rank_changes to see movement once you have two snapshots'] : [],
      },
    };
  },
});

export const competitorsTool = defineTool({
  name: 'seo_competitors_discover',
  title: 'Find your real search competitors',
  description:
    'Discover which domains actually compete with you in search by sampling the SERPs for a set of keywords and ' +
    'counting who appears most often. These are frequently not the competitors a business names itself — ' +
    'search competitors are whoever occupies the results, which often means publishers and aggregators.',
  inputSchema: {
    keywords: z.array(z.string()).min(1).max(50).describe('Representative keywords for your topic.'),
    your_domain: z.string().optional().describe('Exclude this domain and report your own visibility separately.'),
    location: locationSchema,
    limit: limitSchema(100, 20),
  },
  async handler(args, ctx) {
    const own = args.your_domain ? domainOf(args.your_domain) : null;
    let cost = 0;

    const serps = await mapLimit(args.keywords, 3, async (kw) => {
      const { data, cost: c } = await getSerp(ctx.cfg, {
        keyword: kw,
        ...(args.location ? { location: args.location } : {}),
        depth: 20,
      });
      cost += c;
      return data;
    });

    interface Stat {
      domain: string;
      appearances: number;
      positions: number[];
      top10: number;
      keywords: string[];
      urls: Set<string>;
    }
    // Same trap as seo_rank_check: skipping failures and reporting on the
    // remainder turned "no SERP provider" into "you have no competitors".
    const { values: serpData, warning: serpWarning } = partitionResults(serps, 'SERP sample');

    const stats = new Map<string, Stat>();
    let ownStat: Stat | null = null;

    for (const data of serpData) {
      const seen = new Set<string>();
      for (const r of data.results) {
        if (seen.has(r.domain)) continue;
        seen.add(r.domain);
        const isOwn = own !== null && r.domain === own;
        const bucket = isOwn
          ? (ownStat ??= { domain: r.domain, appearances: 0, positions: [], top10: 0, keywords: [], urls: new Set() })
          : (stats.get(r.domain) ?? { domain: r.domain, appearances: 0, positions: [], top10: 0, keywords: [], urls: new Set() });
        bucket.appearances++;
        bucket.positions.push(r.position);
        if (r.position <= 10) bucket.top10++;
        bucket.keywords.push(data.keyword);
        bucket.urls.add(r.url);
        if (!isOwn) stats.set(r.domain, bucket);
      }
    }

    const analysed = serpData.length;
    const toRow = (s: Stat) => ({
      domain: s.domain,
      appearances: s.appearances,
      // Visibility weights presence by position, so ranking #1 for three
      // keywords beats ranking #18 for ten.
      visibility: round(
        (s.positions.reduce((sum, p) => sum + 1 / Math.sqrt(p), 0) / Math.max(1, analysed)) * 100,
        1,
      ),
      coverage_pct: round((s.appearances / Math.max(1, analysed)) * 100, 1),
      avg_position: round(s.positions.reduce((a, b) => a + b, 0) / s.positions.length, 1),
      top_10_count: s.top10,
      example_keywords: s.keywords.slice(0, 5),
      example_urls: [...s.urls].slice(0, 3),
    });

    const rows = [...stats.values()].map(toRow).sort((a, b) => b.visibility - a.visibility);
    const spilled = spill('seo_competitors_discover', rows, args.limit);
    const yours = ownStat ? toRow(ownStat) : null;

    const actions: Action[] = [];
    if (yours && rows.length > 0) {
      const ahead = rows.filter((r) => r.visibility > yours.visibility);
      if (ahead.length > 0) {
        actions.push(
          action({
            id: 'serp.competitor_gap',
            priority: 'medium',
            effort: 'medium',
            category: 'competitive',
            title: `${ahead.length} domain(s) outrank you across this keyword set`,
            detail:
              `Your visibility is ${yours.visibility} vs ${ahead[0]?.visibility} for ${ahead[0]?.domain}. ` +
              'Run seo_content_gap against the top two or three to find the specific keywords they own that you do not.',
            impact_score: round(clamp(40 + ahead.length * 3, 0, 85), 1),
            evidence: { ahead_of_you: ahead.slice(0, 5), your_visibility: yours.visibility },
            fix: { type: 'analyze_content_gap', competitors: ahead.slice(0, 3).map((a) => a.domain) },
          }),
        );
      }
    }

    return {
      summary:
        `Sampled ${analysed} SERPs and found ${rows.length} competing domains. ` +
        `Top: ${rows.slice(0, 3).map((r) => r.domain).join(', ') || 'none'}.` +
        (yours ? ` Your visibility: ${yours.visibility} (appears in ${yours.coverage_pct}% of SERPs).` : ''),
      data: { keywords_analysed: analysed, your_visibility: yours, competitors: spilled.rows },
      actions,
      ...(serpWarning ? { warnings: [serpWarning] } : {}),
      meta: { source: ctx.cfg.serp.provider, cost, ...spilled.meta },
    };
  },
});

export const contentGapTool = defineTool({
  name: 'seo_content_gap',
  title: 'Find keywords competitors rank for and you do not',
  description:
    'Compare the keyword footprint of your domain against competitors and return the keywords they rank for ' +
    'that you do not, sorted by opportunity. This is the classic Content Gap report and the most direct route ' +
    'from "we should do SEO" to "here are 40 pages to write". Requires DataForSEO for ranked-keyword data.',
  inputSchema: {
    your_domain: z.string().describe('Your domain.'),
    competitors: z.array(z.string()).min(1).max(5).describe('Competitor domains to compare against.'),
    location: locationSchema,
    language: languageSchema,
    min_volume: z.number().int().min(0).optional().default(50).describe('Ignore keywords below this monthly volume.'),
    max_position: z.number().int().min(1).max(100).optional().default(20)
      .describe('Only count a competitor as ranking if they are within this position.'),
    limit: limitSchema(500, 60),
  },
  async handler(args, ctx) {
    const provider = requireKeywordMetricsProvider(ctx.cfg);
    if (!provider.fetchRankedKeywords) {
      throw invalidInput(
        `The configured keyword provider (${provider.name}) cannot list ranked keywords.`,
        'Configure DataForSEO credentials, which support the ranked-keywords endpoint this needs.',
      );
    }
    const location = args.location ?? ctx.cfg.defaults.location;
    const language = args.language ?? ctx.cfg.defaults.language;

    const ours = await provider.fetchRankedKeywords(domainOf(args.your_domain), location, language, 1000);
    const ourKeywords = new Map(ours.map((k) => [k.keyword.toLowerCase(), k]));

    interface GapRow {
      keyword: string;
      volume: number | null;
      difficulty: number | null;
      cpc: number | null;
      intent: string;
      your_position: number | null;
      competitors: Array<{ domain: string; position: number; url: string }>;
      opportunity: number;
      estimated_clicks: number | null;
    }
    const gaps = new Map<string, GapRow>();

    for (const competitor of args.competitors) {
      const theirs = await provider.fetchRankedKeywords(domainOf(competitor), location, language, 1000);
      for (const k of theirs) {
        if (k.position > args.max_position) continue;
        if ((k.volume ?? 0) < args.min_volume) continue;
        const key = k.keyword.toLowerCase();
        const mine = ourKeywords.get(key);
        // A keyword we already rank well for is not a gap.
        if (mine && mine.position <= args.max_position) continue;

        const existing = gaps.get(key);
        if (existing) {
          existing.competitors.push({ domain: domainOf(competitor), position: k.position, url: k.url });
          continue;
        }
        const intent = classifyIntent(k.keyword).intent;
        gaps.set(key, {
          keyword: k.keyword,
          volume: k.volume,
          difficulty: k.difficulty,
          cpc: k.cpc,
          intent,
          your_position: mine?.position ?? null,
          competitors: [{ domain: domainOf(competitor), position: k.position, url: k.url }],
          opportunity: 0,
          estimated_clicks: k.volume !== null ? estimateClicks(k.volume, 5) : null,
        });
      }
    }

    const { scoreOpportunity } = await import('../../keywords/score.js');
    const rows = [...gaps.values()].map((g) => ({
      ...g,
      // Keywords several competitors rank for are validated opportunities, not
      // one-off flukes, so weight them up.
      opportunity: round(
        scoreOpportunity({
          keyword: g.keyword,
          volume: g.volume,
          difficulty: g.difficulty,
          cpc: g.cpc,
          intent: g.intent as ReturnType<typeof classifyIntent>['intent'],
          position: g.your_position,
        }).opportunity *
          (1 + Math.min(g.competitors.length - 1, 3) * 0.08),
        1,
      ),
    }));
    rows.sort((a, b) => b.opportunity - a.opportunity);

    const spilled = spill('seo_content_gap', rows, args.limit);
    const totalVolume = rows.reduce((s, r) => s + (r.volume ?? 0), 0);
    const allCompeteFor = rows.filter((r) => r.competitors.length === args.competitors.length);

    return {
      summary:
        `${rows.length} keyword gap(s) worth ${totalVolume} searches/mo that ${args.competitors.length} competitor(s) ` +
        `rank for and ${args.your_domain} does not. ${allCompeteFor.length} are covered by every competitor — ` +
        'those are table stakes for the category.',
      data: {
        your_domain: args.your_domain,
        your_ranked_keywords: ours.length,
        competitors: args.competitors,
        gap_count: rows.length,
        total_gap_volume: totalVolume,
        covered_by_all_competitors: allCompeteFor.slice(0, 25).map((r) => r.keyword),
        gaps: spilled.rows,
      },
      meta: {
        source: provider.name,
        cost: (args.competitors.length + 1) * 2,
        ...spilled.meta,
        next: ['seo_cluster_keywords on these gaps to turn them into a page plan'],
      },
    };
  },
});

export const domainAuthorityTool = defineTool({
  name: 'seo_domain_authority',
  title: 'Get domain authority and backlink counts',
  description:
    'Fetch authority score (0-100), backlink count and referring domains for one or more domains. ' +
    'Use it to calibrate whether a keyword is realistically winnable for your site. ' +
    'Works with DataForSEO (full data) or Open PageRank (free tier, authority only).',
  inputSchema: {
    domains: z.array(z.string()).min(1).max(100),
  },
  async handler(args, ctx) {
    const { authority, cost, provider } = await getAuthority(ctx.cfg, args.domains);
    const rows = args.domains.map((d) => {
      const key = domainOf(d) || d.toLowerCase();
      const a = authority.get(key);
      return {
        domain: key,
        authority: a?.authority ?? null,
        backlinks: a?.backlinks ?? null,
        referring_domains: a?.referring_domains ?? null,
      };
    });
    const scored = rows.filter((r) => r.authority !== null);
    return {
      summary:
        `Authority for ${rows.length} domain(s) via ${provider}` +
        (scored.length > 0
          ? `. Strongest: ${scored.slice().sort((a, b) => (b.authority ?? 0) - (a.authority ?? 0))[0]?.domain} (${scored.slice().sort((a, b) => (b.authority ?? 0) - (a.authority ?? 0))[0]?.authority}).`
          : '.'),
      data: { domains: rows },
      meta: { source: provider, cost },
    };
  },
});

export const backlinksTool = defineTool({
  name: 'seo_backlinks',
  title: 'List backlinks to a domain or URL',
  description:
    'List the backlinks pointing at a domain or page, with the linking page, anchor text, authority and ' +
    'follow status. Use it to audit your own profile or to reverse-engineer why a competitor page ranks. ' +
    'Requires DataForSEO.',
  inputSchema: {
    target: z.string().describe('Domain or URL to fetch backlinks for.'),
    limit: limitSchema(1000, 50),
  },
  async handler(args, ctx) {
    const provider = requireBacklinksProvider(ctx.cfg);
    if (!provider.backlinks) {
      throw invalidInput(
        `The configured backlinks provider (${provider.name}) only exposes authority scores, not individual backlinks.`,
        'Configure DataForSEO credentials for full backlink data.',
      );
    }
    const links = await provider.backlinks(args.target, args.limit);
    const spilled = spill('seo_backlinks', links, args.limit);
    const domains = new Set(links.map((l) => l.domain_from));

    const anchors = new Map<string, number>();
    for (const l of links) {
      const a = l.anchor.trim().toLowerCase();
      if (a) anchors.set(a, (anchors.get(a) ?? 0) + 1);
    }

    return {
      summary:
        `${links.length} backlink(s) from ${domains.size} referring domain(s) to ${args.target}. ` +
        `${links.filter((l) => l.nofollow).length} are nofollow.`,
      data: {
        target: args.target,
        total_returned: links.length,
        referring_domains: domains.size,
        nofollow_count: links.filter((l) => l.nofollow).length,
        top_anchors: [...anchors].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([anchor, count]) => ({ anchor, count })),
        backlinks: spilled.rows,
      },
      meta: { source: provider.name, cost: provider.costPerCall, ...spilled.meta },
    };
  },
});

export const linkGapTool = defineTool({
  name: 'seo_link_gap',
  title: 'Find sites linking to competitors but not you',
  description:
    'Find domains that link to your competitors but not to you — the classic Link Intersect report and the ' +
    'highest-conversion link-building prospect list, since these sites already link to sites like yours. ' +
    'Requires DataForSEO.',
  inputSchema: {
    your_domain: z.string(),
    competitors: z.array(z.string()).min(1).max(10),
    limit: limitSchema(500, 50),
  },
  async handler(args, ctx) {
    const provider = requireBacklinksProvider(ctx.cfg);
    if (!provider.linkGap) {
      throw invalidInput(
        `The configured backlinks provider (${provider.name}) does not support link intersection.`,
        'Configure DataForSEO credentials for link gap analysis.',
      );
    }
    const prospects = await provider.linkGap(domainOf(args.your_domain), args.competitors.map(domainOf), args.limit);
    const spilled = spill('seo_link_gap', prospects, args.limit);
    // Sites linking to several competitors are the warmest prospects.
    const multi = prospects.filter((p) => p.links_to.length > 1);

    return {
      summary:
        `${prospects.length} domain(s) link to your competitors but not to ${args.your_domain}. ` +
        `${multi.length} link to more than one competitor — start there.`,
      data: {
        your_domain: args.your_domain,
        competitors: args.competitors,
        prospect_count: prospects.length,
        multi_competitor_prospects: multi.slice(0, 25),
        prospects: spilled.rows,
      },
      meta: { source: provider.name, cost: provider.costPerCall, ...spilled.meta },
    };
  },
});

export const rankChangesTool = defineTool({
  name: 'seo_rank_changes',
  title: 'See ranking movement over time',
  description:
    'Show the latest stored position for every tracked keyword plus the change since the previous snapshot. ' +
    'Populate it with seo_rank_check (SERP-based) or seo_gsc_performance with save_snapshot (free, and covers ' +
    'every keyword you actually rank for). Pass two dates to compare specific days.',
  inputSchema: {
    project: z.string().describe('Project the snapshots were stored under.'),
    from_date: z.string().optional().describe('Baseline date, YYYY-MM-DD. Omit to compare against the previous snapshot.'),
    to_date: z.string().optional().describe('Comparison date, YYYY-MM-DD.'),
    keyword: z.string().optional().describe('Return the full history for a single keyword instead of the summary.'),
    limit: limitSchema(1000, 80),
  },
  async handler(args) {
    if (args.keyword) {
      const history = getRankHistory(args.project, args.keyword, 100);
      return {
        summary: `${history.length} snapshot(s) for "${args.keyword}" in project "${args.project}".`,
        data: { keyword: args.keyword, history },
        meta: { source: 'store' },
      };
    }

    const dates = rankDates(args.project, 60);
    if (dates.length === 0) {
      throw invalidInput(
        `No ranking snapshots stored for project "${args.project}".`,
        'Run seo_rank_check or seo_gsc_performance with save_snapshot=true and project set, then call this again.',
      );
    }

    if (args.from_date && args.to_date) {
      const rows = diffRanks(args.project, args.from_date, args.to_date, args.limit);
      const improved = rows.filter((r) => (r.change ?? 0) > 0);
      const declined = rows.filter((r) => (r.change ?? 0) < 0);
      const spilled = spill('seo_rank_changes', rows, args.limit);
      return {
        summary:
          `${args.from_date} → ${args.to_date}: ${improved.length} keyword(s) improved, ${declined.length} declined, ` +
          `${rows.length - improved.length - declined.length} unchanged or incomparable.`,
        data: {
          from_date: args.from_date,
          to_date: args.to_date,
          improved: improved.length,
          declined: declined.length,
          biggest_gains: improved.slice().sort((a, b) => (b.change ?? 0) - (a.change ?? 0)).slice(0, 10),
          biggest_losses: declined.slice().sort((a, b) => (a.change ?? 0) - (b.change ?? 0)).slice(0, 10),
          rows: spilled.rows,
        },
        meta: { source: 'store', ...spilled.meta },
      };
    }

    const changes = getRankChanges(args.project, { limit: args.limit });
    const improved = changes.filter((c) => (c.change ?? 0) > 0);
    const declined = changes.filter((c) => (c.change ?? 0) < 0);
    const spilled = spill('seo_rank_changes', changes, args.limit);

    return {
      summary:
        `${changes.length} tracked keyword(s) in "${args.project}". ` +
        `${improved.length} improved, ${declined.length} declined since the previous snapshot. ` +
        `Snapshot dates available: ${dates.slice(0, 5).join(', ')}${dates.length > 5 ? '…' : ''}.`,
      data: {
        available_dates: dates,
        improved: improved.length,
        declined: declined.length,
        biggest_gains: improved.slice().sort((a, b) => (b.change ?? 0) - (a.change ?? 0)).slice(0, 10),
        biggest_losses: declined.slice().sort((a, b) => (a.change ?? 0) - (b.change ?? 0)).slice(0, 10),
        rows: spilled.rows,
      },
      meta: { source: 'store', ...spilled.meta },
    };
  },
});

export { createSerpProvider, createBacklinksProvider, createKeywordMetricsProvider };
