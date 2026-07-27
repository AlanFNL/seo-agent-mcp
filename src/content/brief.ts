import type { SerpData, PageData, Intent } from '../core/types.js';
import { fetchPage } from '../crawl/crawler.js';
import { mapLimit } from '../core/http.js';
import { competitiveTerms } from './optimize.js';
import { classifyIntent, isQuestion } from '../keywords/intent.js';
import { round, truncate, contentTokens, stem } from '../core/text.js';
import { domainOf, slugify } from '../core/url.js';
import { pageCopy, headline } from '../core/copy.js';

/**
 * Content brief generation.
 *
 * A brief is what an agent needs *before* it writes: not "write about CRMs" but
 * "the ten pages ranking for this all cover these nine subtopics, average 2,100
 * words, six of them answer these specific questions, and the outline that beats
 * them looks like this".
 *
 * Crucially this is grounded in pages we actually fetched and parsed. An LLM can
 * invent a plausible content brief from its training data; it cannot know that
 * every current top-10 result has a comparison table and yours doesn't. That
 * difference is the entire value.
 */

export interface CompetitorPage {
  url: string;
  domain: string;
  position: number;
  title: string | null;
  word_count: number;
  headings: Array<{ level: number; text: string }>;
  /** H2/H3 text only — the section structure worth copying. */
  sections: string[];
  images: number;
  internal_links: number;
  external_links: number;
  has_lists: boolean;
  has_tables: boolean;
  schema_types: string[];
  fetch_error?: string;
}

export interface ContentBrief {
  keyword: string;
  intent: Intent;
  /** Recommended target, set slightly above the competitor median. */
  target_word_count: number;
  competitor_word_counts: { min: number; median: number; max: number; mean: number };
  /** Terms most competitors use. Feed straight into `required_terms` when scoring. */
  required_terms: Array<{ term: string; document_frequency: number; avg_count: number }>;
  /** Section headings common across competitors, ranked by how many use them. */
  common_sections: Array<{ heading: string; used_by: number; examples: string[] }>;
  /** Questions to answer, from People Also Ask plus competitor question headings. */
  questions: string[];
  /** A concrete H1/H2 outline to write against. */
  suggested_outline: Array<{ level: number; heading: string; rationale: string }>;
  suggested_title: string;
  suggested_slug: string;
  suggested_meta_description: string;
  competitors: CompetitorPage[];
  serp_features: string[];
  /** Format signals worth matching. */
  format_signals: {
    pct_with_lists: number;
    pct_with_tables: number;
    median_images: number;
    median_sections: number;
    common_schema: string[];
  };
  notes: string[];
}

/** Headings that are navigation furniture rather than topical sections. */
const BOILERPLATE_HEADINGS = new Set([
  'related posts', 'related articles', 'you might also like', 'recent posts', 'categories',
  'tags', 'share this', 'leave a comment', 'comments', 'about the author', 'author',
  'newsletter', 'subscribe', 'follow us', 'table of contents', 'contents', 'menu',
  'navigation', 'search', 'footer', 'sidebar', 'popular posts', 'archives',
  'get started', 'sign up', 'contact us', 'privacy policy', 'terms of service',
]);

export interface BriefOptions {
  /** Content language, so the suggested title, meta and outline are page copy in the right language. */
  language?: string;
  /** How many top results to fetch and analyse. */
  topN?: number;
  concurrency?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Extra questions from a keyword expansion pass. */
  extraQuestions?: string[];
  brandTerms?: string[];
}

export async function buildContentBrief(
  serp: SerpData,
  opts: BriefOptions = {},
): Promise<ContentBrief> {
  const topN = opts.topN ?? 10;
  const targets = serp.results.slice(0, topN);
  const notes: string[] = [];

  const fetched = await mapLimit(targets, opts.concurrency ?? 4, async (r) => {
    const { page } = await fetchPage(r.url, {
      timeoutMs: opts.timeoutMs ?? 20_000,
      userAgent: opts.userAgent ?? 'Mozilla/5.0 (compatible; seo-agent/0.1) AgentSEOBot',
    });
    return { result: r, page };
  });

  const competitors: CompetitorPage[] = [];
  const texts: string[] = [];

  fetched.forEach((f, i) => {
    const r = targets[i];
    if (!r) return;
    if (!f.ok) {
      competitors.push({
        url: r.url,
        domain: r.domain,
        position: r.position,
        title: r.title,
        word_count: 0,
        headings: [],
        sections: [],
        images: 0,
        internal_links: 0,
        external_links: 0,
        has_lists: false,
        has_tables: false,
        schema_types: [],
        fetch_error: f.error.message,
      });
      return;
    }
    const p: PageData = f.value.page;
    // Sites that block bots return a 200 shell; including those in the median
    // would drag the word-count benchmark way down.
    if (p.word_count < 100) {
      competitors.push({
        url: r.url,
        domain: r.domain,
        position: r.position,
        title: p.title,
        word_count: p.word_count,
        headings: p.headings,
        sections: [],
        images: p.images.length,
        internal_links: p.links.filter((l) => l.internal).length,
        external_links: p.links.filter((l) => !l.internal).length,
        has_lists: false,
        has_tables: false,
        schema_types: schemaTypes(p),
        fetch_error: 'page returned little or no extractable text (likely bot-blocked or JS-rendered)',
      });
      return;
    }

    texts.push(p.text);
    competitors.push({
      url: r.url,
      domain: r.domain,
      position: r.position,
      title: p.title,
      word_count: p.word_count,
      headings: p.headings,
      sections: p.headings.filter((h) => h.level === 2 || h.level === 3).map((h) => h.text),
      images: p.images.length,
      internal_links: p.links.filter((l) => l.internal).length,
      external_links: p.links.filter((l) => !l.internal).length,
      has_lists: /\n\s*[-•*]\s/.test(p.text) || p.text.includes('\n1. '),
      has_tables: p.text.includes('\t') || false,
      schema_types: schemaTypes(p),
    });
  });

  const analysed = competitors.filter((c) => !c.fetch_error && c.word_count >= 100);
  if (analysed.length === 0) {
    notes.push(
      'No competitor page could be analysed — every top result was unreachable, bot-blocked, or client-rendered. ' +
        'The brief below is based on SERP metadata only and the word-count target is a generic default.',
    );
  } else if (analysed.length < targets.length / 2) {
    notes.push(
      `Only ${analysed.length} of ${targets.length} top results could be analysed; the rest blocked the crawler. ` +
        'Benchmarks are computed from the pages that were readable.',
    );
  }

  const wordCounts = analysed.map((c) => c.word_count).sort((a, b) => a - b);
  const stats = {
    min: wordCounts[0] ?? 0,
    median: median(wordCounts),
    max: wordCounts[wordCounts.length - 1] ?? 0,
    mean: wordCounts.length > 0 ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length) : 0,
  };
  // Aim slightly above the median rather than the max: chasing the longest page
  // usually means padding, and the median is what actually ranks.
  const targetWords = stats.median > 0 ? Math.round(stats.median * 1.15) : 1200;

  const required = competitiveTerms(texts, { limit: 35 });
  const commonSections = findCommonSections(analysed);

  const questions = [
    ...serp.people_also_ask,
    ...analysed.flatMap((c) => c.sections.filter(isQuestion)),
    ...(opts.extraQuestions ?? []),
  ];
  const uniqueQuestions = dedupeQuestions(questions).slice(0, 20);

  const intent = classifyIntent(serp.keyword, opts.brandTerms ?? []).intent;
  const outline = buildOutline(serp.keyword, intent, commonSections, uniqueQuestions, required, opts.language);

  const withLists = analysed.filter((c) => c.has_lists).length;
  const schemaCounts = new Map<string, number>();
  for (const c of analysed) for (const t of new Set(c.schema_types)) schemaCounts.set(t, (schemaCounts.get(t) ?? 0) + 1);

  return {
    keyword: serp.keyword,
    intent,
    target_word_count: targetWords,
    competitor_word_counts: stats,
    required_terms: required,
    common_sections: commonSections,
    questions: uniqueQuestions,
    suggested_outline: outline,
    suggested_title: suggestTitle(serp.keyword, intent, analysed, opts.language),
    suggested_slug: slugify(serp.keyword),
    suggested_meta_description: suggestMeta(serp.keyword, intent, opts.language),
    competitors,
    serp_features: serp.features,
    format_signals: {
      pct_with_lists: analysed.length > 0 ? round((withLists / analysed.length) * 100, 0) : 0,
      pct_with_tables: analysed.length > 0 ? round((analysed.filter((c) => c.has_tables).length / analysed.length) * 100, 0) : 0,
      median_images: median(analysed.map((c) => c.images).sort((a, b) => a - b)),
      median_sections: median(analysed.map((c) => c.sections.length).sort((a, b) => a - b)),
      common_schema: [...schemaCounts]
        .filter(([, n]) => n >= Math.max(2, analysed.length * 0.4))
        .map(([t]) => t),
    },
    notes,
  };
}

function schemaTypes(p: PageData): string[] {
  const out: string[] = [];
  for (const block of p.jsonld) {
    if (!block || typeof block !== 'object') continue;
    const t = (block as Record<string, unknown>)['@type'];
    if (typeof t === 'string') out.push(t);
    else if (Array.isArray(t)) out.push(...t.filter((x): x is string => typeof x === 'string'));
  }
  return out;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2))
    : (sorted[mid] as number);
}

/**
 * Section headings several competitors share.
 *
 * Matched on stemmed content tokens so "Pricing" and "Pricing plans" and
 * "How much does it cost" don't fragment into three separate one-vote sections.
 */
function findCommonSections(
  competitors: CompetitorPage[],
): Array<{ heading: string; used_by: number; examples: string[] }> {
  const groups = new Map<string, { headings: string[]; docs: Set<number> }>();

  competitors.forEach((c, docIndex) => {
    const seenInDoc = new Set<string>();
    for (const section of c.sections) {
      const clean = section.trim();
      if (!clean || clean.length > 120) continue;
      if (BOILERPLATE_HEADINGS.has(clean.toLowerCase())) continue;
      const tokens = contentTokens(clean).map(stem);
      if (tokens.length === 0) continue;
      // Key on the two most distinctive tokens so near-identical headings merge.
      const key = tokens.slice(0, 3).sort().join('|');
      if (seenInDoc.has(key)) continue;
      seenInDoc.add(key);
      const g = groups.get(key) ?? { headings: [], docs: new Set<number>() };
      g.headings.push(clean);
      g.docs.add(docIndex);
      groups.set(key, g);
    }
  });

  return [...groups.values()]
    .filter((g) => g.docs.size >= 2)
    .map((g) => ({
      // Report the most common surface form as the canonical heading.
      heading: mostCommon(g.headings),
      used_by: g.docs.size,
      examples: [...new Set(g.headings)].slice(0, 3),
    }))
    .sort((a, b) => b.used_by - a.used_by)
    .slice(0, 20);
}

function mostCommon(items: string[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? (items[0] as string);
}

function dedupeQuestions(questions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of questions) {
    const clean = q.trim();
    if (!clean || clean.length > 200) continue;
    const key = contentTokens(clean).map(stem).sort().join('|');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean.endsWith('?') || !isQuestion(clean) ? clean : `${clean}?`);
  }
  return out;
}

function buildOutline(
  keyword: string,
  intent: Intent,
  sections: Array<{ heading: string; used_by: number }>,
  questions: string[],
  terms: Array<{ term: string }>,
  language?: string,
): Array<{ level: number; heading: string; rationale: string }> {
  const outline: Array<{ level: number; heading: string; rationale: string }> = [];
  const copy = pageCopy(language).sections;
  const titled = headline(keyword, language, titleCase);

  outline.push({
    level: 1,
    heading: titled,
    rationale: 'H1 carries the primary keyword.',
  });
  outline.push({
    level: 2,
    heading: intent === 'informational' ? copy.what_is(titled) : copy.quick_answer(titled),
    rationale:
      'Answer the query in the first 100 words. This is what gets pulled into featured snippets and AI overviews.',
  });

  // Sections the competitors agree on come next — these define topical completeness.
  for (const s of sections.slice(0, 8)) {
    outline.push({
      level: 2,
      heading: s.heading,
      rationale: `${s.used_by} of the top-ranking pages have a section on this. Omitting it looks like an incomplete answer.`,
    });
  }

  // Terms nobody's heading covers still need a home somewhere.
  const covered = new Set(sections.flatMap((s) => contentTokens(s.heading).map(stem)));
  const uncoveredTerms = terms
    .filter((t) => !contentTokens(t.term).map(stem).some((tok) => covered.has(tok)))
    .slice(0, 3);
  for (const t of uncoveredTerms) {
    outline.push({
      level: 2,
      heading: headline(t.term, language, titleCase),
      rationale: 'Competitors reference this term consistently but without a dedicated section — an opening to be more thorough.',
    });
  }

  if (questions.length > 0) {
    outline.push({
      level: 2,
      heading: copy.faq,
      rationale: 'Captures People Also Ask placements. Mark it up with FAQPage schema.',
    });
    for (const q of questions.slice(0, 6)) {
      outline.push({ level: 3, heading: q, rationale: 'Asked in People Also Ask or by a competing page.' });
    }
  }

  if (intent === 'commercial' || intent === 'transactional') {
    outline.push({
      level: 2,
      heading: copy.which_to_choose,
      rationale: 'Commercial intent needs an explicit recommendation and a next step, not just a comparison.',
    });
  }

  return outline;
}

function suggestTitle(keyword: string, intent: Intent, competitors: CompetitorPage[], language?: string): string {
  const titled = headline(keyword, language, titleCase);
  const titleCopy = pageCopy(language).title;
  const year = new Date().getFullYear();
  // Match the SERP's own conventions: if most ranking titles carry a year, a
  // title without one looks stale by comparison.
  const withYear = competitors.filter((c) => c.title && /20\d\d/.test(c.title)).length;
  const wantsYear = competitors.length > 0 && withYear >= competitors.length * 0.4;

  let base: string;
  if (intent === 'commercial') base = titleCopy.compared(titled);
  else if (intent === 'transactional') base = titled;
  else if (isQuestion(keyword)) base = titled;
  else base = titleCopy.guide(titled);

  const candidate = wantsYear ? `${base} (${year})` : base;
  return candidate.length <= 60 ? candidate : truncate(titled, 57);
}

function suggestMeta(keyword: string, intent: Intent, language?: string): string {
  const k = keyword.toLowerCase();
  const copy = pageCopy(language).meta;
  const body =
    intent === 'commercial'
      ? copy.commercial(k)
      : intent === 'transactional'
        ? copy.transactional(k)
        : copy.informational(k);
  return body.length > 158 ? `${body.slice(0, 155)}...` : body;
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

/**
 * A brief built without any SERP access.
 *
 * Degraded but honest: no competitor grounding, so the outline comes from the
 * keyword cluster and question mining alone. Every field that would normally be
 * competitively derived is marked as such in `notes`.
 */
export function buildBriefWithoutSerp(
  keyword: string,
  clusterKeywords: string[],
  questions: string[],
  brandTerms: string[] = [],
  language?: string,
): ContentBrief {
  const intent = classifyIntent(keyword, brandTerms).intent;
  const uniqueQuestions = dedupeQuestions(questions).slice(0, 15);
  const pseudoTerms = clusterKeywords
    .filter((k) => k !== keyword)
    .slice(0, 25)
    .map((k) => ({ term: k, document_frequency: 0, avg_count: 0 }));

  return {
    keyword,
    intent,
    target_word_count: intent === 'informational' ? 1500 : 1000,
    competitor_word_counts: { min: 0, median: 0, max: 0, mean: 0 },
    required_terms: pseudoTerms,
    common_sections: [],
    questions: uniqueQuestions,
    suggested_outline: buildOutline(keyword, intent, [], uniqueQuestions, pseudoTerms, language),
    suggested_title: suggestTitle(keyword, intent, [], language),
    suggested_slug: slugify(keyword),
    suggested_meta_description: suggestMeta(keyword, intent, language),
    competitors: [],
    serp_features: [],
    format_signals: {
      pct_with_lists: 0,
      pct_with_tables: 0,
      median_images: 0,
      median_sections: 0,
      common_schema: [],
    },
    notes: [
      'No SERP provider configured, so this brief has no competitor grounding. ' +
        'Word-count target and required terms are derived from the keyword cluster, not from pages that actually rank. ' +
        'Set SERPER_API_KEY, SERPAPI_KEY or DataForSEO credentials for a competitively grounded brief.',
    ],
  };
}

export { domainOf };
