import { z } from 'zod';
import { defineTool, limitSchema, siteKey } from '../runtime.js';
import { crawlSite, fetchPage } from '../../crawl/crawler.js';
import { runAudit, buildContext, issuesToActions, ALL_RULES } from '../../crawl/audit.js';
import { extractPerfSignals } from '../../crawl/extract.js';
import { analyzeLinkGraph, findLinkOpportunities, linkGraphToActions } from '../../analysis/linkgraph.js';
import { saveCrawl, listCrawls, latestCrawlId, getCrawlIssues, getCrawlPages } from '../../store/index.js';
import { diffCrawls, diffToActions } from '../../store/diff.js';
import { spill } from '../../core/envelope.js';
import { readability, truncate, round } from '../../core/text.js';
import { invalidInput, SeoAgentError, type ErrorCode } from '../../core/errors.js';

/**
 * Site crawling, auditing and structural analysis.
 *
 * Everything in this file works with zero configuration — no API keys, no
 * accounts. That's deliberate: it's the floor of what the tool can always do.
 */

export const crawlSiteTool = defineTool({
  name: 'seo_crawl_site',
  title: 'Crawl and audit a website',
  description:
    'Crawl a site and run a full technical SEO audit (40+ rule families covering indexability, canonicals, ' +
    'titles/meta, duplicate content, internal links, images, structured data, hreflang and performance). ' +
    'Returns a health score, issue counts by rule, and a ranked list of concrete fixes. ' +
    'Results are stored so seo_crawl_diff can later show what changed. ' +
    'Needs no API keys. Start here when asked to improve a site.',
  inputSchema: {
    url: z.string().describe('Site or page URL to start crawling from, e.g. "https://example.com".'),
    max_pages: z.number().int().min(1).max(20_000).optional().default(200)
      .describe('Page budget. Crawling is breadth-first, so the shallowest (most important) pages are covered first.'),
    max_depth: z.number().int().min(0).max(20).optional()
      .describe('Maximum click depth from the start URL.'),
    include_subdomains: z.boolean().optional().default(false)
      .describe('Follow links into other subdomains of the same registrable domain.'),
    use_sitemap: z.boolean().optional().default(true)
      .describe('Seed the crawl from sitemap.xml as well as links. Required to detect orphan pages.'),
    include_patterns: z.array(z.string()).optional()
      .describe('Only crawl URLs matching these substrings or /regex/ patterns.'),
    exclude_patterns: z.array(z.string()).optional()
      .describe('Skip URLs matching these substrings or /regex/ patterns.'),
    respect_robots: z.boolean().optional().default(true)
      .describe('Obey robots.txt. Only disable for sites you own.'),
    project: z.string().optional().describe('Project name to file this crawl under.'),
    issue_limit: limitSchema(500, 60),
  },
  async handler(args, ctx) {
    const crawl = await crawlSite(args.url, {
      maxPages: args.max_pages,
      concurrency: ctx.cfg.crawl.concurrency,
      hostDelayMs: ctx.cfg.crawl.hostDelayMs,
      timeoutMs: ctx.cfg.crawl.timeoutMs,
      userAgent: ctx.cfg.crawl.userAgent,
      respectRobots: args.respect_robots && ctx.cfg.crawl.respectRobots,
      useSitemap: args.use_sitemap,
      includeSubdomains: args.include_subdomains,
      ...(args.max_depth !== undefined ? { maxDepth: args.max_depth } : {}),
      ...(args.include_patterns ? { includePatterns: args.include_patterns } : {}),
      ...(args.exclude_patterns ? { excludePatterns: args.exclude_patterns } : {}),
    });

    // A crawl where nothing was fetched must not report a health score. It used
    // to say "Crawled 1 pages ... Health score 80.9/100" for a domain that does
    // not resolve, because the failed URL still counted as a page and the audit
    // scored the one issue it produced. The details were honest — pages_ok: 0,
    // the NETWORK error in data.errors — but an agent reads the summary, and
    // "80.9/100" on an unreachable site is a confident wrong answer.
    const fetched = crawl.pages.filter((p) => !p.error && p.status >= 200 && p.status < 400);
    if (fetched.length === 0) {
      const first = crawl.errors[0];
      const blocked = crawl.robots.blocked_count > 0;
      throw new SeoAgentError(
        (first?.code as ErrorCode | undefined) ?? (blocked ? 'ROBOTS_DISALLOWED' : 'NETWORK'),
        `No pages could be fetched from ${crawl.site}` + (first ? `: ${first.error}` : '.'),
        blocked
          ? 'robots.txt disallows the URLs that were queued. Crawl a permitted path, or set SEO_AGENT_IGNORE_ROBOTS=1 for a site you own.'
          : 'Check the URL resolves and returns HTML from this machine. If the host blocks unknown user agents, set SEO_AGENT_USER_AGENT.',
        { attempted: crawl.pages.length, errors: crawl.errors.slice(0, 5) },
      );
    }

    const report = runAudit(crawl);
    const auditCtx = buildContext(crawl);
    const actions = issuesToActions(report, auditCtx);

    let crawlId: number | null = null;
    const warnings: string[] = [];
    try {
      const saved = saveCrawl(crawl, report, {
        ...(args.project ? { project: args.project } : {}),
        config: { max_pages: args.max_pages, use_sitemap: args.use_sitemap },
      });
      crawlId = saved.crawl_id;
    } catch (err) {
      warnings.push(`Crawl completed but could not be saved for diffing: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (crawl.stopped_reason === 'max_pages') {
      warnings.push(
        `Hit the ${args.max_pages}-page limit with ${crawl.queued_not_crawled.length} URLs still queued. ` +
          'Findings cover the crawled subset only. Raise max_pages for full coverage. ' +
          'Orphan detection was skipped: it asserts that nothing on the site links to a page, which cannot be ' +
          'established without completing link discovery.',
      );
    }
    if (crawl.robots.blocked_count > 0) {
      warnings.push(`${crawl.robots.blocked_count} URL(s) were skipped because robots.txt disallows them.`);
    }
    if (crawl.errors.length > 0) {
      warnings.push(`${crawl.errors.length} URL(s) failed to fetch. See data.errors.`);
    }

    const issues = spill('seo_crawl_site', report.issues, args.issue_limit);

    return {
      summary:
        `Crawled ${crawl.pages.length} pages of ${crawl.site}. Health score ${report.health_score}/100 ` +
        `(${report.by_severity.error} errors, ${report.by_severity.warning} warnings, ${report.by_severity.notice} notices). ` +
        `${actions.length} prioritised fixes returned.`,
      data: {
        crawl_id: crawlId,
        site: crawl.site,
        health_score: report.health_score,
        pages_crawled: crawl.pages.length,
        pages_ok: crawl.pages.filter((p) => p.status >= 200 && p.status < 300).length,
        pages_error: crawl.pages.filter((p) => p.status >= 400 || p.error).length,
        by_severity: report.by_severity,
        by_rule: report.by_rule,
        issues: issues.rows,
        orphan_pages: crawl.orphans.slice(0, 50),
        sitemap_urls_found: crawl.sitemap_urls.length,
        robots: crawl.robots,
        stopped_reason: crawl.stopped_reason,
        errors: crawl.errors.slice(0, 20),
      },
      actions,
      warnings,
      meta: {
        source: 'crawler',
        ...issues.meta,
        next: [
          crawlId ? `seo_crawl_diff to compare against a later crawl (this crawl_id is ${crawlId})` : '',
          'seo_internal_links for link equity distribution and orphan analysis',
          'seo_link_opportunities for specific internal links to add',
          'seo_gsc_opportunities to combine these findings with real ranking data',
        ].filter(Boolean),
      },
    };
  },
});

export const auditIssuesTool = defineTool({
  name: 'seo_audit_issues',
  title: 'Query stored audit issues',
  description:
    'Query the issues found by a previous seo_crawl_site run, filtered by severity, rule or URL. ' +
    'Use this to page through findings without re-crawling. Call with no crawl_id to use the most recent crawl for a site.',
  inputSchema: {
    site: z.string().optional().describe('Site to look up the latest crawl for.'),
    crawl_id: z.number().int().optional().describe('Specific crawl to query. Overrides `site`.'),
    severity: z.enum(['error', 'warning', 'notice']).optional(),
    rule: z.string().optional().describe('Rule id, e.g. "title.duplicate". See data.available_rules.'),
    url_contains: z.string().optional().describe('Only issues whose URL contains this substring.'),
    limit: limitSchema(1000, 100),
  },
  async handler(args) {
    const crawlId = args.crawl_id ?? (args.site ? latestCrawlId(siteKey(args.site)) : null);
    if (crawlId === null) {
      throw invalidInput(
        'No crawl found.',
        'Pass a crawl_id, or a `site` that has been crawled. Run seo_crawl_site first.',
      );
    }
    let issues = getCrawlIssues(crawlId, args.severity, args.rule);
    if (args.url_contains) {
      const needle = args.url_contains.toLowerCase();
      issues = issues.filter((i) => i.url.toLowerCase().includes(needle));
    }
    const spilled = spill('seo_audit_issues', issues, args.limit);

    const byRule = new Map<string, number>();
    for (const i of issues) byRule.set(i.rule, (byRule.get(i.rule) ?? 0) + 1);

    return {
      summary: `${issues.length} issue(s) in crawl ${crawlId}${args.rule ? ` for rule "${args.rule}"` : ''}${args.severity ? ` at severity "${args.severity}"` : ''}.`,
      data: {
        crawl_id: crawlId,
        total: issues.length,
        by_rule: [...byRule].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count),
        issues: spilled.rows,
        available_rules: ALL_RULES.map((r) => ({ id: r.id, severity: r.severity, category: r.category, description: r.description })),
      },
      meta: { source: 'crawler', ...spilled.meta },
    };
  },
});

export const pageInspectTool = defineTool({
  name: 'seo_page_inspect',
  title: 'Inspect a single page',
  description:
    'Fetch and fully analyse one URL: title, meta, headings, word count, links, images, structured data, ' +
    'Open Graph tags, hreflang, readability and render-blocking resources. ' +
    'Works on any public URL, including competitors — this is how you analyse a competing page without a SERP provider.',
  inputSchema: {
    url: z.string().describe('The URL to inspect.'),
    include_text: z.boolean().optional().default(false)
      .describe('Include the extracted body text. Large — leave false unless you need to read the content.'),
    include_links: z.boolean().optional().default(false)
      .describe('Include the full link list rather than just counts.'),
  },
  async handler(args, ctx) {
    const { page, html } = await fetchPage(args.url, {
      timeoutMs: ctx.cfg.crawl.timeoutMs,
      userAgent: ctx.cfg.crawl.userAgent,
    });
    const perf = extractPerfSignals(html);
    const read = page.word_count > 0 ? readability(page.text) : null;

    const schemaTypes = page.jsonld
      .map((b) => (b && typeof b === 'object' ? (b as Record<string, unknown>)['@type'] : null))
      .flatMap((t) => (Array.isArray(t) ? t : [t]))
      .filter((t): t is string => typeof t === 'string');

    return {
      summary:
        `${args.url} returned ${page.status}, ${page.word_count} words, ` +
        `${page.links.length} links, ${page.images.length} images` +
        `${schemaTypes.length > 0 ? `, schema: ${[...new Set(schemaTypes)].join(', ')}` : ', no structured data'}.`,
      data: {
        url: page.url,
        final_url: page.final_url,
        status: page.status,
        redirected: page.url !== page.final_url,
        fetch_ms: page.fetch_ms,
        bytes: page.bytes,
        title: page.title,
        title_length: page.title?.length ?? 0,
        meta_description: page.meta_description,
        meta_description_length: page.meta_description?.length ?? 0,
        meta_robots: page.meta_robots,
        canonical: page.canonical,
        canonical_is_self: page.canonical === null ? null : page.canonical === page.final_url,
        lang: page.lang,
        h1: page.h1,
        headings: page.headings,
        word_count: page.word_count,
        readability: read,
        links: {
          total: page.links.length,
          internal: page.links.filter((l) => l.internal).length,
          external: page.links.filter((l) => !l.internal).length,
          nofollow: page.links.filter((l) => l.nofollow).length,
          ...(args.include_links ? { list: page.links.slice(0, 300) } : {}),
        },
        images: {
          total: page.images.length,
          missing_alt: page.images.filter((i) => !i.alt || i.alt.trim() === '').length,
          missing_dimensions: page.images.filter((i) => i.width === null || i.height === null).length,
        },
        structured_data: { types: [...new Set(schemaTypes)], blocks: page.jsonld.length },
        open_graph: page.social,
        hreflang: page.hreflang,
        performance: perf,
        ...(args.include_text ? { text: page.text } : { text_preview: truncate(page.text, 600) }),
      },
      meta: {
        source: 'crawler',
        next: ['seo_content_score to grade this page against a target keyword'],
      },
    };
  },
});

export const internalLinksTool = defineTool({
  name: 'seo_internal_links',
  title: 'Analyse internal link equity',
  description:
    'Compute internal PageRank across a crawled site to show where link authority actually flows. ' +
    'Identifies orphan pages (zero inbound links), starved pages (indexable but under-linked), hub pages, ' +
    'and the crawl-depth distribution. Internal linking is the highest-leverage lever fully under your control.',
  inputSchema: {
    site: z.string().optional().describe('Site whose latest crawl to analyse.'),
    crawl_id: z.number().int().optional().describe('Specific crawl to analyse.'),
    limit: limitSchema(500, 40),
  },
  async handler(args) {
    const crawlId = args.crawl_id ?? (args.site ? latestCrawlId(siteKey(args.site)) : null);
    if (crawlId === null) {
      throw invalidInput('No crawl found.', 'Run seo_crawl_site first, then pass its site or crawl_id.');
    }
    const pages = getCrawlPages(crawlId);
    const report = analyzeLinkGraph(pages);
    const opportunities = findLinkOpportunities(pages, { limit: 40 });
    const actions = linkGraphToActions(report, opportunities);
    const nodes = spill('seo_internal_links', report.nodes, args.limit);

    return {
      summary:
        `${report.total_pages} pages, ${report.total_internal_links} internal links ` +
        `(${report.avg_links_per_page} per page). ${report.orphans.length} orphan(s), ` +
        `${report.starved_pages.length} under-linked page(s), max depth ${report.max_depth}.`,
      data: {
        crawl_id: crawlId,
        total_pages: report.total_pages,
        total_internal_links: report.total_internal_links,
        avg_links_per_page: report.avg_links_per_page,
        max_depth: report.max_depth,
        depth_distribution: report.depth_distribution,
        orphans: report.orphans.slice(0, 50),
        starved_pages: report.starved_pages,
        hub_pages: report.hub_pages,
        pages_by_page_rank: nodes.rows,
      },
      actions,
      meta: { source: 'crawler', ...nodes.meta, next: ['seo_link_opportunities for specific links to add'] },
    };
  },
});

export const linkOpportunitiesTool = defineTool({
  name: 'seo_link_opportunities',
  title: 'Find internal links to add',
  description:
    'Find pages that already mention a target page\'s topic in body text but do not link to it. ' +
    'Returns the source page, the exact anchor phrase, and the sentence to edit — each is a one-line change. ' +
    'This is the cheapest ranking improvement available on most sites.',
  inputSchema: {
    site: z.string().optional().describe('Site whose latest crawl to analyse.'),
    crawl_id: z.number().int().optional(),
    targets: z.array(z.string()).optional()
      .describe('Specific URLs that need more inbound links. Defaults to the most under-linked pages.'),
    max_per_target: z.number().int().min(1).max(20).optional().default(3),
    limit: limitSchema(300, 50),
  },
  async handler(args) {
    const crawlId = args.crawl_id ?? (args.site ? latestCrawlId(siteKey(args.site)) : null);
    if (crawlId === null) {
      throw invalidInput('No crawl found.', 'Run seo_crawl_site first, then pass its site or crawl_id.');
    }
    const pages = getCrawlPages(crawlId);
    const opportunities = findLinkOpportunities(pages, {
      ...(args.targets ? { targets: args.targets } : {}),
      maxPerTarget: args.max_per_target,
      limit: args.limit,
    });
    const report = analyzeLinkGraph(pages);
    const spilled = spill('seo_link_opportunities', opportunities, args.limit);

    return {
      summary:
        opportunities.length > 0
          ? `${opportunities.length} internal link(s) worth adding, across ${new Set(opportunities.map((o) => o.to_url)).size} target page(s).`
          : 'No unlinked topical mentions found. Either the site is already densely interlinked, or the crawl was too small to find matches.',
      data: { crawl_id: crawlId, opportunities: spilled.rows },
      actions: linkGraphToActions(report, opportunities),
      meta: { source: 'crawler', ...spilled.meta },
    };
  },
});

export const crawlDiffTool = defineTool({
  name: 'seo_crawl_diff',
  title: 'Compare two crawls',
  description:
    'Compare two crawls of the same site to see exactly what changed: new and resolved issues, pages added and ' +
    'removed, pages that became non-indexable, titles and content that changed, and the health-score delta. ' +
    'This is the tool for "did my fixes work" and "what broke since last week". ' +
    'With no ids, compares the two most recent crawls of the site.',
  inputSchema: {
    site: z.string().optional().describe('Site to compare the two most recent crawls of.'),
    from_crawl_id: z.number().int().optional().describe('Baseline crawl (the older one).'),
    to_crawl_id: z.number().int().optional().describe('Comparison crawl (the newer one).'),
    limit: limitSchema(500, 60),
  },
  async handler(args) {
    let fromId = args.from_crawl_id;
    let toId = args.to_crawl_id;

    if (fromId === undefined || toId === undefined) {
      if (!args.site) {
        throw invalidInput(
          'Need either both crawl ids or a site.',
          'Pass `site` to compare its two most recent crawls, or pass from_crawl_id and to_crawl_id explicitly.',
        );
      }
      const history = listCrawls(siteKey(args.site), 2);
      if (history.length < 2) {
        throw invalidInput(
          `Only ${history.length} crawl(s) stored for ${args.site}; two are needed to diff.`,
          'Run seo_crawl_site again after making changes, then call this tool.',
        );
      }
      toId = toId ?? (history[0] as { id: number }).id;
      fromId = fromId ?? (history[1] as { id: number }).id;
    }

    const diff = diffCrawls(fromId, toId, { maxItems: args.limit });
    const actions = diffToActions(diff);

    const delta = diff.health_delta;
    const direction = delta === null ? 'unchanged' : delta > 0 ? `improved ${delta}` : `declined ${Math.abs(delta)}`;

    return {
      summary:
        `Health ${direction} points (${diff.health_score_before} → ${diff.health_score_after}). ` +
        `${diff.issues.new.length} new issue(s), ${diff.issues.resolved.length} resolved. ` +
        `${diff.pages.added.length} page(s) added, ${diff.pages.removed.length} removed, ${diff.changed_pages.length} changed.`,
      data: diff,
      actions,
      meta: { source: 'crawler' },
    };
  },
});

export const crawlHistoryTool = defineTool({
  name: 'seo_crawl_history',
  title: 'List stored crawls',
  description:
    'List previous crawls with their dates, page counts and health scores. Use this to find crawl ids for seo_crawl_diff ' +
    'and to see how site health has trended over time.',
  inputSchema: {
    site: z.string().optional().describe('Filter to one site. Omit for all sites.'),
    limit: limitSchema(200, 20),
  },
  async handler(args) {
    const crawls = listCrawls(args.site ? siteKey(args.site) : undefined, args.limit);
    const trend =
      crawls.length >= 2 && crawls[0]?.health_score != null && crawls[crawls.length - 1]?.health_score != null
        ? round((crawls[0].health_score as number) - (crawls[crawls.length - 1]?.health_score as number), 1)
        : null;

    return {
      summary:
        crawls.length === 0
          ? 'No crawls stored yet. Run seo_crawl_site first.'
          : `${crawls.length} crawl(s) stored${trend !== null ? `; health has moved ${trend > 0 ? '+' : ''}${trend} points across this window` : ''}.`,
      data: { crawls, health_trend: trend },
      meta: { source: 'store' },
    };
  },
});
