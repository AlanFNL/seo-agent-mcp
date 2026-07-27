import { z } from 'zod';
import { defineTool, limitSchema } from '../runtime.js';
import { gscQuery, requireGscClient, daysAgo, GSC_LAG_DAYS, type GscRow } from '../../providers/gsc.js';
import {
  findStrikingDistance,
  findCtrOpportunities,
  findCannibalization,
  findDecay,
  findRisingQueries,
  gscInsightsToActions,
} from '../../analysis/gsc-insights.js';
import { saveRanks } from '../../store/index.js';
import { spill } from '../../core/envelope.js';
import { round } from '../../core/text.js';

/**
 * Google Search Console tools.
 *
 * This is the answer to "how do we actually rank" — real impressions, clicks,
 * CTR and average position straight from Google, for free, covering every query
 * the site surfaces for rather than a sampled keyword universe.
 */

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .optional();

export const gscSitesTool = defineTool({
  name: 'seo_gsc_sites',
  title: 'List accessible Search Console properties',
  description:
    'List the Search Console properties the configured credential can read, with permission levels. ' +
    'Call this first when Search Console tools return a permission error — the property string must match exactly ' +
    '(note the difference between "https://example.com/" and "sc-domain:example.com").',
  inputSchema: {},
  async handler(_args, ctx) {
    const client = requireGscClient(ctx.cfg);
    const sites = await client.listSites();
    return {
      summary:
        sites.length === 0
          ? 'The credential is valid but has access to no properties. Add it as a user in Search Console.'
          : `${sites.length} accessible propert${sites.length === 1 ? 'y' : 'ies'}: ${sites.map((s) => s.siteUrl).join(', ')}.`,
      data: { sites, configured_site: ctx.cfg.gsc?.siteUrl ?? null },
      meta: { source: 'gsc' },
    };
  },
});

export const gscPerformanceTool = defineTool({
  name: 'seo_gsc_performance',
  title: 'Get real ranking and traffic data',
  description:
    'Query Google Search Console for actual impressions, clicks, CTR and average position — your real ranking ' +
    'data, not an estimate. Group by query, page, country, device or date. ' +
    'This is the most accurate answer to "how are we ranking" and it costs nothing. ' +
    'Set save_snapshot to store the results for trend tracking with seo_rank_changes.',
  inputSchema: {
    dimensions: z.array(z.enum(['query', 'page', 'country', 'device', 'date', 'searchAppearance']))
      .optional().default(['query'])
      .describe('Group by these. Use ["query","page"] to see which page ranks for which query.'),
    start_date: dateSchema.describe('YYYY-MM-DD. Defaults to 28 days before the end date.'),
    end_date: dateSchema.describe('YYYY-MM-DD. Defaults to 3 days ago, since Search Console data lags.'),
    days: z.number().int().min(1).max(480).optional()
      .describe('Convenience alternative to start_date: look back this many days.'),
    site_url: z.string().optional().describe('Override the configured property.'),
    filter_query_contains: z.string().optional(),
    filter_page_contains: z.string().optional(),
    min_impressions: z.number().int().min(0).optional().default(0),
    save_snapshot: z.boolean().optional().default(false)
      .describe('Store positions for trend tracking. Requires `project`.'),
    project: z.string().optional(),
    limit: limitSchema(5000, 100),
  },
  async handler(args, ctx) {
    const endDate = args.end_date ?? daysAgo(GSC_LAG_DAYS);
    const startDate = args.start_date ?? daysAgo((args.days ?? 28) + GSC_LAG_DAYS);

    const filters: NonNullable<Parameters<typeof gscQuery>[1]['filters']> = [];
    if (args.filter_query_contains) {
      filters.push({ dimension: 'query', operator: 'contains', expression: args.filter_query_contains });
    }
    if (args.filter_page_contains) {
      filters.push({ dimension: 'page', operator: 'contains', expression: args.filter_page_contains });
    }

    const { rows, cached, site } = await gscQuery(
      ctx.cfg,
      {
        startDate,
        endDate,
        dimensions: args.dimensions,
        rowLimit: Math.max(args.limit, 1000),
        ...(filters.length > 0 ? { filters } : {}),
      },
      args.site_url ? { siteUrl: args.site_url } : {},
    );

    const filtered = rows.filter((r) => r.impressions >= args.min_impressions);

    const warnings: string[] = [];
    if (args.save_snapshot) {
      if (!args.project) {
        warnings.push('save_snapshot was requested but no `project` was given, so nothing was stored.');
      } else if (!args.dimensions.includes('query')) {
        warnings.push('save_snapshot needs "query" in dimensions to key the snapshots. Nothing was stored.');
      } else {
        const queryIndex = args.dimensions.indexOf('query');
        const pageIndex = args.dimensions.indexOf('page');
        saveRanks(
          filtered.map((r) => ({
            project: args.project as string,
            keyword: r.keys[queryIndex] ?? '',
            position: round(r.position, 1),
            url: pageIndex >= 0 ? (r.keys[pageIndex] ?? null) : null,
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: round(r.ctr, 4),
            source: 'gsc',
          })),
        );
      }
    }

    const totals = filtered.reduce(
      (acc, r) => ({
        clicks: acc.clicks + r.clicks,
        impressions: acc.impressions + r.impressions,
        positionWeighted: acc.positionWeighted + r.position * r.impressions,
      }),
      { clicks: 0, impressions: 0, positionWeighted: 0 },
    );

    const shaped = filtered.map((r) => {
      const out: Record<string, unknown> = {};
      args.dimensions.forEach((d, i) => {
        out[d] = r.keys[i] ?? null;
      });
      out['clicks'] = r.clicks;
      out['impressions'] = r.impressions;
      out['ctr'] = round(r.ctr * 100, 2);
      out['position'] = round(r.position, 1);
      return out;
    });
    const spilled = spill('seo_gsc_performance', shaped, args.limit);

    return {
      summary:
        `${site} from ${startDate} to ${endDate}: ${totals.clicks} clicks, ${totals.impressions} impressions, ` +
        `average position ${totals.impressions > 0 ? round(totals.positionWeighted / totals.impressions, 1) : 'n/a'} ` +
        `across ${filtered.length} ${args.dimensions.join('+')} row(s).`,
      data: {
        site,
        start_date: startDate,
        end_date: endDate,
        dimensions: args.dimensions,
        totals: {
          clicks: totals.clicks,
          impressions: totals.impressions,
          ctr: totals.impressions > 0 ? round((totals.clicks / totals.impressions) * 100, 2) : 0,
          avg_position: totals.impressions > 0 ? round(totals.positionWeighted / totals.impressions, 1) : null,
        },
        rows: spilled.rows,
      },
      warnings,
      meta: {
        source: 'gsc',
        cached,
        ...spilled.meta,
        next: ['seo_gsc_opportunities to turn this into a ranked list of specific fixes'],
      },
    };
  },
});

export const gscOpportunitiesTool = defineTool({
  name: 'seo_gsc_opportunities',
  title: 'Find ranking opportunities in your own data',
  description:
    'The highest-value tool here. Runs five analyses over Search Console data and returns a ranked, actionable ' +
    'backlog: (1) striking-distance queries ranked 8-25 that one push would move onto page one, ' +
    '(2) pages whose CTR is far below normal for their position — a title/meta problem, ' +
    '(3) keyword cannibalisation where several of your pages compete for one query, ' +
    '(4) content decay where pages lost clicks versus an earlier period, and (5) rising queries you rank poorly for. ' +
    'Ask this when someone says "how can we improve our rankings".',
  inputSchema: {
    days: z.number().int().min(7).max(180).optional().default(28)
      .describe('Recent window to analyse.'),
    compare_days: z.number().int().min(7).max(180).optional().default(28)
      .describe('Length of the earlier window used for decay and trend comparison.'),
    site_url: z.string().optional(),
    min_impressions: z.number().int().min(1).optional().default(30),
    include: z.array(z.enum(['striking_distance', 'ctr', 'cannibalization', 'decay', 'rising'])).optional()
      .describe('Limit which analyses run. Defaults to all five.'),
    limit: limitSchema(200, 30),
  },
  async handler(args, ctx) {
    const include = new Set(args.include ?? ['striking_distance', 'ctr', 'cannibalization', 'decay', 'rising']);
    const site = args.site_url ? { siteUrl: args.site_url } : {};

    const recentEnd = daysAgo(GSC_LAG_DAYS);
    const recentStart = daysAgo(args.days + GSC_LAG_DAYS);
    const priorEnd = daysAgo(args.days + GSC_LAG_DAYS + 1);
    const priorStart = daysAgo(args.days + args.compare_days + GSC_LAG_DAYS + 1);

    // query+page in one request: striking distance and cannibalisation both need
    // the pairing, and a second call would double the latency for no benefit.
    const { rows: recentQueryPage } = await gscQuery(
      ctx.cfg,
      { startDate: recentStart, endDate: recentEnd, dimensions: ['query', 'page'], rowLimit: 5000 },
      site,
    );

    let recentPages: GscRow[] = [];
    let priorPages: GscRow[] = [];
    let priorQueries: GscRow[] = [];
    const needsComparison = include.has('decay') || include.has('rising');
    if (needsComparison) {
      [recentPages, priorPages, priorQueries] = await Promise.all([
        gscQuery(ctx.cfg, { startDate: recentStart, endDate: recentEnd, dimensions: ['page'], rowLimit: 3000 }, site).then((r) => r.rows),
        gscQuery(ctx.cfg, { startDate: priorStart, endDate: priorEnd, dimensions: ['page'], rowLimit: 3000 }, site).then((r) => r.rows),
        gscQuery(ctx.cfg, { startDate: priorStart, endDate: priorEnd, dimensions: ['query'], rowLimit: 5000 }, site).then((r) => r.rows),
      ]);
    }

    // findRisingQueries compares single-dimension query rows.
    const recentQueries = include.has('rising')
      ? (await gscQuery(ctx.cfg, { startDate: recentStart, endDate: recentEnd, dimensions: ['query'], rowLimit: 5000 }, site)).rows
      : [];

    const insights = {
      striking_distance: include.has('striking_distance')
        ? findStrikingDistance(recentQueryPage, { minImpressions: args.min_impressions, limit: args.limit })
        : [],
      ctr_opportunities: include.has('ctr')
        ? findCtrOpportunities(recentQueryPage, { minImpressions: Math.max(args.min_impressions, 100), limit: args.limit })
        : [],
      cannibalization: include.has('cannibalization')
        ? findCannibalization(recentQueryPage, { minImpressions: args.min_impressions, limit: args.limit })
        : [],
      decay: include.has('decay')
        ? findDecay(priorPages, recentPages, { limit: args.limit })
        : [],
      rising: include.has('rising')
        ? findRisingQueries(priorQueries, recentQueries, { minImpressionsAfter: args.min_impressions, limit: args.limit })
        : [],
    };

    const actions = gscInsightsToActions(insights);
    const totalUpside =
      insights.striking_distance.reduce((s, r) => s + r.potential_gain, 0) +
      insights.ctr_opportunities.reduce((s, r) => s + r.potential_gain, 0);

    return {
      summary:
        `Found ${insights.striking_distance.length} striking-distance queries, ${insights.ctr_opportunities.length} CTR ` +
        `problems, ${insights.cannibalization.length} cannibalisation conflicts, ${insights.decay.length} decaying pages ` +
        `and ${insights.rising.length} rising queries. Roughly +${totalUpside} clicks/month is available from the ` +
        'striking-distance and CTR fixes alone.',
      data: {
        window: { recent: [recentStart, recentEnd], prior: [priorStart, priorEnd] },
        estimated_monthly_click_upside: totalUpside,
        ...insights,
      },
      actions,
      meta: {
        source: 'gsc',
        next: [
          'seo_content_brief on the top striking-distance query to see what the winners cover',
          'seo_link_opportunities to add internal links to the pages that need a push',
        ],
      },
    };
  },
});
