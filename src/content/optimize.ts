import type { PageData, Action } from '../core/types.js';
import { action } from '../core/envelope.js';
import {
  containsPhrase,
  countPhrase,
  readability,
  round,
  clamp,
  tokenize,
  contentTokens,
  stem,
  extractTerms,
  truncate,
  splitSentences,
  type Readability,
} from '../core/text.js';
import { slugToWords } from '../core/url.js';
import { headline } from '../core/copy.js';

/**
 * On-page content scoring and optimisation.
 *
 * This is the tool the agent uses while it's writing, and it is deliberately
 * *prescriptive* rather than descriptive. A human writer is happy with
 * "keyword density 0.4%" and will decide what to do. An agent needs
 * "the primary keyword does not appear in the H1; use this H1 instead", because
 * a number without a directive just gets narrated back to the user.
 *
 * Density targets deserve a note: keyword density is not a ranking factor and
 * hasn't been for over a decade. What is checked here is *placement* — whether
 * the term appears in the positions that carry semantic weight (title, H1, first
 * paragraph, subheadings) — plus a guard against keyword stuffing, which is
 * still actively penalised.
 */

export interface ContentTarget {
  /** The one keyword this page is built to rank for. */
  primary: string;
  /**
   * Content language, so readability uses the right formula. Without it Spanish
   * drafts are scored with Flesch, which is fitted to English syllable counts
   * and rated ordinary Spanish prose 25.8 where English equivalent scored 88.7.
   */
  language?: string;
  /** Supporting terms and variants, typically the rest of the cluster. */
  secondary?: string[];
  /**
   * Terms the top-ranking pages cover. From `seo_content_brief`, this is what
   * turns scoring from generic advice into competitive analysis.
   */
  required_terms?: string[];
  /** Word count to aim for, usually the competitor median. */
  target_words?: number;
}

export interface PlacementCheck {
  location: 'title' | 'meta_description' | 'h1' | 'first_paragraph' | 'subheadings' | 'url' | 'body' | 'image_alt';
  present: boolean;
  /**
   * False when the caller never supplied this field, so it is excluded from the
   * score instead of counted as a failure.
   *
   * Scoring a *crawled page* with no title is a real defect and stays
   * applicable. Scoring a *draft body* that has no title or URL yet is not:
   * counting those as misses capped a body-only score at ~62 and made a
   * well-optimised article (26.5) score below off-topic filler (27.0). The
   * recommendation to write a title still comes back as an action.
   */
  applicable: boolean;
  /** How much this placement matters, 0-1. Used to weight the score. */
  weight: number;
  detail: string;
}

export interface ContentScore {
  /** 0-100 overall optimisation score. */
  score: number;
  /**
   * Language the content was scored as. Carried here because
   * `contentScoreToActions` proposes literal replacement titles and H1s, which
   * are page copy: without it a Spanish page was told to use English Title Case.
   */
  language: string | undefined;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  primary_keyword: string;
  word_count: number;
  target_words: number | null;
  placements: PlacementCheck[];
  keyword_density: number;
  /** Mentions of the primary term per 100 words. This is what `over_optimized` judges. */
  mentions_per_100_words: number;
  /** True when the primary term is repeated to a degree that reads as spam. */
  over_optimized: boolean;
  readability: Readability;
  secondary_coverage: Array<{ term: string; count: number; present: boolean }>;
  required_terms_coverage: {
    covered: string[];
    missing: string[];
    coverage_pct: number;
  };
  headings: { h1: number; h2: number; h3: number; total: number };
  /** Structural elements that correlate with holding a top position. */
  structure: {
    has_intro: boolean;
    has_lists: boolean;
    has_images: boolean;
    avg_section_words: number;
    internal_links: number;
    external_links: number;
  };
  issues: string[];
}

const PLACEMENT_WEIGHTS = {
  title: 0.2,
  h1: 0.15,
  first_paragraph: 0.12,
  subheadings: 0.1,
  url: 0.08,
  meta_description: 0.07,
  body: 0.05,
  image_alt: 0.03,
} as const;

export interface ScoreInput {
  /** Provide either a crawled page, or the raw pieces for a draft. */
  page?: PageData;
  title?: string | null;
  meta_description?: string | null;
  h1?: string | null;
  /** Markdown or plain text. Markdown headings are parsed. */
  body?: string;
  url?: string;
}

export function scoreContent(input: ScoreInput, target: ContentTarget): ContentScore {
  const doc = normalizeInput(input);
  const primary = target.primary.trim().toLowerCase();
  const bodyText = doc.body;
  const words = tokenize(bodyText).length;

  const firstParagraph = firstMeaningfulParagraph(bodyText);
  const subheadingText = doc.headings.filter((h) => h.level >= 2).map((h) => h.text).join(' \n ');

  const placements: PlacementCheck[] = [
    {
      location: 'title',
      present: containsPhrase(doc.title ?? '', primary),
      applicable: doc.fromPage || doc.title !== null,
      weight: PLACEMENT_WEIGHTS.title,
      detail: doc.title
        ? `Title: "${truncate(doc.title, 80)}"`
        : 'No title. This is the strongest on-page signal available.',
    },
    {
      location: 'h1',
      present: containsPhrase(doc.h1 ?? '', primary),
      applicable: true,
      weight: PLACEMENT_WEIGHTS.h1,
      detail: doc.h1 ? `H1: "${truncate(doc.h1, 80)}"` : 'No H1 found.',
    },
    {
      location: 'first_paragraph',
      present: containsPhrase(firstParagraph, primary),
      applicable: true,
      weight: PLACEMENT_WEIGHTS.first_paragraph,
      detail: firstParagraph
        ? `Opening: "${truncate(firstParagraph, 100)}"`
        : 'No opening paragraph detected.',
    },
    {
      location: 'subheadings',
      present: containsPhrase(subheadingText, primary),
      applicable: true,
      weight: PLACEMENT_WEIGHTS.subheadings,
      detail: `${doc.headings.filter((h) => h.level >= 2).length} subheading(s) found.`,
    },
    {
      location: 'url',
      present: doc.url ? containsPhrase(slugToWords(doc.url), primary) : false,
      applicable: doc.fromPage || doc.url !== null,
      weight: PLACEMENT_WEIGHTS.url,
      detail: doc.url ? `Slug reads as "${slugToWords(doc.url)}"` : 'No URL supplied.',
    },
    {
      location: 'meta_description',
      present: containsPhrase(doc.meta_description ?? '', primary),
      applicable: doc.fromPage || doc.meta_description !== null,
      weight: PLACEMENT_WEIGHTS.meta_description,
      detail: doc.meta_description
        ? `Meta description is ${doc.meta_description.length} chars.`
        : 'No meta description.',
    },
    {
      location: 'body',
      present: containsPhrase(bodyText, primary),
      applicable: true,
      weight: PLACEMENT_WEIGHTS.body,
      detail: `Body is ${words} words.`,
    },
    {
      location: 'image_alt',
      present: doc.imageAlts.some((a) => containsPhrase(a, primary)),
      applicable: true,
      weight: PLACEMENT_WEIGHTS.image_alt,
      detail: `${doc.imageAlts.length} image(s) with alt text.`,
    },
  ];

  const primaryCount = countPhrase(bodyText, primary);
  const primaryWords = contentTokens(primary).length || 1;
  // Conventional keyword density: share of the body's words taken up by the term.
  const density = words > 0 ? round(((primaryCount * primaryWords) / words) * 100, 2) : 0;
  // Judge on the *mention rate* instead, because word-share scales with phrase
  // length: "employee time tracking software" mentioned a normal 6 times in a
  // 262-word article yields 9.16% density and was flagged as stuffing, while the
  // same rate for a one-word term reads 2.29%. Multi-word phrases are the common
  // case in SEO, so the word-share threshold penalised correct usage.
  const mentionRate = words > 0 ? round((primaryCount / words) * 100, 2) : 0;
  // Over ~3.5 mentions per 100 words reads as stuffing to readers and classifiers.
  const overOptimized = mentionRate > 3.5 && primaryCount > 5;

  const secondary = target.secondary ?? [];
  const secondaryCoverage = secondary.map((term) => {
    const count = countPhrase(bodyText, term);
    return { term, count, present: count > 0 };
  });

  const required = target.required_terms ?? [];
  const covered: string[] = [];
  const missing: string[] = [];
  for (const term of required) {
    // Check headings too: a term used as a section title is well covered even
    // if it appears only once.
    if (containsPhrase(bodyText, term) || containsPhrase(subheadingText, term)) covered.push(term);
    else missing.push(term);
  }

  const headingCounts = {
    h1: doc.headings.filter((h) => h.level === 1).length,
    h2: doc.headings.filter((h) => h.level === 2).length,
    h3: doc.headings.filter((h) => h.level === 3).length,
    total: doc.headings.length,
  };

  const sections = Math.max(1, headingCounts.h2 + headingCounts.h3);
  const structure = {
    has_intro: tokenize(firstParagraph).length >= 25,
    has_lists: /^\s*([-*+]|\d+[.)])\s+/m.test(bodyText),
    has_images: doc.imageAlts.length > 0 || /!\[[^\]]*\]\(/.test(bodyText),
    avg_section_words: round(words / sections, 0),
    internal_links: doc.internalLinks,
    external_links: doc.externalLinks,
  };

  const read = readability(bodyText, target.language);

  // --- score assembly ----------------------------------------------------
  // 60 points for keyword placement, 20 for competitive term coverage,
  // 12 for length, 8 for structure and readability.
  let score = 0;
  // Only applicable slots count, so a draft is not marked down for a title or
  // URL it has not been given yet. `applicable` is always true for a crawled page.
  const scored = placements.filter((p) => p.applicable);
  const placementTotal = scored.reduce((s, p) => s + p.weight, 0);
  const placementEarned = scored.filter((p) => p.present).reduce((s, p) => s + p.weight, 0);
  score += placementTotal > 0 ? (placementEarned / placementTotal) * 60 : 0;

  if (required.length > 0) {
    score += (covered.length / required.length) * 20;
  } else if (secondary.length > 0) {
    // No competitive brief, so fall back on secondary-keyword coverage.
    score += (secondaryCoverage.filter((s) => s.present).length / secondary.length) * 20;
  } else {
    // Nothing to measure coverage against; don't penalise for our own missing input.
    score += 14;
  }

  const targetWords = target.target_words ?? null;
  if (targetWords) {
    const ratio = words / targetWords;
    // Full marks from 85% of target upward; being longer isn't rewarded further.
    score += clamp(ratio >= 0.85 ? 12 : ratio * 14, 0, 12);
  } else {
    score += words >= 600 ? 12 : words >= 300 ? 8 : words >= 150 ? 4 : 0;
  }

  let structureScore = 0;
  if (headingCounts.h1 === 1) structureScore += 2;
  if (headingCounts.h2 >= 2) structureScore += 2;
  if (structure.has_intro) structureScore += 1;
  if (structure.has_lists) structureScore += 1;
  if (structure.internal_links >= 2) structureScore += 1;
  if (read.reading_ease >= 50) structureScore += 1;
  score += structureScore;

  if (overOptimized) {
    // Scaled, not flat. Flat -12 left a page repeating its keyword 90 times
    // scoring 53/100, because it still earned full marks for placement — but
    // keyword stuffing is an active spam signal, not a minor deduction, and a
    // passing grade on it would be actively misleading to an agent.
    score -= clamp(12 + (density - 3.5) * 3, 12, 55);
  }

  const issues: string[] = [];
  for (const p of placements) {
    if (!p.present && p.weight >= 0.08) {
      issues.push(`Primary keyword "${primary}" is missing from the ${p.location.replace('_', ' ')}.`);
    }
  }
  if (overOptimized) {
    issues.push(
      `Keyword density is ${density}% (${primaryCount} occurrences) — this reads as keyword stuffing. Replace some occurrences with natural variants.`,
    );
  }
  if (targetWords && words < targetWords * 0.7) {
    issues.push(
      `At ${words} words the page is well short of the ${targetWords}-word competitive benchmark.`,
    );
  }
  if (headingCounts.h1 === 0) issues.push('No H1 heading.');
  if (headingCounts.h1 > 1) issues.push(`${headingCounts.h1} H1 tags; there should be exactly one.`);
  if (headingCounts.h2 < 2 && words > 600) {
    issues.push('Long page with fewer than two H2 sections — add subheadings so it can be skimmed.');
  }
  if (read.reading_ease < 40 && words > 200) {
    issues.push(
      `Reading ease is ${read.reading_ease} (hard). ${read.long_sentences} sentence(s) exceed 30 words.`,
    );
  }
  if (structure.internal_links === 0 && words > 400) {
    issues.push('No internal links. Add links to related pages to pass authority and help users continue.');
  }
  if (missing.length > 0) {
    issues.push(
      `Missing ${missing.length} term(s) the top-ranking pages cover: ${missing.slice(0, 8).join(', ')}.`,
    );
  }

  const finalScore = round(clamp(score, 0, 100), 1);

  return {
    language: target.language,
    score: finalScore,
    grade: gradeFor(finalScore),
    primary_keyword: primary,
    word_count: words,
    target_words: targetWords,
    placements,
    keyword_density: density,
    mentions_per_100_words: mentionRate,
    over_optimized: overOptimized,
    readability: read,
    secondary_coverage: secondaryCoverage,
    required_terms_coverage: {
      covered,
      missing,
      coverage_pct: required.length > 0 ? round((covered.length / required.length) * 100, 1) : 100,
    },
    headings: headingCounts,
    structure,
    issues,
  };
}

function gradeFor(score: number): ContentScore['grade'] {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

interface NormalizedDoc {
  /** True when scoring a crawled page, where an absent field is a real defect. */
  fromPage: boolean;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  body: string;
  url: string | null;
  headings: Array<{ level: number; text: string }>;
  imageAlts: string[];
  internalLinks: number;
  externalLinks: number;
}

/** Accept a crawled page or a raw draft and produce one shape to analyse. */
function normalizeInput(input: ScoreInput): NormalizedDoc {
  if (input.page) {
    const p = input.page;
    return {
      fromPage: true,
      title: input.title ?? p.title,
      meta_description: input.meta_description ?? p.meta_description,
      h1: input.h1 ?? p.h1[0] ?? null,
      body: input.body ?? p.text,
      url: input.url ?? p.url,
      headings: p.headings,
      imageAlts: p.images.map((i) => i.alt ?? '').filter(Boolean),
      internalLinks: p.links.filter((l) => l.internal).length,
      externalLinks: p.links.filter((l) => !l.internal).length,
    };
  }

  const body = input.body ?? '';
  const headings = parseMarkdownHeadings(body);
  return {
    fromPage: false,
    title: input.title ?? null,
    meta_description: input.meta_description ?? null,
    h1: input.h1 ?? headings.find((h) => h.level === 1)?.text ?? null,
    body: stripMarkdown(body),
    url: input.url ?? null,
    headings,
    imageAlts: [...body.matchAll(/!\[([^\]]*)\]\(/g)].map((m) => m[1] ?? '').filter(Boolean),
    // Root-relative and same-doc markdown links count as internal; anything with
    // a scheme counts as external.
    internalLinks: [...body.matchAll(/\[[^\]]+\]\((\/[^)]*|\.\/[^)]*|#[^)]*)\)/g)].length,
    externalLinks: [...body.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]*)\)/g)].length,
  };
}

export function parseMarkdownHeadings(md: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = [];
  const lines = md.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      out.push({ level: (atx[1] as string).length, text: (atx[2] as string).trim() });
      continue;
    }
    // Setext headings: text underlined with === or ---.
    const next = lines[i + 1];
    if (next && line.trim() && /^\s*(=+|-{2,})\s*$/.test(next)) {
      out.push({ level: next.trim().startsWith('=') ? 1 : 2, text: line.trim() });
    }
  }
  return out;
}

/** Strip markdown syntax so word counts and readability reflect prose, not markup. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, ' '))
    .replace(/^\s*[-:|\s]+\s*$/gm, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstMeaningfulParagraph(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (const p of paragraphs) {
    if (tokenize(p).length >= 15) return p;
  }
  // No paragraph breaks (common for extracted body text): use the first sentences.
  return splitSentences(text).slice(0, 3).join(' ');
}

/**
 * Concrete edits, ordered. Every action here should be applyable by an agent
 * without further analysis.
 */
export function contentScoreToActions(score: ContentScore, doc: ScoreInput): Action[] {
  const actions: Action[] = [];
  const primary = score.primary_keyword;
  const target = doc.url ?? doc.title ?? primary;

  const titlePlacement = score.placements.find((p) => p.location === 'title');
  if (titlePlacement && !titlePlacement.present) {
    const currentTitle = doc.title ?? doc.page?.title ?? '';
    const proposed = buildTitle(primary, currentTitle, score.language);
    actions.push(
      action({
        id: `content.title.${target}`,
        priority: 'critical',
        effort: 'trivial',
        category: 'on-page',
        title: `Put "${primary}" in the title tag`,
        detail:
          'The title is the strongest on-page relevance signal. It should lead with the primary keyword ' +
          'and stay under 60 characters so it is not truncated in results.',
        target,
        impact_score: 90,
        evidence: { current: currentTitle, length: currentTitle.length },
        fix: { type: 'set_title', from: currentTitle, to: proposed },
      }),
    );
  }

  const h1Placement = score.placements.find((p) => p.location === 'h1');
  if (h1Placement && !h1Placement.present) {
    const current = doc.h1 ?? doc.page?.h1[0] ?? '';
    actions.push(
      action({
        id: `content.h1.${target}`,
        priority: 'high',
        effort: 'trivial',
        category: 'on-page',
        title: `Put "${primary}" in the H1`,
        detail: 'The H1 confirms the page topic. Keep it close to the title but not identical.',
        target,
        impact_score: 78,
        evidence: { current },
        fix: { type: 'set_h1', from: current, to: headline(primary, score.language, titleCase) },
      }),
    );
  }

  const firstPara = score.placements.find((p) => p.location === 'first_paragraph');
  if (firstPara && !firstPara.present) {
    actions.push(
      action({
        id: `content.intro.${target}`,
        priority: 'high',
        effort: 'trivial',
        category: 'on-page',
        title: `Mention "${primary}" in the opening paragraph`,
        detail:
          'The first 100 words establish topical relevance and are often what gets pulled into a featured snippet. ' +
          'Answer the query directly there rather than building up to it.',
        target,
        impact_score: 70,
        fix: { type: 'rewrite_intro', to: `Open by directly answering what "${primary}" is or does.` },
      }),
    );
  }

  if (score.required_terms_coverage.missing.length > 0) {
    const missing = score.required_terms_coverage.missing;
    actions.push(
      action({
        id: `content.terms.${target}`,
        priority: 'high',
        effort: 'medium',
        category: 'content',
        title: `Cover ${missing.length} subtopic(s) the top-ranking pages all address`,
        detail:
          `Coverage is ${score.required_terms_coverage.coverage_pct}% of the competitive term set. ` +
          'Missing terms usually mean a missing section, not a missing mention — add real content for each.',
        target,
        impact_score: round(clamp(50 + missing.length * 3, 0, 95), 1),
        evidence: { missing: missing.slice(0, 20), covered_count: score.required_terms_coverage.covered.length },
        fix: { type: 'add_sections', terms: missing.slice(0, 20) },
      }),
    );
  }

  if (score.target_words && score.word_count < score.target_words * 0.7) {
    actions.push(
      action({
        id: `content.length.${target}`,
        priority: 'medium',
        effort: 'large',
        category: 'content',
        title: `Expand from ${score.word_count} to about ${score.target_words} words`,
        detail:
          'Length is not a ranking factor in itself, but falling far short of what every ranking page covers ' +
          'usually means the page genuinely answers less. Add depth, not padding.',
        target,
        impact_score: 58,
        evidence: { current: score.word_count, benchmark: score.target_words },
        fix: { type: 'expand_content', to: String(score.target_words) },
      }),
    );
  }

  if (score.over_optimized) {
    actions.push(
      action({
        id: `content.stuffing.${target}`,
        priority: 'high',
        effort: 'small',
        category: 'content',
        title: `Reduce keyword repetition — density is ${score.keyword_density}%`,
        detail:
          'This level of repetition reads unnaturally and is a recognised spam signal. ' +
          'Replace most occurrences with pronouns and synonyms; keep the deliberate placements.',
        target,
        impact_score: 65,
        fix: { type: 'reduce_density', to: 'under 2%' },
      }),
    );
  }

  const metaPlacement = score.placements.find((p) => p.location === 'meta_description');
  if (metaPlacement && !metaPlacement.present) {
    actions.push(
      action({
        id: `content.meta.${target}`,
        priority: 'low',
        effort: 'trivial',
        category: 'on-page',
        title: `Write a meta description containing "${primary}"`,
        detail:
          'Meta descriptions do not affect rankings but do affect click-through, and Google bolds query matches in them.',
        target,
        impact_score: 35,
        fix: {
          type: 'set_meta_description',
          to: `A 140-160 character description that leads with "${primary}" and states the specific benefit.`,
        },
      }),
    );
  }

  if (score.readability.reading_ease < 40 && score.word_count > 200) {
    actions.push(
      action({
        id: `content.readability.${target}`,
        priority: 'low',
        effort: 'medium',
        category: 'content',
        title: `Simplify the writing — reading ease is ${score.readability.reading_ease}`,
        detail:
          `${score.readability.long_sentences} sentence(s) run past 30 words and the average is ` +
          `${score.readability.avg_words_per_sentence}. Split them and prefer shorter words.`,
        target,
        impact_score: 30,
        fix: { type: 'simplify_prose', to: 'Flesch reading ease above 50' },
      }),
    );
  }

  return actions;
}

/** Build a title under 60 chars that leads with the keyword. */
function buildTitle(primary: string, current: string, language?: string): string {
  const cased = headline(primary, language, titleCase);
  // Keep a brand suffix if the current title has one and there's room.
  const brandMatch = /\s+[|—–]\s+(.+)$/.exec(current);
  const brand = brandMatch?.[1]?.trim();
  if (brand && cased.length + brand.length + 3 <= 60) return `${cased} | ${brand}`;
  return cased.length <= 60 ? cased : `${cased.slice(0, 57)}...`;
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
 * Terms the competing pages share that a draft is missing.
 * Feeds `required_terms` in a brief — this is the "content gap" at page level.
 */
export function competitiveTerms(
  competitorTexts: string[],
  opts: { minDocumentFrequency?: number; limit?: number } = {},
): Array<{ term: string; document_frequency: number; avg_count: number }> {
  const minDf = opts.minDocumentFrequency ?? Math.max(2, Math.ceil(competitorTexts.length * 0.5));
  const docFreq = new Map<string, { docs: number; total: number }>();

  for (const text of competitorTexts) {
    const terms = extractTerms(text, 120);
    const seen = new Set<string>();
    for (const t of terms) {
      const key = contentTokens(t.term).map(stem).join(' ');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const e = docFreq.get(t.term) ?? { docs: 0, total: 0 };
      e.docs++;
      e.total += t.count;
      docFreq.set(t.term, e);
    }
  }

  return [...docFreq]
    .filter(([, v]) => v.docs >= minDf)
    .map(([term, v]) => ({
      term,
      document_frequency: v.docs,
      avg_count: round(v.total / v.docs, 1),
    }))
    // Terms nearly every competitor uses are the ones that define the topic.
    .sort((a, b) => b.document_frequency - a.document_frequency || b.avg_count - a.avg_count)
    .slice(0, opts.limit ?? 40);
}
