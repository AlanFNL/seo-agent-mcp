import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Configuration, resolved once at startup.
 *
 * Everything is optional. The tool must do useful work with an empty
 * environment — crawling, auditing, keyword discovery via autocomplete, content
 * scoring and programmatic-SEO planning all run with zero keys. Keys only widen
 * what's possible, and `seo_capabilities` tells the agent exactly which doors
 * are currently open so it never guesses.
 */

export interface Config {
  dataDir: string;
  dbPath: string;
  artifactDir: string;

  serp: {
    provider: 'serper' | 'serpapi' | 'dataforseo' | 'none';
    serperKey?: string;
    serpapiKey?: string;
  };
  keywordData: {
    provider: 'dataforseo' | 'none';
  };
  backlinks: {
    provider: 'dataforseo' | 'openpagerank' | 'none';
    openPageRankKey?: string;
  };
  dataforseo?: { login: string; password: string };

  gsc?: {
    /** Service-account JSON, or an OAuth refresh-token triple. */
    serviceAccountJson?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    siteUrl?: string;
  };

  pagespeedKey?: string;

  /** Powers the AI-visibility tools (does an LLM cite us?). */
  anthropicKey?: string;

  crawl: {
    maxPages: number;
    concurrency: number;
    hostDelayMs: number;
    timeoutMs: number;
    userAgent: string;
    respectRobots: boolean;
  };

  defaults: {
    location: string;
    language: string;
    device: 'desktop' | 'mobile';
  };

  /** Max provider units per session. undefined = unlimited. */
  budget?: number;
  /** Hard ceiling on rows returned inline by any tool before spilling to an artifact. */
  maxInlineRows: number;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pickSerpProvider(): Config['serp'] {
  if (process.env.SERPER_API_KEY) {
    return { provider: 'serper', serperKey: process.env.SERPER_API_KEY };
  }
  if (process.env.SERPAPI_KEY) {
    return { provider: 'serpapi', serpapiKey: process.env.SERPAPI_KEY };
  }
  if (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD) {
    return { provider: 'dataforseo' };
  }
  return { provider: 'none' };
}

function pickBacklinkProvider(): Config['backlinks'] {
  if (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD) {
    return { provider: 'dataforseo' };
  }
  if (process.env.OPENPAGERANK_API_KEY) {
    return { provider: 'openpagerank', openPageRankKey: process.env.OPENPAGERANK_API_KEY };
  }
  return { provider: 'none' };
}

let cachedConfig: Config | null = null;

export function loadConfig(overrides: Partial<Config> = {}): Config {
  if (cachedConfig && Object.keys(overrides).length === 0) return cachedConfig;

  loadDotEnv();

  const dataDir =
    overrides.dataDir ??
    process.env.SEO_AGENT_DATA_DIR ??
    join(process.env.HOME ?? homedir(), '.seo-agent');

  const dfsLogin = process.env.DATAFORSEO_LOGIN;
  const dfsPassword = process.env.DATAFORSEO_PASSWORD;

  const config: Config = {
    dataDir,
    dbPath: join(dataDir, 'seo-agent.db'),
    artifactDir: join(dataDir, 'artifacts'),

    serp: pickSerpProvider(),
    keywordData: { provider: dfsLogin && dfsPassword ? 'dataforseo' : 'none' },
    backlinks: pickBacklinkProvider(),
    ...(dfsLogin && dfsPassword ? { dataforseo: { login: dfsLogin, password: dfsPassword } } : {}),

    ...(process.env.GSC_SERVICE_ACCOUNT_JSON ||
    process.env.GSC_CLIENT_ID ||
    process.env.GSC_REFRESH_TOKEN
      ? {
          gsc: {
            serviceAccountJson: process.env.GSC_SERVICE_ACCOUNT_JSON,
            clientId: process.env.GSC_CLIENT_ID,
            clientSecret: process.env.GSC_CLIENT_SECRET,
            refreshToken: process.env.GSC_REFRESH_TOKEN,
            siteUrl: process.env.GSC_SITE_URL,
          },
        }
      : {}),

    pagespeedKey: process.env.PAGESPEED_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,

    crawl: {
      maxPages: envInt('SEO_AGENT_MAX_PAGES', 500),
      concurrency: envInt('SEO_AGENT_CONCURRENCY', 5),
      hostDelayMs: envInt('SEO_AGENT_HOST_DELAY_MS', 250),
      timeoutMs: envInt('SEO_AGENT_TIMEOUT_MS', 20_000),
      userAgent:
        process.env.SEO_AGENT_USER_AGENT ??
        'Mozilla/5.0 (compatible; seo-agent/0.1; +https://github.com/seo-agent/seo-agent) AgentSEOBot',
      respectRobots: process.env.SEO_AGENT_IGNORE_ROBOTS !== '1',
    },

    defaults: {
      location: process.env.SEO_AGENT_LOCATION ?? 'United States',
      language: process.env.SEO_AGENT_LANGUAGE ?? 'en',
      device: process.env.SEO_AGENT_DEVICE === 'mobile' ? 'mobile' : 'desktop',
    },

    budget: process.env.SEO_AGENT_BUDGET ? Number(process.env.SEO_AGENT_BUDGET) : undefined,
    maxInlineRows: envInt('SEO_AGENT_MAX_INLINE_ROWS', 100),

    ...overrides,
  };

  if (Object.keys(overrides).length === 0) cachedConfig = config;
  return config;
}

export function resetConfig(): void {
  cachedConfig = null;
}

/** Minimal .env loader — no dependency, and it never clobbers real env vars. */
function loadDotEnv(): void {
  for (const candidate of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), candidate);
    if (!existsSync(path)) continue;
    try {
      for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
        if (process.env[key] !== undefined) continue;
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    } catch {
      // A malformed .env should not stop the server from booting.
    }
  }
}

/** What an agent can actually do right now, and what unlocks the rest. */
export interface Capability {
  name: string;
  available: boolean;
  provider: string;
  /** Tools that work at full fidelity with the current configuration. */
  tools: string[];
  /** Present when unavailable, or available but partial: what to set to widen it. */
  unlock_with?: string[];
  /** Present alongside `unlock_with`: what works in the meantime. */
  degraded_to?: string;
}

export function describeCapabilities(cfg: Config): Capability[] {
  return [
    {
      name: 'site_crawl_and_audit',
      available: true,
      provider: 'built-in crawler',
      tools: [
        'seo_crawl_site',
        'seo_audit_issues',
        'seo_page_inspect',
        'seo_internal_links',
        'seo_link_opportunities',
        'seo_crawl_diff',
        'seo_crawl_history',
      ],
    },
    {
      name: 'keyword_discovery',
      available: true,
      provider: 'google/bing/duckduckgo autocomplete',
      tools: ['seo_keyword_ideas', 'seo_cluster_keywords', 'seo_keyword_difficulty'],
    },
    {
      name: 'content_optimization',
      available: true,
      provider: 'built-in',
      tools: ['seo_content_score', 'seo_content_brief', 'seo_page_optimize'],
    },
    {
      name: 'programmatic_seo',
      available: true,
      provider: 'built-in',
      tools: ['pseo_discover_patterns', 'pseo_build_plan', 'pseo_check_index_risk'],
    },
    {
      name: 'keyword_metrics',
      available: cfg.keywordData.provider !== 'none',
      provider: cfg.keywordData.provider,
      tools: ['seo_keyword_metrics'],
      ...(cfg.keywordData.provider === 'none'
        ? {
            unlock_with: ['DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD'],
            degraded_to:
              'Keywords are returned without volume/CPC. Difficulty is estimated locally from SERP signals when a SERP provider is configured, otherwise from lexical features.',
          }
        : {}),
    },
    {
      name: 'live_serp',
      available: cfg.serp.provider !== 'none',
      provider: cfg.serp.provider,
      tools: ['seo_serp', 'seo_rank_check', 'seo_competitors_discover', 'seo_content_gap'],
      ...(cfg.serp.provider === 'none'
        ? {
            unlock_with: ['SERPER_API_KEY', 'SERPAPI_KEY', 'DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD'],
            degraded_to:
              'Ranking data falls back to Google Search Console when configured. Competitor analysis falls back to direct URL crawling.',
          }
        : {}),
    },
    {
      name: 'own_site_performance',
      available: Boolean(cfg.gsc),
      provider: cfg.gsc ? 'google-search-console' : 'none',
      tools: ['seo_gsc_sites', 'seo_gsc_performance', 'seo_gsc_opportunities'],
      ...(cfg.gsc
        ? {}
        : {
            unlock_with: [
              'GSC_SERVICE_ACCOUNT_JSON + GSC_SITE_URL',
              'GSC_CLIENT_ID + GSC_CLIENT_SECRET + GSC_REFRESH_TOKEN + GSC_SITE_URL',
            ],
            degraded_to:
              'Rankings come from live SERP checks instead, which cost provider credits and cover only tracked keywords.',
          }),
    },
    {
      name: 'backlinks',
      available: cfg.backlinks.provider !== 'none',
      provider: cfg.backlinks.provider,
      // Open PageRank exposes authority scores only, so listing the two
      // link-level tools here would violate this field's "full fidelity"
      // contract — an agent would call them and hit INVALID_INPUT instead.
      tools:
        cfg.backlinks.provider === 'openpagerank'
          ? ['seo_domain_authority']
          : ['seo_backlinks', 'seo_domain_authority', 'seo_link_gap'],
      ...(cfg.backlinks.provider === 'openpagerank'
        ? {
            unlock_with: ['DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD'],
            degraded_to:
              'Open PageRank returns authority scores only, so seo_backlinks and seo_link_gap are unavailable. ' +
              'Authority scores are enough to personalise seo_keyword_difficulty, which is what most callers need them for.',
          }
        : {}),
      ...(cfg.backlinks.provider === 'none'
        ? {
            unlock_with: ['DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD', 'OPENPAGERANK_API_KEY'],
            degraded_to:
              'No off-site link data is available without a provider — do not infer it. ' +
              'seo_internal_links and seo_link_opportunities need no credentials and work on the link equity you already control, ' +
              'which is usually the cheaper win anyway.',
          }
        : {}),
    },
    {
      name: 'page_speed',
      available: Boolean(cfg.pagespeedKey),
      provider: cfg.pagespeedKey ? 'pagespeed-insights' : 'none',
      tools: ['seo_page_speed'],
      ...(cfg.pagespeedKey
        ? {}
        : {
            unlock_with: ['PAGESPEED_API_KEY'],
            degraded_to:
              'The crawler still reports transfer size, request timing and render-blocking resource counts per page.',
          }),
    },
    {
      name: 'ai_visibility',
      available: Boolean(cfg.anthropicKey),
      provider: cfg.anthropicKey ? 'anthropic' : 'none',
      tools: ['seo_ai_visibility'],
      ...(cfg.anthropicKey
        ? {}
        : {
            unlock_with: ['ANTHROPIC_API_KEY'],
            degraded_to: 'No LLM-citation testing. Everything else is unaffected.',
          }),
    },
  ];
}
