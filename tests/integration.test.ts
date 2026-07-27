import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Envelope } from '../src/core/types.js';

/**
 * End-to-end tests against the built MCP server over a real stdio transport,
 * plus live HTTP against real sites.
 *
 * These are the tests that would catch a break the unit suite can't see: a
 * malformed tool schema, a serialisation failure, a broken transport, or a
 * change in how a real site responds. They need `npm run build` first and they
 * need network access.
 */

let client: Client;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'seo-agent-e2e-'));
  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(process.cwd(), 'dist', 'mcp-server.js')],
    env: { ...process.env, SEO_AGENT_DATA_DIR: dataDir } as Record<string, string>,
    stderr: 'pipe',
  });
  client = new Client({ name: 'seo-agent-tests', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<Envelope<T>> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = res.content?.[0]?.text ?? '';
  return JSON.parse(text) as Envelope<T>;
}

describe('MCP protocol surface', () => {
  it('registers every tool with a usable schema and a substantive description', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(30);
    for (const t of tools) {
      expect(t.description, `${t.name} has no description`).toBeTruthy();
      // An agent picks tools from the description alone, so a one-liner is a bug.
      expect((t.description as string).length, `${t.name} description is too short`).toBeGreaterThan(60);
      expect(t.inputSchema, `${t.name} has no input schema`).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('uses a consistent tool naming convention', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.name).toMatch(/^(seo|pseo)_[a-z_]+$/);
    }
  });

  it('exposes the capabilities resource', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('seo-agent://capabilities');
    const read = await client.readResource({ uri: 'seo-agent://capabilities' });
    const parsed = JSON.parse(read.contents[0]?.text as string) as { capabilities: unknown[] };
    expect(parsed.capabilities.length).toBeGreaterThan(5);
  });
});

describe('envelope contract', () => {
  it('every successful response carries ok, summary, data and meta', async () => {
    const env = await call('seo_capabilities');
    expect(env.ok).toBe(true);
    expect(typeof env.summary).toBe('string');
    expect(env.summary.length).toBeGreaterThan(10);
    expect(env.data).toBeDefined();
    expect(env.meta).toBeDefined();
    expect(typeof env.meta.took_ms).toBe('number');
  });

  it('reports unconfigured providers as a structured error with a remedy and a fallback', async () => {
    const env = await call<{ error: { code: string; remedy: string } }>('seo_serp', { keyword: 'test' });
    expect(env.ok).toBe(false);
    expect(env.data.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    // The remedy must name both the env var and what still works without it.
    expect(env.data.error.remedy).toMatch(/SERPER_API_KEY/);
    expect(env.data.error.remedy).toMatch(/seo_gsc_performance|seo_keyword_ideas|seo_page_inspect/);
  });

  it('classifies a missing-argument case as INVALID_INPUT, not INTERNAL', async () => {
    // seo_cluster_keywords accepts either `keywords` or `project`, so neither is
    // declared required and the check lives in the handler. It used to `throw new
    // Error(...)`, which the runtime maps to INTERNAL — whose remedy reads "This
    // is likely a bug in seo-agent. Report the message and inputs." That tells an
    // agent to abandon a call it could have fixed by passing one argument.
    const env = await call<{ error: { code: string; remedy: string } }>('seo_cluster_keywords', {});
    expect(env.ok).toBe(false);
    expect(env.data.error.code).toBe('INVALID_INPUT');
    expect(env.data.error.remedy).not.toMatch(/likely a bug/i);
    expect(env.data.error.remedy).toMatch(/keywords/);
    expect(env.data.error.remedy).toMatch(/project/);
  }, 20_000);

  it('treats a stale crawl id as INVALID_INPUT and points at the lookup tool', async () => {
    const env = await call<{ error: { code: string; remedy: string } }>('seo_crawl_diff', {
      from_crawl_id: 999_999,
      to_crawl_id: 999_998,
    });
    expect(env.ok).toBe(false);
    expect(env.data.error.code).toBe('INVALID_INPUT');
    expect(env.data.error.remedy).not.toMatch(/likely a bug/i);
    expect(env.data.error.remedy).toMatch(/seo_crawl_history/);
  }, 20_000);

  it('never reports a total provider failure as a successful empty result', async () => {
    // With no SERP provider these two used to return ok:true with "ranks for 0
    // of 0 keyword(s)" and "found 0 competing domains", no warnings. An agent
    // reads that as "we rank for nothing" and "we have no competitors" — a
    // confident false negative on the two questions it most wants answered.
    for (const [tool, args] of [
      ['seo_rank_check', { domain: 'example.com', keywords: ['example domain'] }],
      ['seo_competitors_discover', { keywords: ['example domain'] }],
    ] as const) {
      const env = await call<{ error: { code: string; remedy: string } }>(tool, args);
      expect(env.ok, `${tool} claimed success with no provider`).toBe(false);
      expect(env.data.error.code).toBe('PROVIDER_NOT_CONFIGURED');
      expect(env.data.error.remedy).toMatch(/SERPER_API_KEY/);
      expect(env.summary).not.toMatch(/\b0 of 0\b/);
    }
  }, 30_000);

  it('refuses to score a site it could not fetch', async () => {
    // The .invalid TLD is reserved and never resolves, so this is deterministic.
    // It used to return ok:true, "Crawled 1 pages", "Health score 80.9/100" —
    // a healthy score for a domain that does not exist, because the failed URL
    // counted as a page and the audit scored the single issue it produced.
    const env = await call<{ error: { code: string; remedy: string } }>('seo_crawl_site', {
      url: 'https://this-domain-does-not-exist-xyz123.invalid',
      max_pages: 3,
    });
    expect(env.ok).toBe(false);
    expect(env.data.error.code).toBe('NETWORK');
    expect(env.data.error.remedy).not.toMatch(/likely a bug/i);
    expect(env.summary).not.toMatch(/[Hh]ealth score/);
  }, 45_000);

  it('reports an unreachable page as NETWORK, not an internal bug', async () => {
    const env = await call<{ error: { code: string; remedy: string } }>('seo_page_inspect', {
      url: 'http://127.0.0.1:9/nothing-listens-here',
    });
    expect(env.ok).toBe(false);
    expect(env.data.error.code).toBe('NETWORK');
    expect(env.data.error.remedy).not.toMatch(/likely a bug/i);
  }, 30_000);

  it('reports bad input as a structured error rather than crashing', async () => {
    const env = await call<{ error: { code: string; remedy: string } }>('seo_content_score', {
      primary_keyword: 'x',
    });
    expect(env.ok).toBe(false);
    expect(env.data.error.code).toBe('INVALID_INPUT');
    expect(env.data.error.remedy).toMatch(/body|url/);
  });
});

describe('zero-configuration workflow against real sites', () => {
  let crawlId: number;

  it('crawls and audits a live site', async () => {
    const env = await call<{
      crawl_id: number;
      site: string;
      health_score: number;
      pages_crawled: number;
      by_severity: Record<string, number>;
    }>('seo_crawl_site', { url: 'https://example.com', max_pages: 3 });

    expect(env.ok).toBe(true);
    expect(env.data.pages_crawled).toBeGreaterThan(0);
    expect(env.data.site).toContain('example.com');
    expect(env.data.health_score).toBeGreaterThanOrEqual(0);
    expect(env.data.health_score).toBeLessThanOrEqual(100);
    expect(env.meta.source).toBe('crawler');
    crawlId = env.data.crawl_id;
    expect(crawlId).toBeGreaterThan(0);
  }, 45_000);

  it('returns actions that are ranked and machine-applicable', async () => {
    const env = await call('seo_audit_issues', { crawl_id: crawlId });
    expect(env.ok).toBe(true);

    const next = await call('seo_next_actions', { crawl_id: crawlId });
    expect(next.ok).toBe(true);
    const actions = next.actions ?? [];
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(a.id).toBeTruthy();
      expect(['critical', 'high', 'medium', 'low']).toContain(a.priority);
      expect(['trivial', 'small', 'medium', 'large']).toContain(a.effort);
      expect(a.impact_score).toBeGreaterThanOrEqual(0);
      expect(a.impact_score).toBeLessThanOrEqual(100);
      expect(a.title.length).toBeGreaterThan(5);
    }
    // Ranked by impact-per-effort, so a critical item can never sort below a low one.
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    const firstLow = actions.findIndex((a) => a.priority === 'low');
    const lastCritical = actions.map((a) => a.priority).lastIndexOf('critical');
    if (firstLow >= 0 && lastCritical >= 0) expect(lastCritical).toBeLessThan(firstLow);
    void rank;
  }, 30_000);

  it('inspects an arbitrary live URL, including a competitor', async () => {
    const env = await call<{ status: number; title: string | null; word_count: number }>(
      'seo_page_inspect',
      { url: 'https://example.com' },
    );
    expect(env.ok).toBe(true);
    expect(env.data.status).toBe(200);
    expect(env.data.title).toBeTruthy();
  }, 30_000);

  it('diffs two crawls of the same site', async () => {
    const second = await call<{ crawl_id: number }>('seo_crawl_site', {
      url: 'https://example.com',
      max_pages: 3,
    });
    const diff = await call<{ health_delta: number | null; issues: { new: unknown[]; resolved: unknown[] } }>(
      'seo_crawl_diff',
      { from_crawl_id: crawlId, to_crawl_id: second.data.crawl_id },
    );
    expect(diff.ok).toBe(true);
    // Nothing changed on example.com between two runs seconds apart.
    expect(diff.data.issues.new).toHaveLength(0);
    expect(diff.data.health_delta).toBe(0);
  }, 60_000);

  it('discovers real keywords from autocomplete with no API key', async () => {
    const env = await call<{
      total_found: number;
      keywords: Array<{ keyword: string; intent: string; opportunity: number | null }>;
      intent_breakdown: Record<string, number>;
    }>('seo_keyword_ideas', {
      seed: 'project management software',
      strategies: ['plain', 'questions'],
      with_metrics: false,
      limit: 20,
    });

    expect(env.ok).toBe(true);
    expect(env.data.total_found).toBeGreaterThan(3);
    // Every returned keyword should relate to the seed.
    const related = env.data.keywords.filter((k) => /project|management|software/i.test(k.keyword));
    expect(related.length).toBeGreaterThan(0);
    for (const k of env.data.keywords) {
      expect(['informational', 'commercial', 'transactional', 'navigational']).toContain(k.intent);
    }
    // No metrics provider, so the tool must say so rather than inventing volumes.
    expect(env.warnings?.join(' ')).toMatch(/lexical estimates|no keyword metrics provider/i);
  }, 60_000);

  it('scores a draft and returns applyable edits', async () => {
    const env = await call<{ score: number; grade: string; issues: string[] }>('seo_content_score', {
      primary_keyword: 'best crm software',
      title: 'An Unrelated Title',
      body: '## Notes\n\nWe sell some things here.',
      required_terms: ['pipeline management'],
    });
    expect(env.ok).toBe(true);
    expect(env.data.grade).toBe('F');
    const titleFix = (env.actions ?? []).find((a) => a.fix?.type === 'set_title');
    expect(titleFix?.fix?.to).toBeTruthy();
  }, 20_000);

  it('runs the full programmatic-SEO workflow and blocks an unsafe set', async () => {
    const keywords = [
      'notion alternatives', 'airtable alternatives', 'asana alternatives',
      'trello alternatives', 'monday alternatives', 'clickup alternatives',
    ];

    const patterns = await call<{ patterns: Array<{ template: string; entities: string[] }> }>(
      'pseo_discover_patterns',
      { keywords, min_entities: 4 },
    );
    expect(patterns.ok).toBe(true);
    expect(patterns.data.patterns[0]?.template).toBe('{x} alternatives');

    const plan = await call<{ total_pages: number; pages: Array<{ url_path: string }> }>('pseo_build_plan', {
      keywords,
      template: '{x} alternatives',
      base_path: '/alternatives',
    });
    expect(plan.ok).toBe(true);
    expect(plan.data.total_pages).toBe(6);
    // The plan must insist on validation before publishing.
    expect((plan.actions ?? []).some((a) => a.fix?.type === 'run_index_risk_check')).toBe(true);

    const risk = await call<{ verdict: string }>('pseo_check_index_risk', {
      pages: plan.data.pages.map((p) => ({
        url: p.url_path,
        title: 'Alternatives',
        body: 'Looking for alternatives? We compare the best options for your team today. '.repeat(6),
      })),
    });
    expect(risk.ok).toBe(true);
    expect(risk.data.verdict).toBe('do_not_publish');
  }, 30_000);

  it('analyses the internal link graph of a stored crawl', async () => {
    const env = await call<{ total_pages: number; max_depth: number }>('seo_internal_links', {
      crawl_id: crawlId,
    });
    expect(env.ok).toBe(true);
    expect(env.data.total_pages).toBeGreaterThan(0);
  }, 20_000);

  it('persists project state across tool calls', async () => {
    await call('seo_project_set', { name: 'e2e', site: 'https://example.com', competitors: ['iana.org'] });
    const list = await call<{ projects: Array<{ name: string; competitors: string[] }> }>('seo_project_list');
    const project = list.data.projects.find((p) => p.name === 'e2e');
    expect(project?.competitors).toEqual(['iana.org']);
  }, 20_000);
});

describe('programmatic SEO handoff', () => {
  // pseo_build_plan returns page specs keyed on `url_path`, and its own critical
  // action tells the agent to run pseo_check_index_risk next. The gate used to
  // require `url`, so the obvious call — hand the plan's pages straight to the
  // gate — failed schema validation. Friction on a safety path is worse than
  // friction anywhere else: the cheapest way out of a validation error is to
  // skip the check, which is the one thing this tool exists to prevent.
  it('feeds pseo_build_plan output straight into pseo_check_index_risk unmodified', async () => {
    const keywords = [
      'time tracking software for accountants', 'time tracking software for agencies',
      'time tracking software for architects', 'time tracking software for consultants',
      'time tracking software for freelancers', 'time tracking software for engineers',
    ];
    const plan = await call<{ pages: Array<{ url_path: string; title: string }> }>('pseo_build_plan', {
      keywords,
      template: 'time tracking software for {x}',
      base_path: '/for',
      max_pages: 6,
    });
    expect(plan.ok).toBe(true);
    expect(plan.data.pages.length).toBeGreaterThan(3);
    // The plan does not emit `url`; that is the field name the gate used to demand.
    expect(plan.data.pages[0]).not.toHaveProperty('url');
    expect(plan.data.pages[0]?.url_path).toBeTruthy();

    // Pass the specs through with only a body added, exactly as an agent would
    // after generating drafts. No renaming.
    const pages = plan.data.pages.map((pg) => ({
      ...pg,
      body: `${pg.title}. Shared boilerplate about logging hours and billing clients. `.repeat(8),
    }));
    const risk = await call<{ verdict: string }>('pseo_check_index_risk', { pages });
    expect(risk.ok, `gate rejected the plan's own output: ${risk.summary}`).toBe(true);
    // These drafts are deliberately near-identical, so the gate must object.
    expect(risk.data.verdict).not.toBe('safe');
    expect(risk.actions.length).toBeGreaterThan(0);
  }, 30_000);

  it('still rejects a page with neither url nor url_path', async () => {
    // Schema rejections arrive as an MCP protocol error rather than an envelope,
    // so this reads the raw result instead of going through call().
    const res = (await client.callTool({
      name: 'pseo_check_index_risk',
      arguments: { pages: [{ title: 'No url here', body: 'word '.repeat(400) }] },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(res.isError).toBe(true);
    // The message has to name both accepted spellings, or an agent cannot tell
    // which field it forgot.
    expect(res.content?.[0]?.text).toMatch(/url_path/);
  }, 20_000);
});

describe('capability advertising integrity', () => {
  it('every tool named in seo_capabilities actually exists', async () => {
    const { tools } = await client.listTools();
    const registered = new Set(tools.map((t) => t.name));

    const env = await call<{ capabilities: Array<{ name: string; tools: string[] }> }>('seo_capabilities');
    const dangling: string[] = [];
    for (const c of env.data.capabilities) {
      for (const t of c.tools) if (!registered.has(t)) dangling.push(`${t} (claimed by ${c.name})`);
    }
    // A capability that advertises a tool which doesn't exist sends an agent
    // hunting for something that isn't there.
    expect(dangling, `dangling capability claims: ${dangling.join(', ')}`).toHaveLength(0);
  });

  it('every tool name anywhere in the capability payload resolves, prose included', async () => {
    // Walking only `tools[]` is too narrow. `unlock_with` and `degraded_to` are
    // free text, and `degraded_to` is read at exactly the moment an agent is
    // blocked and looking for a way forward — a nonexistent tool named there is
    // worse than saying nothing. A stale `seo_mentions_find` survived here
    // precisely because the array-only check never looked at the prose.
    const { tools } = await client.listTools();
    const registered = new Set(tools.map((t) => t.name));

    const env = await call<{ capabilities: unknown[] }>('seo_capabilities');
    const mentioned = new Set(JSON.stringify(env.data).match(/\b(?:seo|pseo)_[a-z_]+\b/g) ?? []);
    expect(mentioned.size).toBeGreaterThan(20); // guard: the regex must actually be finding names

    const dangling = [...mentioned].filter((n) => !registered.has(n));
    expect(dangling, `capability payload names nonexistent tool(s): ${dangling.join(', ')}`).toHaveLength(0);
  });

  it('every tool name referenced inside another tool description resolves', async () => {
    const { tools } = await client.listTools();
    const registered = new Set(tools.map((t) => t.name));
    const broken = new Set<string>();
    for (const t of tools) {
      for (const m of (t.description ?? '').matchAll(/\b((?:seo|pseo)_[a-z_]+)\b/g)) {
        if (!registered.has(m[1] as string)) broken.add(m[1] as string);
      }
    }
    expect([...broken], 'tool descriptions point at non-existent tools').toHaveLength(0);
  });
});

describe('orphan detection under a truncated crawl', () => {
  // index.orphan asserts "nothing on this site links here". That can only be
  // concluded once link discovery finishes. Computed regardless, every sitemap
  // URL a page budget never reached looked orphaned: stripe.com with max_pages=4
  // produced 1,930 orphan warnings and a health score of 0, burying all 6 real
  // errors. Restricting it to fetched pages is not enough either — the crawl
  // seeds from the sitemap, so a seeded page has no inbound link within the
  // subset even when the next page links to it.
  let server: import('node:http').Server;
  let base: string;

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    const html = (title: string, body: string) =>
      `<!doctype html><html lang="en"><head><title>${title}</title>` +
      `<meta name="description" content="A description for ${title} long enough to satisfy the audit rules."></head>` +
      `<body><h1>${title}</h1>${body}</body></html>`;
    server = createServer((req, res) => {
      const port = (server.address() as { port: number }).port;
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`User-agent: *\nAllow: /\nSitemap: http://127.0.0.1:${port}/sitemap.xml\n`);
      }
      if (req.url === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            `<url><loc>http://127.0.0.1:${port}/</loc></url>` +
            `<url><loc>http://127.0.0.1:${port}/linked</loc></url>` +
            `<url><loc>http://127.0.0.1:${port}/orphaned</loc></url></urlset>`,
        );
      }
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(html('Home', '<a href="/linked">linked page</a>'));
      }
      if (req.url === '/linked') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(html('Linked', '<a href="/">home</a>'));
      }
      if (req.url === '/orphaned') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(html('Orphaned', '<p>nothing links here</p>'));
      }
      res.writeHead(404).end('no');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it('finds a genuine orphan when link discovery completed', async () => {
    const { crawlSite } = await import('../src/crawl/crawler.js');
    const crawl = await crawlSite(base, {
      maxPages: 50, concurrency: 2, hostDelayMs: 0, timeoutMs: 5000,
      userAgent: 'seo-agent-test', respectRobots: true, useSitemap: true, includeSubdomains: false,
    });
    expect(crawl.stopped_reason).toBe('complete');
    expect(crawl.orphans.map((u) => new URL(u).pathname)).toEqual(['/orphaned']);
  }, 30_000);

  it('claims no orphans when the crawl was truncated', async () => {
    const { crawlSite } = await import('../src/crawl/crawler.js');
    const crawl = await crawlSite(base, {
      maxPages: 1, concurrency: 1, hostDelayMs: 0, timeoutMs: 5000,
      userAgent: 'seo-agent-test', respectRobots: true, useSitemap: true, includeSubdomains: false,
    });
    expect(crawl.stopped_reason).toBe('max_pages');
    // /orphaned and /linked are both un-reached here; neither is a conclusion.
    expect(crawl.orphans).toEqual([]);
  }, 30_000);
});

describe('CLI argument handling', () => {
  const cli = join(process.cwd(), 'dist', 'cli.js');

  const run = (args: string[]): { code: number | null; stdout: string; stderr: string } => {
    const r = spawnSync('node', [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, SEO_AGENT_DATA_DIR: dataDir },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('blocks a metered tool before it spends when the budget is exhausted', () => {
    // A fake key is enough: the point is that reserve() runs *before* the network
    // call, so the failure must be BUDGET_EXCEEDED rather than a provider error.
    // seo_ai_visibility charged only after the fact, leaving the most expensive
    // tool here entirely outside SEO_AGENT_BUDGET.
    const r = spawnSync('node', [cli, 'seo_ai_visibility', '--brand', 'Toggl', '--topic', 'time tracking'], {
      encoding: 'utf8',
      env: { ...process.env, SEO_AGENT_DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'sk-ant-fake', SEO_AGENT_BUDGET: '0' },
    });
    // Failing calls go to stderr with a non-zero exit; the envelope is there.
    expect(r.status).not.toBe(0);
    const env = JSON.parse(r.stderr) as Envelope<{ error: { code: string } }>;
    expect(env.ok).toBe(false);
    expect(env.data.error.code).toBe('BUDGET_EXCEEDED');
  }, 30_000);

  it('reports a missing key as PROVIDER_NOT_CONFIGURED even when the budget is zero', () => {
    // Ordering matters: with no key at all there is nothing to spend, so a
    // budget error would misdirect the agent.
    const r = spawnSync('node', [cli, 'seo_page_speed', '--url', 'https://example.com'], {
      encoding: 'utf8',
      env: { ...process.env, SEO_AGENT_DATA_DIR: dataDir, SEO_AGENT_BUDGET: '0', PAGESPEED_API_KEY: '' },
    });
    expect(r.status).not.toBe(0);
    const env = JSON.parse(r.stderr) as Envelope<{ error: { code: string } }>;
    expect(env.ok).toBe(false);
    expect(env.data.error.code).toBe('PROVIDER_NOT_CONFIGURED');
  }, 30_000);

  it('accepts a single value for an array argument', () => {
    // `--competitors a.com` is the natural CLI form; the repeat-key parser only
    // builds an array on a second occurrence, so a lone value used to fail zod.
    const r = run(['seo_project_set', '--name', 'cli-one', '--site', 'https://a.example', '--competitors', 'rival.com', '--quiet']);
    expect(r.stderr).not.toMatch(/Expected array/);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/1 competitor/);
  });

  it('rejects an unknown flag instead of silently ignoring it', () => {
    // zod strips unknown keys, so a mistyped flag used to vanish and the tool ran
    // with its defaults — a confident, plausible answer to a different question.
    // Found live: `--dimension date` (the field is `dimensions`) silently
    // returned query-dimension rows.
    const r = run(['seo_gsc_performance', '--days', '28', '--dimension', 'date']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Unknown argument/);
  });

  it('suggests the correct name for a near-miss flag', () => {
    const r = run(['seo_gsc_performance', '--dimension', 'date']);
    expect(r.stderr).toMatch(/did you mean --dimensions\?/);
  });

  it('lists the valid arguments when a flag is unrecognisable', () => {
    const r = run(['seo_keyword_ideas', '--seed', 'crm', '--not_a_real_flag', 'x']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Unknown argument/);
    expect(r.stderr).toMatch(/--seed/);
    // No guess should be offered when nothing is close.
    expect(r.stderr).not.toMatch(/did you mean/);
  });

  it('still accepts every documented flag for a tool', () => {
    // Guards against the unknown-flag check rejecting legitimate arguments.
    const r = run(['seo_project_set', '--name', 'cli-known', '--site', 'https://c.example', '--quiet']);
    expect(r.stderr).not.toMatch(/Unknown argument/);
    expect(r.code).toBe(0);
  });

  it('accepts a repeated flag as a multi-element array', () => {
    const r = run([
      'seo_project_set', '--name', 'cli-many', '--site', 'https://b.example',
      '--competitors', 'one.com', '--competitors', 'two.com', '--quiet',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/2 competitor/);
  });

  it('accepts a JSON array', () => {
    const r = run(['seo_project_set', '--name', 'cli-json', '--site', 'https://c.example', '--competitors', '["x.com","y.com"]', '--quiet']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/2 competitor/);
  });

  it('exits non-zero with a usable message for an unknown tool', () => {
    const r = run(['seo_does_not_exist']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Unknown tool/);
  });

  it('reports missing required arguments by name', () => {
    const r = run(['seo_content_score']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/primary_keyword/);
  });
});
