import { z } from 'zod';
import { defineTool, limitSchema, siteKey } from '../runtime.js';
import { describeCapabilities } from '../../config.js';
import { budgetStatus, usageSummary } from '../../core/budget.js';
import { upsertProject, getProject, listProjects, latestCrawlId, getCrawlPages } from '../../store/index.js';
import { runAudit, buildContext, issuesToActions } from '../../crawl/audit.js';
import { analyzeLinkGraph, findLinkOpportunities, linkGraphToActions } from '../../analysis/linkgraph.js';
import { gscQuery, createGscClient, daysAgo, GSC_LAG_DAYS } from '../../providers/gsc.js';
import {
  findStrikingDistance,
  findCtrOpportunities,
  findCannibalization,
  gscInsightsToActions,
} from '../../analysis/gsc-insights.js';
import { rankActions, spill } from '../../core/envelope.js';
import { getCrawlIssues } from '../../store/index.js';
import { cacheClear } from '../../core/cache.js';
import type { Action, Issue, CrawlSummary } from '../../core/types.js';
import type { CrawlResult } from '../../crawl/crawler.js';

/**
 * Meta tools: capability discovery, project config, spend, and the aggregator.
 */

export const capabilitiesTool = defineTool({
  name: 'seo_capabilities',
  title: 'What this server can currently do',
  description:
    'Report which capabilities are active, which provider backs each one, and exactly which environment variables ' +
    'would unlock the rest — plus what still works without them. ' +
    'Call this first in a new session, or whenever a tool returns PROVIDER_NOT_CONFIGURED, so you plan around what ' +
    'is actually available instead of guessing.',
  inputSchema: {},
  async handler(_args, ctx) {
    const capabilities = describeCapabilities(ctx.cfg);
    const available = capabilities.filter((c) => c.available);
    const missing = capabilities.filter((c) => !c.available);

    return {
      summary:
        `${available.length} of ${capabilities.length} capabilities active: ${available.map((c) => c.name).join(', ')}.` +
        (missing.length > 0 ? ` Unavailable: ${missing.map((c) => c.name).join(', ')} — see data.capabilities for what unlocks each.` : ''),
      data: {
        capabilities,
        providers: {
          serp: ctx.cfg.serp.provider,
          keyword_metrics: ctx.cfg.keywordData.provider,
          backlinks: ctx.cfg.backlinks.provider,
          search_console: ctx.cfg.gsc ? 'configured' : 'none',
          pagespeed: ctx.cfg.pagespeedKey ? 'configured' : 'none',
        },
        defaults: ctx.cfg.defaults,
        crawl_limits: ctx.cfg.crawl,
        budget: budgetStatus(),
        data_dir: ctx.cfg.dataDir,
        no_key_workflow: [
          'seo_crawl_site — full technical audit with a ranked fix list',
          'seo_keyword_ideas — hundreds of real keywords from autocomplete',
          'seo_cluster_keywords — group them into pages to build',
          'pseo_discover_patterns / pseo_build_plan / pseo_check_index_risk — programmatic SEO end to end',
          'seo_content_score — grade any draft or live page',
          'seo_internal_links / seo_link_opportunities — internal link equity and specific links to add',
          'seo_crawl_diff — what changed between two crawls',
        ],
      },
      meta: { source: 'config' },
    };
  },
});

export const projectSetTool = defineTool({
  name: 'seo_project_set',
  title: 'Save project configuration',
  description:
    'Store a named project (site, competitors, locale, location) so later calls can reference it by name instead of ' +
    'repeating the same arguments. Keywords and rank snapshots are filed under the project name.',
  inputSchema: {
    name: z.string().describe('Short project identifier, e.g. "acme".'),
    site: z.string().describe('The site URL or domain.'),
    competitors: z.array(z.string()).optional().default([]),
    locale: z.string().optional().default('en-US'),
    location: z.string().optional().default('United States'),
    description: z.string().optional().describe('What the business does — useful context for later calls.'),
  },
  readOnly: false,
  async handler(args) {
    upsertProject({
      name: args.name,
      site: args.site,
      competitors: args.competitors,
      locale: args.locale,
      location: args.location,
      description: args.description ?? null,
    });
    return {
      summary: `Project "${args.name}" saved for ${args.site}${args.competitors.length > 0 ? ` with ${args.competitors.length} competitor(s)` : ''}.`,
      data: getProject(args.name),
      meta: { source: 'store' },
    };
  },
});

export const projectListTool = defineTool({
  name: 'seo_project_list',
  title: 'List saved projects',
  description:
    'List every saved project with its site, competitors, locale and target location. '
    + 'Use this to recall which sites have been set up before, and to get the project name that '
    + 'keyword sets and rank snapshots are filed under.',
  inputSchema: {},
  async handler() {
    const projects = listProjects();
    return {
      summary: projects.length === 0 ? 'No projects saved yet.' : `${projects.length} project(s): ${projects.map((p) => p.name).join(', ')}.`,
      data: { projects },
      meta: { source: 'store' },
    };
  },
});

export const usageTool = defineTool({
  name: 'seo_usage',
  title: 'Provider spend this session',
  description:
    'Report provider units consumed, broken down by provider, plus the remaining budget. ' +
    'Set SEO_AGENT_BUDGET to cap spend — once hit, metered tools fail with a clear error rather than continuing to charge.',
  inputSchema: {
    since: z.string().optional().describe('ISO timestamp to report from. Defaults to 30 days ago.'),
  },
  async handler(args) {
    const usage = usageSummary(args.since);
    const budget = budgetStatus();
    return {
      summary:
        usage.length === 0
          ? 'No metered provider calls recorded.'
          : `${usage.reduce((s, u) => s + u.units, 0)} unit(s) across ${usage.length} provider(s)` +
            (budget.cap !== null ? `; ${budget.remaining} of ${budget.cap} remaining this session.` : '.'),
      data: { by_provider: usage, session_budget: budget },
      meta: { source: 'store' },
    };
  },
});

export const cacheClearTool = defineTool({
  name: 'seo_cache_clear',
  title: 'Clear cached provider responses',
  description:
    'Clear the local response cache. Use when you need genuinely fresh SERP or Search Console data before the TTL ' +
    'expires. Note that this means paying for those provider calls again.',
  inputSchema: {
    namespace: z.enum(['serp', 'kwmetrics', 'authority', 'gsc', 'suggest', 'robots', 'all']).optional().default('all'),
  },
  readOnly: false,
  async handler(args) {
    const cleared = cacheClear(args.namespace === 'all' ? undefined : args.namespace);
    return {
      summary: `Cleared ${cleared} cached entr${cleared === 1 ? 'y' : 'ies'}${args.namespace !== 'all' ? ` in "${args.namespace}"` : ''}.`,
      data: { cleared, namespace: args.namespace },
      meta: { source: 'store' },
    };
  },
});

export const nextActionsTool = defineTool({
  name: 'seo_next_actions',
  title: 'What should we work on next',
  description:
    'The aggregator. Pulls together everything known about a site — the latest crawl audit, internal link ' +
    'analysis, and Search Console opportunities when configured — deduplicates and re-ranks it all by ' +
    'impact-per-effort, and returns one prioritised backlog. ' +
    'Ask this when the request is broad: "how do we improve our SEO", "what should we do next", "where are the wins". ' +
    'Run seo_crawl_site first so there is a crawl to draw on.',
  inputSchema: {
    site: z.string().optional().describe('Site to analyse. Uses its most recent crawl.'),
    crawl_id: z.number().int().optional(),
    include_gsc: z.boolean().optional().default(true)
      .describe('Include Search Console opportunities when a credential is configured.'),
    gsc_site_url: z.string().optional().describe('Override the configured Search Console property.'),
    limit: limitSchema(100, 25),
  },
  async handler(args, ctx) {
    const actions: Action[] = [];
    const sources: string[] = [];
    const warnings: string[] = [];
    let auditSummary: Partial<CrawlSummary> | null = null;

    const crawlId = args.crawl_id ?? (args.site ? latestCrawlId(siteKey(args.site)) : null);

    if (crawlId !== null) {
      const pages = getCrawlPages(crawlId);
      if (pages.length > 0) {
        // Rebuild a minimal CrawlResult so the audit and link analysis can run
        // against stored pages without re-fetching the site.
        const stored: CrawlResult = {
          site: args.site ? siteKey(args.site) : '',
          origin: '',
          pages,
          queued_not_crawled: [],
          orphans: [],
          sitemap_urls: [],
          robots: { exists: true, blocked_count: 0, sitemaps: [], crawl_delay: null },
          started_at: '',
          finished_at: '',
          errors: [],
          stopped_reason: 'complete',
        };
        const report = runAudit(stored);
        // The stored issues include site-level findings the rebuilt crawl can't
        // reproduce (sitemap/robots state), so prefer them where available.
        const storedIssues: Issue[] = getCrawlIssues(crawlId);
        if (storedIssues.length > 0) {
          report.issues = storedIssues;
          const bySeverity = { error: 0, warning: 0, notice: 0 };
          for (const i of storedIssues) bySeverity[i.severity]++;
          report.by_severity = bySeverity;
        }
        actions.push(...issuesToActions(report, buildContext(stored)));

        const linkReport = analyzeLinkGraph(pages);
        const opportunities = findLinkOpportunities(pages, { limit: 30 });
        actions.push(...linkGraphToActions(linkReport, opportunities));

        auditSummary = {
          crawl_id: crawlId,
          pages_crawled: pages.length,
          health_score: report.health_score,
          issues_by_severity: report.by_severity,
        };
        sources.push('crawl-audit', 'internal-links');
      }
    } else {
      warnings.push(
        'No crawl found for this site, so technical and internal-link findings are missing. ' +
          'Run seo_crawl_site first for a complete backlog.',
      );
    }

    let gscSummary: Record<string, number> | null = null;
    if (args.include_gsc && createGscClient(ctx.cfg)) {
      try {
        const end = daysAgo(GSC_LAG_DAYS);
        const start = daysAgo(28 + GSC_LAG_DAYS);
        const site = args.gsc_site_url ? { siteUrl: args.gsc_site_url } : {};
        const { rows } = await gscQuery(
          ctx.cfg,
          { startDate: start, endDate: end, dimensions: ['query', 'page'], rowLimit: 5000 },
          site,
        );
        const insights = {
          striking_distance: findStrikingDistance(rows, { limit: 40 }),
          ctr_opportunities: findCtrOpportunities(rows, { limit: 20 }),
          cannibalization: findCannibalization(rows, { limit: 20 }),
          decay: [],
          rising: [],
        };
        actions.push(...gscInsightsToActions(insights));
        gscSummary = {
          striking_distance: insights.striking_distance.length,
          ctr_opportunities: insights.ctr_opportunities.length,
          cannibalization: insights.cannibalization.length,
        };
        sources.push('search-console');
      } catch (err) {
        warnings.push(`Search Console data unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (args.include_gsc) {
      warnings.push(
        'Search Console is not configured, so this backlog covers technical and structural findings only — ' +
          'it cannot see which keywords you nearly rank for, which is usually where the fastest wins are. ' +
          'Set GSC_SERVICE_ACCOUNT_JSON and GSC_SITE_URL to include them.',
      );
    }

    const ranked = rankActions(actions);
    const spilled = spill('seo_next_actions', ranked, args.limit);

    const byPriority = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const a of ranked) byPriority[a.priority]++;

    const quickWins = ranked.filter((a) => a.effort === 'trivial' || a.effort === 'small').slice(0, 5);

    return {
      summary:
        ranked.length === 0
          ? 'No actions found. Run seo_crawl_site first, and configure Search Console for ranking-based opportunities.'
          : `${ranked.length} prioritised action(s) from ${sources.join(', ')}. ` +
            `${byPriority.critical} critical, ${byPriority.high} high. ` +
            `Top: ${ranked[0]?.title}`,
      data: {
        audit: auditSummary,
        gsc: gscSummary,
        sources,
        by_priority: byPriority,
        quick_wins: quickWins.map((a) => ({ id: a.id, title: a.title, effort: a.effort, impact_score: a.impact_score })),
        actions: spilled.rows,
      },
      actions: ranked.slice(0, args.limit),
      warnings,
      meta: { source: sources.join('+') || 'none', ...spilled.meta },
    };
  },
});
