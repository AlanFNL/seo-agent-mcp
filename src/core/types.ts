/**
 * Shared vocabulary for the whole toolkit.
 *
 * Design note: every type here is shaped for a *machine* reader. That means
 * flat, enumerable fields with stable keys — no prose blobs an agent has to
 * re-parse, and no nested UI-ish structures that only make sense on a screen.
 */

export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type Effort = 'trivial' | 'small' | 'medium' | 'large';
export type Severity = 'error' | 'warning' | 'notice';

/** Search intent, using the taxonomy both Ahrefs and Semrush converged on. */
export type Intent = 'informational' | 'commercial' | 'transactional' | 'navigational';

/**
 * The single most important type in this codebase.
 *
 * Human SEO tools return tables and let a person decide what to do. An agent
 * needs the decision itself: what to change, where, how much it is worth, and
 * — when possible — a machine-applicable patch. Every analysis tool emits these.
 */
export interface Action {
  /** Stable across runs for the same underlying problem, so agents can dedupe and track fixes. */
  id: string;
  priority: Priority;
  effort: Effort;
  /** e.g. "technical", "on-page", "content", "keywords", "internal-links", "backlinks". */
  category: string;
  /** Imperative, one line. "Add a meta description to /pricing". */
  title: string;
  /** Why this matters and what "done" looks like. */
  detail: string;
  /** URL, keyword, or other subject this action operates on. */
  target?: string;
  /**
   * 0-100. Blends estimated traffic upside with confidence and inverse effort.
   * Sort by this to get a ready-to-execute backlog.
   */
  impact_score: number;
  /** The raw numbers behind the recommendation, so the agent can show its work. */
  evidence?: Record<string, unknown>;
  /** A structured, directly-applicable change when one exists. */
  fix?: ActionFix;
}

export interface ActionFix {
  /** e.g. "set_meta_description", "add_internal_link", "rewrite_title", "create_page". */
  type: string;
  /** Current value, when replacing something. */
  from?: string;
  /** Proposed value. */
  to?: string;
  [key: string]: unknown;
}

/** Standard response wrapper for every MCP tool. */
export interface Envelope<T> {
  ok: boolean;
  tool: string;
  /** One line an agent can read without parsing `data`. Always populated. */
  summary: string;
  data: T;
  /** Ranked, deduped, ready to execute. Present on any tool that finds problems. */
  actions?: Action[];
  meta: EnvelopeMeta;
  warnings?: string[];
}

export interface EnvelopeMeta {
  cached: boolean;
  took_ms: number;
  /** Which data source answered: "crawler", "google-suggest", "serper", "gsc", ... */
  source?: string;
  /** Provider credits/API calls consumed by this invocation. */
  cost?: number;
  /** True when `data` was cut down to fit a token budget. */
  truncated?: boolean;
  total_available?: number;
  returned?: number;
  /** Path to the full, untruncated result set on disk when `truncated` is true. */
  artifact?: string;
  /** Concrete follow-up tool calls worth making. Keeps agents from guessing. */
  next?: string[];
}

// ---------------------------------------------------------------------------
// Crawl / page model
// ---------------------------------------------------------------------------

export interface PageLink {
  url: string;
  anchor: string;
  rel: string | null;
  /** True when the link target is on the same registrable domain. */
  internal: boolean;
  nofollow: boolean;
}

export interface ImageRef {
  src: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  loading: string | null;
}

export interface Heading {
  level: number;
  text: string;
}

/** Everything we extract from one fetched HTML document. */
export interface PageData {
  url: string;
  /** URL after following redirects. */
  final_url: string;
  status: number;
  redirect_chain: string[];
  content_type: string | null;
  /** Bytes of the raw response body. */
  bytes: number;
  /** Milliseconds to first byte + full body. */
  fetch_ms: number;
  title: string | null;
  meta_description: string | null;
  meta_robots: string | null;
  canonical: string | null;
  lang: string | null;
  headings: Heading[];
  h1: string[];
  /** Visible body text with boilerplate (nav/footer/script) stripped. */
  text: string;
  word_count: number;
  links: PageLink[];
  images: ImageRef[];
  /** Parsed JSON-LD blocks. */
  jsonld: unknown[];
  /** Open Graph and Twitter card tags, keyed by property. */
  social: Record<string, string>;
  hreflang: Array<{ lang: string; href: string }>;
  /** Depth from the crawl seed. 0 for the seed itself. */
  depth: number;
  /** Set when the fetch failed outright. */
  error?: string;
}

export interface CrawlSummary {
  crawl_id: number;
  site: string;
  started_at: string;
  finished_at: string;
  pages_crawled: number;
  pages_ok: number;
  pages_error: number;
  /** 0-100, mirrors the "health score" concept from Site Audit. */
  health_score: number;
  issues_by_severity: Record<Severity, number>;
}

export interface Issue {
  /** Rule identifier, e.g. "title.missing". Stable. */
  rule: string;
  severity: Severity;
  url: string;
  message: string;
  evidence?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

export interface Keyword {
  keyword: string;
  /** Monthly search volume. null when no volume provider is configured. */
  volume: number | null;
  /** 0-100 ranking difficulty. Estimated locally when no provider supplies it. */
  difficulty: number | null;
  /** Cost per click in USD. */
  cpc: number | null;
  intent: Intent;
  /** How this keyword was found: "seed", "suggest:google", "serp:paa", "gsc", ... */
  source: string;
  /** Number of words. Cheap proxy for specificity. */
  words: number;
  /** 0-100 blend of volume, difficulty, intent value and site fit. */
  opportunity: number | null;
  /** Cluster this keyword was assigned to, if clustering has run. */
  cluster?: string;
  /** Our current ranking position, when known. */
  position?: number | null;
}

export interface KeywordCluster {
  /** The highest-value keyword in the cluster; acts as the page target. */
  head: string;
  keywords: string[];
  total_volume: number;
  avg_difficulty: number | null;
  intent: Intent;
  /** Recommended page type for this cluster. */
  page_type: 'blog-post' | 'landing-page' | 'comparison' | 'guide' | 'glossary' | 'tool' | 'product';
}

// ---------------------------------------------------------------------------
// SERP
// ---------------------------------------------------------------------------

export interface SerpResult {
  position: number;
  url: string;
  title: string;
  snippet: string;
  domain: string;
}

export interface SerpData {
  keyword: string;
  location: string;
  device: 'desktop' | 'mobile';
  results: SerpResult[];
  /** "featured_snippet", "people_also_ask", "ai_overview", "video", ... */
  features: string[];
  people_also_ask: string[];
  related_searches: string[];
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export interface RankRow {
  keyword: string;
  position: number | null;
  url: string | null;
  /** Positive means improved (moved toward #1). */
  change: number | null;
  clicks?: number;
  impressions?: number;
  ctr?: number;
  checked_at: string;
}
