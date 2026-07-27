import type { Keyword, Intent, Action } from '../core/types.js';
import { action } from '../core/envelope.js';
import { contentTokens, stem, round, clamp, findNearDuplicates, shortHash } from '../core/text.js';
import { slugify } from '../core/url.js';
import { pageCopy, headline } from '../core/copy.js';
import { classifyIntent } from '../keywords/intent.js';
import { recommendPageType } from '../keywords/cluster.js';
import { scoreOpportunity } from '../keywords/score.js';

/**
 * Programmatic SEO.
 *
 * The whole discipline is: find a query pattern that repeats across many
 * entities ("{tool} alternatives", "{city} plumbers", "{lang_a} to {lang_b}
 * converter"), then publish one genuinely useful page per entity.
 *
 * It is also the fastest way to get a site penalised, because the same mechanism
 * that produces 500 useful pages produces 500 doorway pages if the only thing
 * that varies is a noun. So this module deliberately does three things in
 * order — discover the pattern, plan the pages, then *refuse to bless the plan*
 * until it passes a thin-content and duplication check. `pseo_check_index_risk`
 * is not an optional extra; it's the part that keeps this from being a footgun
 * in an agent's hands.
 */

// ---------------------------------------------------------------------------
// Pattern discovery
// ---------------------------------------------------------------------------

export interface PseoPattern {
  /** Human/agent readable template, e.g. "best {x} software". */
  template: string;
  /** Fixed words in the template. */
  constant_tokens: string[];
  /** Distinct values observed in the variable slot. */
  entities: string[];
  /** How many keywords match this pattern. */
  match_count: number;
  total_volume: number;
  avg_volume: number | null;
  avg_difficulty: number | null;
  intent: Intent;
  page_type: string;
  /** 0-100 — is this worth building at scale? */
  viability: number;
  /** Where the variable sits, which affects how the URL should be structured. */
  slot_position: 'prefix' | 'suffix' | 'middle';
  example_keywords: string[];
}

export interface DiscoverOptions {
  /** A pattern needs at least this many matching keywords to be worth templating. */
  minMatches?: number;
  maxPatterns?: number;
  /** Ignore patterns whose variable slot is a stopword-ish filler. */
  minEntityLength?: number;
}

/**
 * Find repeating templates in a keyword set.
 *
 * The approach: for every keyword, generate the candidate templates produced by
 * blanking out each token in turn, then count how many keywords collapse onto
 * the same template. Templates with many distinct entities are pSEO candidates.
 */
export function discoverPatterns(keywords: Keyword[], opts: DiscoverOptions = {}): PseoPattern[] {
  const minMatches = opts.minMatches ?? 4;
  const minEntityLength = opts.minEntityLength ?? 2;

  interface Bucket {
    template: string;
    constants: string[];
    slotIndex: number;
    slotCount: number;
    entities: Set<string>;
    keywords: Keyword[];
  }
  const buckets = new Map<string, Bucket>();

  for (const kw of keywords) {
    const tokens = kw.keyword.trim().toLowerCase().split(/\s+/);
    // A two-token keyword blanked to one token is too generic to template on.
    if (tokens.length < 2 || tokens.length > 8) continue;

    for (let i = 0; i < tokens.length; i++) {
      const entity = tokens[i] as string;
      if (entity.length < minEntityLength) continue;
      const templateTokens = [...tokens];
      templateTokens[i] = '{x}';
      const template = templateTokens.join(' ');
      // A template that is nothing but the placeholder carries no signal.
      if (templateTokens.filter((t) => t !== '{x}').length === 0) continue;

      const b = buckets.get(template) ?? {
        template,
        constants: templateTokens.filter((t) => t !== '{x}'),
        slotIndex: i,
        slotCount: tokens.length,
        entities: new Set<string>(),
        keywords: [],
      };
      b.entities.add(entity);
      b.keywords.push(kw);
      buckets.set(template, b);
    }
  }

  const patterns: PseoPattern[] = [];
  for (const b of buckets.values()) {
    // Distinct entities matter, not raw matches: "best {x} software" with one
    // entity repeated ten times is not a pattern.
    if (b.entities.size < minMatches) continue;

    const volumes = b.keywords.map((k) => k.volume).filter((v): v is number => v !== null);
    const difficulties = b.keywords.map((k) => k.difficulty).filter((v): v is number => v !== null);
    const totalVolume = volumes.reduce((a, c) => a + c, 0);
    const avgVolume = volumes.length > 0 ? Math.round(totalVolume / volumes.length) : null;
    const avgDifficulty = difficulties.length > 0 ? round(difficulties.reduce((a, c) => a + c, 0) / difficulties.length, 1) : null;

    const intentCounts = new Map<Intent, number>();
    for (const k of b.keywords) intentCounts.set(k.intent, (intentCounts.get(k.intent) ?? 0) + 1);
    const intent = [...intentCounts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'informational';

    const slotPosition: PseoPattern['slot_position'] =
      b.slotIndex === 0 ? 'prefix' : b.slotIndex === b.slotCount - 1 ? 'suffix' : 'middle';

    patterns.push({
      template: b.template,
      constant_tokens: b.constants,
      entities: [...b.entities].sort(),
      match_count: b.keywords.length,
      total_volume: totalVolume,
      avg_volume: avgVolume,
      avg_difficulty: avgDifficulty,
      intent,
      page_type: recommendPageType(b.template.replace('{x}', b.constants[0] ?? ''), intent, b.keywords),
      viability: patternViability(b.entities.size, avgVolume, avgDifficulty, intent, b.constants.length),
      slot_position: slotPosition,
      example_keywords: b.keywords.slice(0, 5).map((k) => k.keyword),
    });
  }

  patterns.sort((a, b) => b.viability - a.viability || b.total_volume - a.total_volume);
  return patterns.slice(0, opts.maxPatterns ?? 25);
}

/**
 * Is a pattern worth building at scale?
 *
 * Scale is the point (more entities = more pages), but a pattern with high
 * average difficulty is a lot of pages that never rank, and one with a
 * one-word constant ("{x} software") is too generic to differentiate.
 */
function patternViability(
  entityCount: number,
  avgVolume: number | null,
  avgDifficulty: number | null,
  intent: Intent,
  constantCount: number,
): number {
  // Log scale: 50 entities is much better than 5, but 500 isn't 10× better than 50.
  let score = clamp(Math.log10(entityCount) * 26, 0, 40);
  if (avgVolume !== null) score += clamp(Math.log10(avgVolume + 1) * 9, 0, 25);
  else score += 12;
  if (avgDifficulty !== null) score += clamp(22 * (1 - avgDifficulty / 100), 0, 22);
  else score += 11;
  if (intent === 'commercial' || intent === 'transactional') score += 8;
  // A richer constant phrase means a more specific, more defensible page.
  score += clamp((constantCount - 1) * 4, 0, 10);
  return round(clamp(score, 0, 100), 1);
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

export interface PseoPageSpec {
  /** Stable id so an agent can track this page across planning runs. */
  id: string;
  entity: string;
  primary_keyword: string;
  secondary_keywords: string[];
  slug: string;
  url_path: string;
  title: string;
  h1: string;
  meta_description: string;
  intent: Intent;
  page_type: string;
  target_word_count: number;
  volume: number | null;
  difficulty: number | null;
  opportunity: number;
  /**
   * Sections the page must contain. The `unique` flag marks the ones that have
   * to differ per entity — the difference between a useful page and a doorway.
   */
  required_sections: Array<{ heading: string; unique: boolean; note: string }>;
  /** Other pages in this plan to link to, for a connected cluster. */
  internal_links: string[];
  schema_type: string;
  /** Data fields the template needs populated for this entity. */
  data_requirements: string[];
}

export interface PseoPlan {
  pattern: string;
  base_path: string;
  total_pages: number;
  estimated_total_volume: number;
  pages: PseoPageSpec[];
  /** Content that must genuinely differ per page for this to be indexable. */
  uniqueness_requirements: string[];
  /** Fields the agent must source before generating anything. */
  data_model: string[];
  warnings: string[];
  hub_page: { slug: string; title: string; h1: string; links_to: number };
}

export interface BuildPlanOptions {
  basePath?: string;
  /**
   * Content language. Titles, meta descriptions and section headings are page
   * copy, so English scaffolding on a Spanish set is simply wrong output: the
   * plan was handing back "Compare options for software de facturacion para
   * autonomos" and headings like "Frequently asked questions". The agent-facing
   * `note` fields stay English — those are instructions, not page content.
   */
  language?: string;
  /** Cap the number of pages planned. */
  limit?: number;
  targetWordCount?: number;
  brandTerms?: string[];
  /** Keywords already covered — skip entities that would cannibalise them. */
  existingUrls?: string[];
}

export function buildPseoPlan(
  pattern: PseoPattern,
  keywords: Keyword[],
  opts: BuildPlanOptions = {},
): PseoPlan {
  const spanish = (opts.language ?? '').toLowerCase().startsWith('es');
  // Casing goes through the shared helper so this file never decides between
  // Title Case and sentence case itself.
  const asHeadline = (text: string) => headline(text, opts.language, titleCase);
  const basePath = normalizeBasePath(opts.basePath ?? inferBasePath(pattern));
  const limit = opts.limit ?? 200;
  const targetWords = opts.targetWordCount ?? defaultWordCount(pattern.intent, pattern.page_type);
  const warnings: string[] = [];

  // Group the keyword set by entity so each page gets its full keyword cluster.
  const byEntity = new Map<string, Keyword[]>();
  for (const kw of keywords) {
    const entity = matchEntity(kw.keyword, pattern.template);
    if (!entity) continue;
    const list = byEntity.get(entity);
    if (list) list.push(kw);
    else byEntity.set(entity, [kw]);
  }

  const existing = new Set((opts.existingUrls ?? []).map((u) => u.toLowerCase()));
  const pages: PseoPageSpec[] = [];

  const entities = [...byEntity.entries()].sort((a, b) => {
    const va = a[1].reduce((s, k) => s + (k.volume ?? 0), 0);
    const vb = b[1].reduce((s, k) => s + (k.volume ?? 0), 0);
    return vb - va;
  });

  for (const [entity, entityKeywords] of entities.slice(0, limit)) {
    const primary =
      entityKeywords.slice().sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0] ?? entityKeywords[0];
    if (!primary) continue;

    const slug = slugify(pattern.template.replace('{x}', entity));
    const urlPath = `${basePath}/${slug}`;
    if (existing.has(urlPath.toLowerCase())) continue;

    const volumes = entityKeywords.map((k) => k.volume).filter((v): v is number => v !== null);
    const totalVolume = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) : null;
    const difficulty = primary.difficulty;
    const intent = classifyIntent(primary.keyword, opts.brandTerms ?? []).intent;

    const opportunity = scoreOpportunity({
      keyword: primary.keyword,
      volume: primary.volume,
      difficulty,
      cpc: primary.cpc,
      intent,
      words: primary.words,
    }).opportunity;

    pages.push({
      id: `pseo-${shortHash(urlPath)}`,
      entity,
      primary_keyword: primary.keyword,
      secondary_keywords: entityKeywords
        .filter((k) => k.keyword !== primary.keyword)
        .slice(0, 12)
        .map((k) => k.keyword),
      slug,
      url_path: urlPath,
      title: buildPseoTitle(pattern, entity, spanish),
      h1: asHeadline(pattern.template.replace('{x}', entity)),
      meta_description: buildPseoMeta(pattern, entity, intent, spanish),
      intent,
      page_type: pattern.page_type,
      target_word_count: targetWords,
      volume: totalVolume,
      difficulty,
      opportunity,
      required_sections: requiredSections(pattern, entity, spanish),
      internal_links: [],
      schema_type: schemaFor(pattern.page_type, intent),
      data_requirements: dataRequirements(pattern, entity),
    });
  }

  // Wire up a sibling link mesh: each page links to the next few, so the cluster
  // is internally connected rather than 200 isolated leaves hanging off a hub.
  for (let i = 0; i < pages.length; i++) {
    const links: string[] = [];
    for (let k = 1; k <= 4 && pages.length > 1; k++) {
      const target = pages[(i + k) % pages.length];
      if (target && target.url_path !== pages[i]?.url_path) links.push(target.url_path);
    }
    (pages[i] as PseoPageSpec).internal_links = links;
  }

  if (byEntity.size > limit) {
    warnings.push(
      `${byEntity.size} entities matched but the plan was capped at ${limit}. ` +
        'Publishing in batches is safer anyway — ship the highest-volume entities first and confirm they index before scaling.',
    );
  }
  if (pattern.avg_volume === null) {
    warnings.push(
      'No search-volume data available, so entity ordering is by keyword count rather than demand. ' +
        'Configure a keyword metrics provider before committing to a large build.',
    );
  }
  if (pages.length > 50 && targetWords < 500) {
    warnings.push(
      `Planning ${pages.length} pages at ${targetWords} words each. At this scale, thin pages are the main risk — ` +
        'run pseo_check_index_risk on generated drafts before publishing.',
    );
  }

  return {
    pattern: pattern.template,
    base_path: basePath,
    total_pages: pages.length,
    estimated_total_volume: pages.reduce((s, p) => s + (p.volume ?? 0), 0),
    pages,
    uniqueness_requirements: uniquenessRequirements(pattern),
    data_model: [...new Set(pages.flatMap((p) => p.data_requirements))],
    warnings,
    hub_page: {
      slug: basePath.replace(/^\//, ''),
      title: asHeadline(pattern.constant_tokens.join(' ')),
      h1: asHeadline(pattern.constant_tokens.join(' ')),
      links_to: pages.length,
    },
  };
}

/** Extract the entity from a keyword given a template, or null if it doesn't match. */
export function matchEntity(keyword: string, template: string): string | null {
  const kwTokens = keyword.trim().toLowerCase().split(/\s+/);
  const tplTokens = template.trim().toLowerCase().split(/\s+/);
  if (kwTokens.length !== tplTokens.length) return null;
  let entity: string | null = null;
  for (let i = 0; i < tplTokens.length; i++) {
    if (tplTokens[i] === '{x}') {
      entity = kwTokens[i] as string;
      continue;
    }
    if (tplTokens[i] !== kwTokens[i]) return null;
  }
  return entity;
}

function inferBasePath(pattern: PseoPattern): string {
  // Build the directory from the constant part so URLs read naturally:
  // "best {x} software" -> /best-software/{entity}.
  const constants = pattern.constant_tokens.join(' ');
  return `/${slugify(constants) || 'pages'}`;
}

function normalizeBasePath(p: string): string {
  const cleaned = `/${p.replace(/^\/+|\/+$/g, '')}`;
  return cleaned === '/' ? '/pages' : cleaned;
}

function defaultWordCount(intent: Intent, pageType: string): number {
  if (pageType === 'comparison') return 1400;
  if (pageType === 'tool' || pageType === 'glossary') return 600;
  if (intent === 'transactional') return 700;
  if (intent === 'informational') return 1200;
  return 900;
}

function buildPseoTitle(pattern: PseoPattern, entity: string, spanish = false): string {
  const base = headline(pattern.template.replace('{x}', entity), spanish ? 'es' : 'en', titleCase);
  const year = new Date().getFullYear();
  const withYear = `${base} (${year})`;
  // Only add a year where recency is genuinely a ranking signal.
  const wantsYear = pattern.intent === 'commercial' && withYear.length <= 60;
  const out = wantsYear ? withYear : base;
  return out.length <= 60 ? out : `${base.slice(0, 57)}...`;
}

function buildPseoMeta(pattern: PseoPattern, entity: string, intent: Intent, spanish = false): string {
  const phrase = pattern.template.replace('{x}', entity);
  const copy = pageCopy(spanish ? 'es' : 'en').meta;
  const text =
    intent === 'commercial'
      ? copy.commercial(phrase)
      : intent === 'transactional'
        ? copy.transactional(phrase)
        : copy.informational(phrase);
  return text.length > 158 ? `${text.slice(0, 155)}...` : text;
}

/**
 * Sections for a templated page.
 *
 * The `unique: true` flags carry the real weight — they are the contract that
 * stops this being a doorway-page generator. If an agent can't fill those with
 * entity-specific substance, the page shouldn't be built.
 */
function requiredSections(pattern: PseoPattern, entity: string, spanish = false): PseoPageSpec['required_sections'] {
  // Headings are framed so they read correctly whatever the entity turns out to
  // be. Two earlier attempts guessed at the entity's part of speech and both
  // leaked: keying off `slot_position` produced "What is Accountants?" for
  // "time tracking software for {x}", and adding a qualifier blocklist still let
  // through "What is Cheap?" and then "What is Buy?" for "{x} crm software".
  // The set of entities that cannot head a sentence is open-ended — verbs,
  // adjectives, audiences, years, prepositional objects — so the frame no longer
  // depends on knowing. "<phrase>: overview" is grammatical for every one of
  // them, and reads better as an SEO heading than "What is ...?" anyway.
  const subject = capitalizeFirst(pattern.template.replace('{x}', entity));
  const t = pageCopy(spanish ? 'es' : 'en').sections;
  const common: PseoPageSpec['required_sections'] = [
    {
      heading: `${subject}: ${t.overview}`,
      unique: true,
      note: 'Entity-specific opening. Must not be a find-and-replace of the other pages in this set.',
    },
  ];

  switch (pattern.page_type) {
    case 'comparison':
      return [
        ...common,
        { heading: `${subject}${t.at_a_glance}`, unique: true, note: 'Comparison table with real, entity-specific figures.' },
        { heading: t.pricing, unique: true, note: 'Actual prices for this entity. Never a shared placeholder.' },
        { heading: t.pros_cons, unique: true, note: 'Genuine trade-offs specific to this entity.' },
        { heading: t.alternatives, unique: true, note: 'Link to sibling pages in this cluster.' },
        { heading: t.who_for, unique: true, note: 'The recommendation. This is what commercial intent wants.' },
      ];
    case 'tool':
      return [
        // Not "<phrase> tool": the phrase often already ends in "tool", which
        // gave "Invoice generator cost tool".
        { heading: `${subject}: ${t.the_tool}`, unique: true, note: 'The working tool itself. A pSEO tool page without a tool is a doorway page.' },
        { heading: t.how_to_use, unique: false, note: 'Shared instructions are acceptable here.' },
        { heading: `${subject}: ${t.worked_examples}`, unique: true, note: 'Worked examples specific to this entity.' },
      ];
    case 'glossary':
      return [
        ...common,
        { heading: t.definition, unique: true, note: 'A precise definition, not a paraphrase of the heading.' },
        { heading: t.example, unique: true, note: 'A concrete worked example.' },
        { heading: t.related_terms, unique: true, note: 'Links to sibling glossary pages.' },
      ];
    default:
      return [
        ...common,
        { heading: `${subject}: ${t.how_it_works}`, unique: true, note: 'Substantive, entity-specific explanation.' },
        { heading: t.key_considerations, unique: true, note: 'Specific to this entity, not generic advice.' },
        { heading: t.faq, unique: true, note: 'Sourced from real queries about this entity.' },
      ];
  }
}

function uniquenessRequirements(pattern: PseoPattern): string[] {
  return [
    'Every page needs at least 60% unique body content. Swapping one noun across a shared template is a doorway-page pattern and gets the whole directory deindexed.',
    'Titles, H1s and meta descriptions must all be distinct — not just by the entity name, but in structure where possible.',
    `Source real per-entity data for: ${dataRequirements(pattern, '{entity}').join(', ')}. A template with no real data behind it has nothing unique to say.`,
    'Build the hub page first and link every child from it, so the cluster is crawlable from day one.',
    'Publish in batches of 20-50 and confirm indexation before scaling. Dumping 500 pages at once is the classic trigger for a manual review.',
    'Any entity you cannot write something genuinely specific about should be dropped from the plan, not padded.',
  ];
}

function dataRequirements(pattern: PseoPattern, entity: string): string[] {
  const base = ['entity_name', 'entity_description'];
  switch (pattern.page_type) {
    case 'comparison':
      return [...base, 'pricing_tiers', 'feature_matrix', 'pros', 'cons', 'rating', 'alternatives'];
    case 'product':
      return [...base, 'price', 'availability', 'specifications', 'images'];
    case 'tool':
      return [...base, 'input_schema', 'output_schema', 'worked_examples'];
    case 'glossary':
      return [...base, 'definition', 'example', 'related_terms'];
    default:
      void entity;
      return [...base, 'key_facts', 'faqs', 'use_cases'];
  }
}

function schemaFor(pageType: string, intent: Intent): string {
  switch (pageType) {
    case 'comparison':
      return 'ItemList';
    case 'product':
      return 'Product';
    case 'tool':
      return 'SoftwareApplication';
    case 'glossary':
      return 'DefinedTerm';
    case 'guide':
      return 'HowTo';
    default:
      return intent === 'informational' ? 'Article' : 'WebPage';
  }
}

/**
 * Acronyms that must not be title-cased into "Crm" or "Seo".
 * Keyword input is lowercase, so there is no casing signal to preserve —
 * without this list generated titles read as amateurish to anyone in the industry.
 */
const ACRONYMS = new Set([
  'seo', 'sem', 'crm', 'erp', 'cms', 'saas', 'paas', 'iaas', 'api', 'sdk', 'ui', 'ux',
  'ai', 'ml', 'llm', 'gpt', 'nlp', 'roi', 'kpi', 'b2b', 'b2c', 'd2c', 'smb', 'sla',
  'ppc', 'cpc', 'cpm', 'ctr', 'cro', 'serp', 'url', 'html', 'css', 'js', 'json', 'xml',
  'pdf', 'csv', 'sql', 'aws', 'gcp', 'vpn', 'dns', 'ssl', 'http', 'https', 'ftp',
  'hr', 'it', 'pr', 'qa', 'rd', 'ceo', 'cto', 'cfo', 'cmo', 'usa', 'uk', 'eu', 'us',
  'pos', 'atm', 'gps', 'iot', 'ar', 'vr', 'nft', 'ico', 'cbd', 'suv', 'tv', 'pc',
]);

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function titleCase(s: string): string {
  const minor = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'for', 'of', 'in', 'on', 'at', 'to', 'vs', 'with', 'is']);
  return s
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (i > 0 && minor.has(lower)) return lower;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Index risk validation — the safety gate
// ---------------------------------------------------------------------------

export interface IndexRiskInput {
  /** Generated drafts, keyed by URL or slug. */
  pages: Array<{ url: string; title: string; body: string; meta_description?: string }>;
  minWords?: number;
  /** Similarity above which two pages count as duplicates. */
  maxSimilarity?: number;
}

export interface IndexRiskReport {
  verdict: 'safe' | 'risky' | 'do_not_publish';
  pages_checked: number;
  /** 0-100. Higher is worse. */
  risk_score: number;
  thin_pages: Array<{ url: string; word_count: number }>;
  duplicate_clusters: Array<{ urls: string[]; similarity: number }>;
  duplicate_titles: Array<{ title: string; urls: string[] }>;
  duplicate_metas: Array<{ meta: string; urls: string[] }>;
  /** The fraction of each page that is boilerplate shared with its siblings. */
  avg_uniqueness: number;
  findings: string[];
  recommendation: string;
}

/**
 * Pre-publication gate for a programmatic set.
 *
 * Run this on generated drafts *before* they go live. Catching 200
 * near-duplicate pages here costs nothing; catching them after Google has
 * classified the directory as doorway pages costs months.
 */
export function checkIndexRisk(input: IndexRiskInput): IndexRiskReport {
  const minWords = input.minWords ?? 300;
  // 0.75, not the 0.85 the site audit uses for editorial content.
  // Templated pages have small shared vocabularies, so swapping one noun moves
  // similarity less than it would in prose: two pages that differ only by the
  // entity name measure ~0.78 when the template is short. For an editorial page
  // that would be a false positive; for a programmatic set it is exactly the
  // doorway pattern this gate exists to catch. Genuinely differentiated pages in
  // the same set measure below 0.1, so the margin is wide.
  const maxSimilarity = input.maxSimilarity ?? 0.75;
  const pages = input.pages;
  const findings: string[] = [];

  if (pages.length === 0) {
    return {
      verdict: 'safe',
      pages_checked: 0,
      risk_score: 0,
      thin_pages: [],
      duplicate_clusters: [],
      duplicate_titles: [],
      duplicate_metas: [],
      avg_uniqueness: 100,
      findings: ['No pages supplied to check.'],
      recommendation: 'Supply the generated drafts to validate them before publishing.',
    };
  }

  const wordCounts = pages.map((p) => ({ url: p.url, word_count: contentTokens(p.body).length }));
  const thin = wordCounts.filter((p) => p.word_count < minWords);

  // Shared near-duplicate detection. The length floor is lowered here because a
  // 150-word templated page is precisely what this gate exists to catch, and the
  // default floor is tuned for editorial content.
  const clusters = findNearDuplicates(
    pages.map((p) => p.body),
    { threshold: maxSimilarity, minTokens: 40 },
  ).map((c) => ({
    urls: c.members.map((i) => (pages[i] as (typeof pages)[number]).url),
    similarity: c.similarity,
  }));

  const dupTitles = groupBy(pages, (p) => p.title.trim().toLowerCase())
    .filter((g) => g.items.length > 1)
    .map((g) => ({ title: g.key, urls: g.items.map((p) => p.url) }));

  const dupMetas = groupBy(
    pages.filter((p) => p.meta_description),
    (p) => (p.meta_description as string).trim().toLowerCase(),
  )
    .filter((g) => g.items.length > 1)
    .map((g) => ({ meta: g.key, urls: g.items.map((p) => p.url) }));

  // Uniqueness = share of each page's vocabulary not present in every sibling.
  const uniqueness = computeUniqueness(pages.map((p) => p.body));

  let risk = 0;
  const thinRatio = thin.length / pages.length;
  const dupRatio = clusters.reduce((s, c) => s + c.urls.length, 0) / pages.length;

  risk += thinRatio * 45;
  risk += dupRatio * 50;
  risk += (dupTitles.length / pages.length) * 25;
  risk += clamp((80 - uniqueness) * 0.9, 0, 35);
  if (pages.length > 200 && (thinRatio > 0.2 || dupRatio > 0.2)) {
    // Scale multiplies the damage: the same defect rate is far more dangerous
    // across 500 pages than across 20.
    risk += 12;
  }
  risk = round(clamp(risk, 0, 100), 1);

  if (thin.length > 0) {
    findings.push(
      `${thin.length} of ${pages.length} pages are under ${minWords} words (thinnest: ${Math.min(...thin.map((t) => t.word_count))}).`,
    );
  }
  if (clusters.length > 0) {
    const affected = clusters.reduce((s, c) => s + c.urls.length, 0);
    findings.push(
      `${affected} pages fall into ${clusters.length} near-duplicate cluster(s). Google will index one page per cluster at best.`,
    );
  }
  if (dupTitles.length > 0) findings.push(`${dupTitles.length} title(s) are used on more than one page.`);
  if (dupMetas.length > 0) findings.push(`${dupMetas.length} meta description(s) are duplicated.`);
  findings.push(`Average content uniqueness across the set is ${uniqueness}%.`);
  if (findings.length === 1) findings.push('No thin or duplicate content detected.');

  const verdict: IndexRiskReport['verdict'] = risk >= 55 ? 'do_not_publish' : risk >= 28 ? 'risky' : 'safe';

  return {
    verdict,
    pages_checked: pages.length,
    risk_score: risk,
    thin_pages: thin.slice(0, 50),
    duplicate_clusters: clusters.slice(0, 30),
    duplicate_titles: dupTitles.slice(0, 30),
    duplicate_metas: dupMetas.slice(0, 30),
    avg_uniqueness: uniqueness,
    findings,
    recommendation: recommendationFor(verdict, thin.length, clusters.length, uniqueness),
  };
}

function recommendationFor(
  verdict: IndexRiskReport['verdict'],
  thinCount: number,
  clusterCount: number,
  uniqueness: number,
): string {
  if (verdict === 'do_not_publish') {
    return (
      'Do not publish this set as-is. Publishing it risks the entire directory being classified as doorway pages, ' +
      'which affects far more than these URLs. ' +
      (clusterCount > 0
        ? 'Add genuinely entity-specific data to each page — real prices, real specifications, real examples — rather than rephrasing a shared template. '
        : '') +
      (thinCount > 0 ? 'Drop the entities you cannot write substantively about instead of padding them. ' : '') +
      'Re-run this check once the drafts are revised.'
    );
  }
  if (verdict === 'risky') {
    return (
      'Publishable with revision. Fix the flagged pages first, then ship in batches of 20-50 and confirm each batch ' +
      `indexes before continuing. Current uniqueness of ${uniqueness}% should be above 70% for a set this size.`
    );
  }
  return (
    'Safe to publish. Still ship in batches and monitor indexation — run seo_crawl_site after the first batch, ' +
    'and seo_gsc_performance a couple of weeks later to confirm the pages are actually earning impressions.'
  );
}

/**
 * Average share of each document's vocabulary that isn't shared by the whole set.
 *
 * Terms present in nearly every page are template boilerplate; a set where those
 * dominate is a set of doorway pages regardless of how long each page is.
 */
function computeUniqueness(bodies: string[]): number {
  if (bodies.length < 2) return 100;
  const tokenSets = bodies.map((b) => new Set(contentTokens(b).map(stem)));
  const docFreq = new Map<string, number>();
  for (const set of tokenSets) {
    for (const t of set) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const n = bodies.length;
  let total = 0;
  for (const set of tokenSets) {
    if (set.size === 0) continue;
    let distinctive = 0;
    for (const t of set) {
      // A term in under 80% of pages is doing entity-specific work.
      if ((docFreq.get(t) ?? 0) < n * 0.8) distinctive++;
    }
    total += distinctive / set.size;
  }
  return round((total / n) * 100, 1);
}

function groupBy<T>(items: T[], key: (item: T) => string): Array<{ key: string; items: T[] }> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  }
  return [...m].map(([k, v]) => ({ key: k, items: v }));
}

export function pseoToActions(patterns: PseoPattern[]): Action[] {
  return patterns.slice(0, 8).map((p) =>
    action({
      id: `pseo.pattern.${slugify(p.template)}`,
      priority: p.viability >= 70 ? 'high' : p.viability >= 50 ? 'medium' : 'low',
      effort: 'large',
      category: 'programmatic-seo',
      title: `Build a programmatic set for "${p.template}" — ${p.entities.length} entities`,
      detail:
        `${p.match_count} keywords match this template across ${p.entities.length} distinct entities` +
        (p.total_volume > 0 ? `, totalling ${p.total_volume} searches/mo` : '') +
        `. Intent is ${p.intent}, so build these as ${p.page_type} pages. ` +
        'Call pseo_build_plan for the page specs, then pseo_check_index_risk on the drafts before publishing.',
      impact_score: p.viability,
      evidence: {
        template: p.template,
        entities: p.entities.slice(0, 20),
        total_volume: p.total_volume,
        avg_difficulty: p.avg_difficulty,
        examples: p.example_keywords,
      },
      fix: { type: 'build_pseo_set', template: p.template, entity_count: p.entities.length },
    }),
  );
}
