import type { Keyword, KeywordCluster, Intent, SerpData } from '../core/types.js';
import { contentTokens, stem, round } from '../core/text.js';
import { classifyIntent, isQuestion } from './intent.js';
import { slugify } from '../core/url.js';
import { pageCopy, headline } from '../core/copy.js';

/**
 * Keyword clustering — turning a keyword list into a content plan.
 *
 * This is the step that makes programmatic SEO possible. A raw list of 2,000
 * keywords is unusable; 180 clusters, each mapping to exactly one page with one
 * primary and N secondary keywords, is a publishing queue.
 *
 * Two algorithms, because the right one depends on what data is available:
 *
 * - `clusterBySerp` is the industry-correct method: if two keywords return
 *   substantially the same top-10 results, Google considers them the same
 *   intent, so one page should target both. It needs a SERP fetch per keyword,
 *   which costs real money at scale.
 * - `clusterByLexical` is free and runs on any list. It's a good approximation
 *   for the long tail, where keywords that share stems almost always share
 *   intent. It's less reliable on synonym pairs ("crm" vs "customer database")
 *   which only SERP overlap can catch.
 */

export interface ClusterOptions {
  /**
   * How much of the head keyword's *distinctive* core must appear for a keyword
   * to join. Raise it toward 1 for tighter, more numerous clusters; lower it to
   * merge more aggressively.
   *
   * Both failure modes are real, but they are not symmetric. A fragmented plan
   * risks two thin pages competing for one query — recoverable, and the
   * cannibalisation report catches it later. An over-merged plan produces one
   * cluster containing most of the keyword set, which is not a content plan at
   * all and gives the agent nothing to act on.
   */
  minOverlap?: number;
  /** Clusters smaller than this are merged into a catch-all or dropped. */
  minClusterSize?: number;
  maxClusters?: number;
  /** Keep questions in their own clusters — they usually want an FAQ or a section, not a page. */
  separateQuestions?: boolean;
}

export interface ClusterResult {
  clusters: KeywordCluster[];
  /** Keywords too dissimilar to group anywhere. */
  unclustered: string[];
  method: 'lexical' | 'serp';
  /** Total volume the clustered set represents. */
  total_volume: number;
}

interface Prepared {
  kw: Keyword;
  /** Every stemmed content token. */
  tokens: Set<string>;
  question: boolean;
}

function prepare(keywords: Keyword[]): Prepared[] {
  return keywords.map((kw) => ({
    kw,
    tokens: new Set(contentTokens(kw.keyword).map(stem)),
    question: isQuestion(kw.keyword),
  }));
}

/**
 * Tokens appearing in at least this share of the set carry no discriminative
 * information *within* the set and are treated as background.
 *
 * Seed-expanded keyword lists all share the seed's words, so those words say
 * nothing about which page a keyword belongs to.
 */
const BACKGROUND_SHARE = 0.6;

/**
 * Minimum share of the head's full token set a candidate must also contain.
 *
 * This is the second of two gates and it exists to stop the first one from
 * over-merging. Matching on distinctive tokens alone lets two keywords cluster
 * because they share nothing but a generic modifier — "best crm software" and
 * "best email marketing tools" both reduce to "best". Requiring topical overlap
 * as well keeps unrelated topics apart.
 */
const MIN_TOPICAL_OVERLAP = 0.5;

interface Vocabulary {
  /** IDF weight per token, 0 for tokens present in every keyword. */
  weights: Map<string, number>;
  /** Tokens frequent enough to be background noise for this set. */
  background: Set<string>;
}

function buildVocabulary(prepared: Prepared[]): Vocabulary {
  const n = Math.max(1, prepared.length);
  const df = new Map<string, number>();
  for (const p of prepared) {
    for (const t of p.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const weights = new Map<string, number>();
  const background = new Set<string>();
  for (const [token, count] of df) {
    weights.set(token, Math.log(n / count));
    if (count >= n * BACKGROUND_SHARE) background.add(token);
  }
  return { weights, background };
}

/** The tokens that actually distinguish this keyword from the rest of the set. */
function distinctiveTokens(tokens: Set<string>, vocab: Vocabulary): Set<string> {
  return new Set([...tokens].filter((t) => !vocab.background.has(t)));
}

function weightOf(tokens: Set<string>, w: Map<string, number>): number {
  let total = 0;
  for (const t of tokens) total += w.get(t) ?? 0;
  return total;
}

function sharedWeight(a: Set<string>, b: Set<string>, w: Map<string, number>): number {
  let total = 0;
  for (const t of a) if (b.has(t)) total += w.get(t) ?? 0;
  return total;
}

/** Fraction of `b` present in `a`, unweighted. */
function plainContainment(a: Set<string>, b: Set<string>): number {
  if (b.size === 0) return 0;
  let hits = 0;
  for (const t of b) if (a.has(t)) hits++;
  return hits / b.size;
}

/**
 * Should `cand` join the cluster headed by `head`?
 *
 * Two gates, both required, and each fixes a failure the other caused:
 *
 * 1. **Distinctive match.** The candidate must carry the head's differentiating
 *    content — or, when the head has none (it is the bare seed phrase), the
 *    candidate must be equally undifferentiated. Without this, seed-expanded
 *    sets collapse: on a real 45-keyword expansion of "static site generator",
 *    37 landed in one cluster because every keyword shares those three words.
 *
 * 2. **Topical overlap.** The candidate must also share most of the head's full
 *    token set. Without this, gate 1 merges anything that happens to share a
 *    generic modifier — "best crm software" absorbing "best email marketing
 *    tools" because both reduce to "best".
 */
function shouldJoin(head: Prepared, cand: Prepared, vocab: Vocabulary, minOverlap: number): boolean {
  if (plainContainment(cand.tokens, head.tokens) < MIN_TOPICAL_OVERLAP) return false;

  const headDistinctive = distinctiveTokens(head.tokens, vocab);
  const candDistinctive = distinctiveTokens(cand.tokens, vocab);

  // The head is the bare seed: only cluster it with other equally generic terms.
  // A candidate carrying real content is a distinct sub-topic and its own page.
  if (headDistinctive.size === 0) return candDistinctive.size === 0;
  // A candidate with no distinctive content cannot be a long tail of a specific head.
  if (candDistinctive.size === 0) return false;

  const headWeight = weightOf(headDistinctive, vocab.weights);
  if (headWeight < 1e-9) return true;
  const carries = sharedWeight(headDistinctive, candDistinctive, vocab.weights) / headWeight;

  const wa = weightOf(headDistinctive, vocab.weights);
  const wb = weightOf(candDistinctive, vocab.weights);
  const smaller = Math.min(wa, wb);
  const overlap = smaller < 1e-9 ? 0 : sharedWeight(headDistinctive, candDistinctive, vocab.weights) / smaller;

  return carries >= minOverlap || overlap >= Math.max(minOverlap, 0.66);
}

/**
 * Greedy head-first clustering.
 *
 * Sort by value, take the strongest unassigned keyword as a cluster head, absorb
 * everything sufficiently similar, repeat. Greedy rather than agglomerative
 * because it guarantees every cluster has a well-defined *primary* keyword — and
 * "what is this page's primary keyword" is the question the content planner
 * actually needs answered.
 */
export function clusterByLexical(keywords: Keyword[], opts: ClusterOptions = {}): ClusterResult {
  const minOverlap = opts.minOverlap ?? 0.5;
  const minSize = opts.minClusterSize ?? 1;
  const separateQuestions = opts.separateQuestions ?? false;

  const prepared = prepare(keywords).filter((p) => p.tokens.size > 0);
  const vocab = buildVocabulary(prepared);
  // Value order: explicit opportunity, then volume, then shortness (head terms
  // make better cluster heads than long tails).
  prepared.sort((a, b) => {
    const oa = a.kw.opportunity ?? -1;
    const ob = b.kw.opportunity ?? -1;
    if (ob !== oa) return ob - oa;
    const va = a.kw.volume ?? -1;
    const vb = b.kw.volume ?? -1;
    if (vb !== va) return vb - va;
    // Shorter wins ties. A cluster head should be the more general phrase, so
    // that longer variants of it can attach as the long tail.
    if (a.tokens.size !== b.tokens.size) return a.tokens.size - b.tokens.size;
    return a.kw.keyword.localeCompare(b.kw.keyword);
  });

  const assigned = new Set<string>();
  const clusters: KeywordCluster[] = [];

  for (const head of prepared) {
    if (assigned.has(head.kw.keyword)) continue;
    if (opts.maxClusters && clusters.length >= opts.maxClusters) break;

    assigned.add(head.kw.keyword);
    const members: Keyword[] = [head.kw];

    for (const cand of prepared) {
      if (assigned.has(cand.kw.keyword)) continue;
      if (separateQuestions && cand.question !== head.question) continue;

      if (shouldJoin(head, cand, vocab, minOverlap)) {
        assigned.add(cand.kw.keyword);
        members.push(cand.kw);
      }
    }

    if (members.length < minSize) continue;
    clusters.push(buildCluster(head.kw, members));
  }

  const unclustered = keywords
    .filter((k) => !assigned.has(k.keyword))
    .map((k) => k.keyword);

  clusters.sort((a, b) => b.total_volume - a.total_volume || a.head.localeCompare(b.head));

  return {
    clusters,
    unclustered,
    method: 'lexical',
    total_volume: clusters.reduce((sum, c) => sum + c.total_volume, 0),
  };
}

/**
 * SERP-overlap clustering.
 *
 * Two keywords belong on the same page when Google returns substantially the
 * same results for both. `minSharedUrls` of 3 is the widely-used threshold and
 * matches what the major tools do.
 */
export function clusterBySerp(
  keywords: Keyword[],
  serps: Map<string, SerpData>,
  opts: { minSharedUrls?: number; topN?: number } & ClusterOptions = {},
): ClusterResult {
  const minShared = opts.minSharedUrls ?? 3;
  const topN = opts.topN ?? 10;

  const urlSets = new Map<string, Set<string>>();
  for (const k of keywords) {
    const serp = serps.get(k.keyword);
    if (!serp) continue;
    urlSets.set(k.keyword, new Set(serp.results.slice(0, topN).map((r) => r.url)));
  }

  const byKeyword = new Map(keywords.map((k) => [k.keyword, k]));
  const ordered = [...keywords].sort((a, b) => {
    const oa = a.opportunity ?? a.volume ?? 0;
    const ob = b.opportunity ?? b.volume ?? 0;
    return ob - oa;
  });

  const assigned = new Set<string>();
  const clusters: KeywordCluster[] = [];

  for (const head of ordered) {
    if (assigned.has(head.keyword)) continue;
    const headUrls = urlSets.get(head.keyword);
    // No SERP for the head means we can't cluster it by this method at all.
    if (!headUrls || headUrls.size === 0) continue;

    assigned.add(head.keyword);
    const members: Keyword[] = [head];

    for (const cand of ordered) {
      if (assigned.has(cand.keyword)) continue;
      const candUrls = urlSets.get(cand.keyword);
      if (!candUrls) continue;
      let shared = 0;
      for (const u of candUrls) if (headUrls.has(u)) shared++;
      if (shared >= minShared) {
        assigned.add(cand.keyword);
        members.push(cand);
      }
    }
    clusters.push(buildCluster(head, members));
  }

  // Anything without SERP data falls back to lexical so nothing is silently lost.
  const leftover = keywords.filter((k) => !assigned.has(k.keyword));
  if (leftover.length > 0) {
    const fallback = clusterByLexical(leftover, opts);
    clusters.push(...fallback.clusters);
  }

  clusters.sort((a, b) => b.total_volume - a.total_volume || a.head.localeCompare(b.head));
  void byKeyword;

  return {
    clusters,
    unclustered: [],
    method: 'serp',
    total_volume: clusters.reduce((sum, c) => sum + c.total_volume, 0),
  };
}

function buildCluster(head: Keyword, members: Keyword[]): KeywordCluster {
  const volumes = members.map((m) => m.volume).filter((v): v is number => v !== null);
  const difficulties = members.map((m) => m.difficulty).filter((v): v is number => v !== null);

  // The cluster's intent is the majority vote of its members, weighted by
  // volume where known — one high-volume commercial term should outweigh five
  // incidental informational long-tails.
  const intentWeights = new Map<Intent, number>();
  for (const m of members) {
    const w = (m.volume ?? 10) + 1;
    intentWeights.set(m.intent, (intentWeights.get(m.intent) ?? 0) + w);
  }
  let intent: Intent = head.intent;
  let best = -1;
  for (const [k, v] of intentWeights) {
    if (v > best) {
      best = v;
      intent = k;
    }
  }

  return {
    head: head.keyword,
    keywords: members.map((m) => m.keyword),
    total_volume: volumes.reduce((a, b) => a + b, 0),
    avg_difficulty: difficulties.length > 0 ? round(difficulties.reduce((a, b) => a + b, 0) / difficulties.length, 1) : null,
    intent,
    page_type: recommendPageType(head.keyword, intent, members),
  };
}

/**
 * Which page format wins for this cluster.
 *
 * This drives the content planner directly, so it's worth being specific rather
 * than defaulting everything to 'blog-post'.
 */
export function recommendPageType(
  head: string,
  intent: Intent,
  members: Keyword[] = [],
): KeywordCluster['page_type'] {
  const kw = head.toLowerCase();
  const allText = [head, ...members.map((m) => m.keyword)].join(' ').toLowerCase();

  if (/\b(vs|versus|compared to|alternative|alternatives|competitor)\b/.test(kw)) return 'comparison';
  if (/\b(what is|definition|meaning|glossary|terminology)\b/.test(kw)) return 'glossary';
  if (/\b(calculator|generator|converter|checker|tool|template)\b/.test(kw)) return 'tool';
  if (/\b(how to|guide|tutorial|step by step|checklist)\b/.test(kw)) return 'guide';
  if (/\b(buy|price|pricing|cost|for sale|shop|order)\b/.test(kw)) return 'product';

  if (intent === 'transactional') return 'landing-page';
  if (intent === 'commercial') {
    // A commercial cluster full of "best X" queries wants a listicle-style
    // comparison, not a product page.
    return /\b(best|top|reviews?)\b/.test(allText) ? 'comparison' : 'landing-page';
  }
  if (intent === 'navigational') return 'landing-page';

  const questionRatio = members.length > 0 ? members.filter((m) => isQuestion(m.keyword)).length / members.length : 0;
  return questionRatio > 0.6 ? 'guide' : 'blog-post';
}

/**
 * Turn raw keyword strings into scored `Keyword` records.
 * Used wherever a tool accepts a plain list of strings.
 */
export function toKeywords(
  raw: Array<string | Partial<Keyword>>,
  opts: { source?: string; brandTerms?: string[] } = {},
): Keyword[] {
  const source = opts.source ?? 'input';
  const seen = new Set<string>();
  const out: Keyword[] = [];
  for (const item of raw) {
    const base = typeof item === 'string' ? { keyword: item } : item;
    const keyword = (base.keyword ?? '').trim().toLowerCase();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    const intent = base.intent ?? classifyIntent(keyword, opts.brandTerms ?? []).intent;
    out.push({
      keyword,
      volume: base.volume ?? null,
      difficulty: base.difficulty ?? null,
      cpc: base.cpc ?? null,
      intent,
      source: base.source ?? source,
      words: keyword.split(/\s+/).length,
      opportunity: base.opportunity ?? null,
      ...(base.cluster !== undefined ? { cluster: base.cluster } : {}),
      ...(base.position !== undefined ? { position: base.position } : {}),
    });
  }
  return out;
}

/** Suggested URL slug and title for a cluster, so the planner has a concrete target. */
export function clusterPageSpec(
  cluster: KeywordCluster,
  language?: string,
): { slug: string; title: string; h1: string } {
  const head = cluster.head;
  // Sentence case for Spanish; Title Case is an English headline convention and
  // reads as an error in Spanish copy.
  const titled = headline(head, language, titleCaseKeyword);
  const copy = pageCopy(language).title;
  const year = new Date().getFullYear();
  let title: string;
  switch (cluster.page_type) {
    case 'comparison':
      title = copy.comparison(titled, year);
      break;
    case 'guide':
      title = copy.guide(titled);
      break;
    case 'glossary':
      title = copy.glossary(titled);
      break;
    case 'tool':
      title = copy.tool(titled);
      break;
    case 'product':
      title = copy.product(titled);
      break;
    case 'landing-page':
      title = titled;
      break;
    default:
      title = titled;
  }
  return {
    slug: slugify(head),
    // Titles past ~60 characters get truncated in results.
    title: title.length > 60 ? `${titled.slice(0, 57)}...` : title,
    h1: titled,
  };
}

/** Shared with the content and pSEO planners so generated titles read consistently. */
function titleCaseKeyword(s: string): string {
  const acronyms = new Set([
    'seo', 'sem', 'crm', 'erp', 'cms', 'saas', 'api', 'sdk', 'ui', 'ux', 'ai', 'ml', 'llm',
    'roi', 'kpi', 'b2b', 'b2c', 'smb', 'ppc', 'cpc', 'ctr', 'cro', 'serp', 'url', 'html',
    'css', 'js', 'pdf', 'csv', 'sql', 'hr', 'it', 'pr', 'qa', 'ceo', 'cto', 'tv', 'pc',
  ]);
  const minor = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'for', 'of', 'in', 'on', 'at', 'to', 'vs', 'with', 'is']);
  return s
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (acronyms.has(lower)) return lower.toUpperCase();
      if (i > 0 && minor.has(lower)) return lower;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}
