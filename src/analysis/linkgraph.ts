import type { PageData, Action } from '../core/types.js';
import { action } from '../core/envelope.js';
import { round, clamp, contentTokens, stem, containsPhrase, truncate } from '../core/text.js';
import { slashInsensitiveKey } from '../core/url.js';

/**
 * Internal link graph analysis.
 *
 * Internal linking is the highest-leverage lever a site owner fully controls —
 * no outreach, no waiting, no third parties. And it's the one an agent can
 * actually execute end to end: it knows the content, so it can pick the right
 * anchor and the right paragraph.
 *
 * So this file does two things: measure where internal authority currently
 * flows (PageRank over the crawled graph), and propose specific links that would
 * redirect it usefully.
 */

export interface LinkGraphNode {
  url: string;
  title: string | null;
  depth: number;
  /** Internal links pointing in. */
  in_degree: number;
  /** Internal links pointing out. */
  out_degree: number;
  /** Normalised internal PageRank, 0-100 where 100 is the strongest page. */
  page_rank: number;
  word_count: number;
  indexable: boolean;
}

export interface LinkGraphReport {
  nodes: LinkGraphNode[];
  total_pages: number;
  total_internal_links: number;
  avg_links_per_page: number;
  /** Reachable but with no inbound internal links. */
  orphans: string[];
  /** Indexable pages in the weakest PageRank decile. */
  starved_pages: LinkGraphNode[];
  /** Pages hoarding authority they could pass on. */
  hub_pages: LinkGraphNode[];
  /** Deepest crawl depth observed. */
  max_depth: number;
  depth_distribution: Record<string, number>;
}

/**
 * Weighted PageRank over internal links.
 *
 * Standard damped iteration. Two deliberate deviations from textbook PageRank:
 * nofollow links are excluded (they don't pass equity), and dangling nodes
 * redistribute uniformly rather than being dropped, which otherwise leaks rank
 * mass and makes scores incomparable between crawls.
 */
export function computePageRank(
  pages: PageData[],
  opts: { damping?: number; iterations?: number } = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 40;

  const keyed = new Map<string, PageData>();
  for (const p of pages) keyed.set(slashInsensitiveKey(p.url), p);
  const urls = [...keyed.keys()];
  const n = urls.length;
  if (n === 0) return new Map();

  const index = new Map(urls.map((u, i) => [u, i]));
  const outgoing: number[][] = urls.map(() => []);

  for (const [key, page] of keyed) {
    const from = index.get(key) as number;
    const seen = new Set<number>();
    for (const link of page.links) {
      if (!link.internal || link.nofollow) continue;
      const to = index.get(slashInsensitiveKey(link.url));
      if (to === undefined || to === from) continue;
      // Multiple links from one page to the same target pass equity once, which
      // is closer to how search engines treat repeated nav links.
      if (seen.has(to)) continue;
      seen.add(to);
      outgoing[from]?.push(to);
    }
  }

  let rank = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array<number>(n).fill(0);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      const outs = outgoing[i] as number[];
      const r = rank[i] as number;
      if (outs.length === 0) {
        danglingMass += r;
        continue;
      }
      const share = r / outs.length;
      for (const j of outs) next[j] = (next[j] as number) + share;
    }
    // Dangling mass is redistributed so the raw vector stays a proper
    // probability distribution (it sums to 1; discarding the mass leaves it
    // summing to as little as 0.15). Worth knowing: this term cannot change the
    // *normalised* output. Both fixed points have the form r = a·(I − dMᵀ)⁻¹·1,
    // differing only in the scalar a, and proportional vectors normalise to
    // identical values — verified across four graph shapes, max difference 0.000.
    // So don't write a test asserting redistribution changes a score, and don't
    // delete this on the grounds that no test covers it.
    const base = (1 - damping) / n + (damping * danglingMass) / n;
    for (let i = 0; i < n; i++) next[i] = base + damping * (next[i] as number);
    rank = next;
  }

  // Normalise to 0-100 against the strongest page so the numbers are readable
  // and comparable across crawls of different sizes.
  const max = Math.max(...rank);
  const out = new Map<string, number>();
  urls.forEach((u, i) => {
    const page = keyed.get(u) as PageData;
    out.set(page.url, max > 0 ? round(((rank[i] as number) / max) * 100, 2) : 0);
  });
  return out;
}

export function analyzeLinkGraph(pages: PageData[]): LinkGraphReport {
  const htmlPages = pages.filter((p) => !p.error && p.status >= 200 && p.status < 300);
  const pageRank = computePageRank(htmlPages);

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const byKey = new Map(htmlPages.map((p) => [slashInsensitiveKey(p.url), p]));
  let totalLinks = 0;

  for (const p of htmlPages) {
    const distinct = new Set<string>();
    for (const l of p.links) {
      if (!l.internal) continue;
      const key = slashInsensitiveKey(l.url);
      if (key === slashInsensitiveKey(p.url)) continue;
      distinct.add(key);
    }
    outDegree.set(p.url, distinct.size);
    totalLinks += distinct.size;
    for (const key of distinct) {
      const target = byKey.get(key);
      if (!target) continue;
      inDegree.set(target.url, (inDegree.get(target.url) ?? 0) + 1);
    }
  }

  const nodes: LinkGraphNode[] = htmlPages.map((p) => ({
    url: p.url,
    title: p.title,
    depth: p.depth,
    in_degree: inDegree.get(p.url) ?? 0,
    out_degree: outDegree.get(p.url) ?? 0,
    page_rank: pageRank.get(p.url) ?? 0,
    word_count: p.word_count,
    indexable: !(p.meta_robots && /\bnoindex\b/i.test(p.meta_robots)),
  }));
  nodes.sort((a, b) => b.page_rank - a.page_rank);

  const indexableNodes = nodes.filter((n) => n.indexable && n.word_count >= 100);

  // "Starved" has to mean starved in absolute terms, not merely last in the
  // ranking. On a small, densely interlinked site the bottom decile can still be
  // at 54/100 PageRank with a dozen inbound links — reporting those as starved
  // sends an agent off to fix a non-problem. So require both a bottom-decile
  // position *and* materially less authority than the median page.
  const decileIndex = Math.floor(indexableNodes.length * 0.9);
  const decileThreshold = indexableNodes[decileIndex]?.page_rank ?? 0;
  const medianRank = indexableNodes.length > 0
    ? (indexableNodes[Math.floor(indexableNodes.length / 2)]?.page_rank ?? 0)
    : 0;
  const starvedThreshold = Math.min(decileThreshold, medianRank * 0.5);

  const depthDistribution: Record<string, number> = {};
  for (const n of nodes) {
    const k = `depth_${n.depth}`;
    depthDistribution[k] = (depthDistribution[k] ?? 0) + 1;
  }

  return {
    nodes,
    total_pages: htmlPages.length,
    total_internal_links: totalLinks,
    avg_links_per_page: htmlPages.length > 0 ? round(totalLinks / htmlPages.length, 1) : 0,
    orphans: nodes.filter((n) => n.in_degree === 0 && n.depth > 0).map((n) => n.url),
    starved_pages: indexableNodes
      // Three or fewer inbound links is the practical definition of under-linked,
      // regardless of where the PageRank maths lands.
      .filter((n) => n.page_rank <= starvedThreshold || n.in_degree <= 3)
      .slice(0, 25),
    hub_pages: nodes.filter((n) => n.out_degree > 0).slice(0, 15),
    max_depth: nodes.reduce((m, n) => Math.max(m, n.depth), 0),
    depth_distribution: depthDistribution,
  };
}

// ---------------------------------------------------------------------------
// Link opportunity discovery
// ---------------------------------------------------------------------------

export interface LinkOpportunity {
  /** The page that should gain a link. */
  to_url: string;
  to_title: string | null;
  /** The page that should host the new link. */
  from_url: string;
  from_title: string | null;
  /** Suggested anchor text, drawn from the target's own topic. */
  anchor: string;
  /** The sentence on the source page where the phrase already appears. */
  context: string;
  /** 0-100 — how strong the source page is and how well the topics match. */
  score: number;
  reason: string;
}

/**
 * Find pages that already mention a target page's topic but don't link to it.
 *
 * This is the single most useful internal-linking play, and the one that's
 * genuinely tedious by hand: it requires reading every page's body text against
 * every other page's topic. An agent gets it as one call.
 */
export function findLinkOpportunities(
  pages: PageData[],
  opts: { targets?: string[]; maxPerTarget?: number; limit?: number } = {},
): LinkOpportunity[] {
  const htmlPages = pages.filter(
    (p) => !p.error && p.status >= 200 && p.status < 300 && p.word_count >= 80,
  );
  if (htmlPages.length < 2) return [];

  const pageRank = computePageRank(htmlPages);
  const maxPerTarget = opts.maxPerTarget ?? 3;

  const existingLinks = new Map<string, Set<string>>();
  for (const p of htmlPages) {
    existingLinks.set(
      slashInsensitiveKey(p.url),
      new Set(p.links.filter((l) => l.internal).map((l) => slashInsensitiveKey(l.url))),
    );
  }

  // Which pages need help: prefer explicit targets, otherwise the starved ones.
  let targets: PageData[];
  if (opts.targets && opts.targets.length > 0) {
    const wanted = new Set(opts.targets.map(slashInsensitiveKey));
    targets = htmlPages.filter((p) => wanted.has(slashInsensitiveKey(p.url)));
  } else {
    const sorted = [...htmlPages].sort(
      (a, b) => (pageRank.get(a.url) ?? 0) - (pageRank.get(b.url) ?? 0),
    );
    targets = sorted.slice(0, 30);
  }

  const opportunities: LinkOpportunity[] = [];

  for (const target of targets) {
    const phrases = topicPhrases(target);
    if (phrases.length === 0) continue;
    const targetKey = slashInsensitiveKey(target.url);
    let found = 0;

    // Strongest potential sources first: a link from a high-PageRank page is
    // worth several from weak ones.
    const candidates = [...htmlPages].sort((a, b) => (pageRank.get(b.url) ?? 0) - (pageRank.get(a.url) ?? 0));

    for (const source of candidates) {
      if (found >= maxPerTarget) break;
      const sourceKey = slashInsensitiveKey(source.url);
      if (sourceKey === targetKey) continue;
      if (existingLinks.get(sourceKey)?.has(targetKey)) continue;

      for (const phrase of phrases) {
        if (!containsPhrase(source.text, phrase)) continue;
        const context = findSentence(source.text, phrase);
        if (!context) continue;

        const sourceRank = pageRank.get(source.url) ?? 0;
        const overlap = topicOverlap(source, target);
        const score = clamp(sourceRank * 0.45 + overlap * 55, 0, 100);

        opportunities.push({
          to_url: target.url,
          to_title: target.title,
          from_url: source.url,
          from_title: source.title,
          anchor: phrase,
          context: truncate(context, 240),
          score: round(score, 1),
          reason:
            `"${source.title ?? source.url}" already mentions "${phrase}" but does not link to the page about it. ` +
            `Source page internal PageRank is ${round(sourceRank, 1)}/100.`,
        });
        found++;
        break;
      }
    }
  }

  opportunities.sort((a, b) => b.score - a.score);
  return opportunities.slice(0, opts.limit ?? 100);
}

/**
 * Phrases that identify what a page is about, best-first.
 * Title and H1 are the most reliable; a slug is a decent third.
 */
function topicPhrases(page: PageData): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    if (!s) return;
    // Strip the site-name suffix editors append to every title.
    const cleaned = s.split(/\s+[|—–·-]\s+/)[0]?.trim() ?? s.trim();
    const tokens = contentTokens(cleaned);
    // 2-6 content words is the sweet spot: one word matches everything, seven
    // matches nothing.
    if (tokens.length >= 2 && tokens.length <= 6) out.push(cleaned.toLowerCase());
  };
  push(page.h1[0]);
  push(page.title);
  return [...new Set(out)];
}

/** Cosine-ish overlap of the two pages' topical terms, 0-1. */
function topicOverlap(a: PageData, b: PageData): number {
  const ta = new Set(contentTokens(`${a.title ?? ''} ${a.h1.join(' ')}`).map(stem));
  const tb = new Set(contentTokens(`${b.title ?? ''} ${b.h1.join(' ')}`).map(stem));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.sqrt(ta.size * tb.size);
}

/** The sentence containing `phrase`, so the agent knows exactly where to edit. */
function findSentence(text: string, phrase: string): string | null {
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (s.length > 500) continue;
    if (containsPhrase(s, phrase)) return s.trim();
  }
  return null;
}

export function linkGraphToActions(report: LinkGraphReport, opportunities: LinkOpportunity[]): Action[] {
  const actions: Action[] = [];

  if (report.orphans.length > 0) {
    actions.push(
      action({
        id: 'links.orphans_unlinked',
        priority: 'high',
        effort: 'small',
        category: 'internal-links',
        title: `Add internal links to ${report.orphans.length} page(s) with zero inbound links`,
        detail:
          'A page with no inbound internal links receives no internal PageRank and gets crawled rarely or never. ' +
          'Call seo_link_opportunities for specific source pages and anchor text.',
        impact_score: 84,
        evidence: { orphans: report.orphans.slice(0, 15) },
        fix: { type: 'add_internal_link', affected: report.orphans.slice(0, 15) },
      }),
    );
  }

  // Group by target so an agent gets one action per page to improve, each
  // carrying every concrete link it should add.
  const byTarget = new Map<string, LinkOpportunity[]>();
  for (const o of opportunities) {
    const list = byTarget.get(o.to_url);
    if (list) list.push(o);
    else byTarget.set(o.to_url, [o]);
  }

  for (const [target, opps] of [...byTarget].slice(0, 20)) {
    const best = opps[0] as LinkOpportunity;
    actions.push(
      action({
        id: `links.opportunity.${target}`,
        priority: 'medium',
        effort: 'trivial',
        category: 'internal-links',
        title: `Link to ${best.to_title ?? target} from ${opps.length} page(s) that already mention it`,
        detail:
          `These pages contain the phrase "${best.anchor}" in body text without linking to the page about it. ` +
          'Each is a one-line edit with no new content required.',
        target,
        impact_score: round(clamp(50 + best.score * 0.4, 0, 100), 1),
        evidence: {
          links_to_add: opps.slice(0, 5).map((o) => ({
            from: o.from_url,
            anchor: o.anchor,
            context: o.context,
          })),
        },
        fix: {
          type: 'add_internal_link',
          to: target,
          links: opps.slice(0, 5).map((o) => ({ from: o.from_url, anchor: o.anchor, context: o.context })),
        },
      }),
    );
  }

  return actions;
}
