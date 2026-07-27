import type { Action } from '../core/types.js';
import type { GscRow } from '../providers/gsc.js';
import { action } from '../core/envelope.js';
import { round, clamp } from '../core/text.js';
import { ctrForPosition } from '../keywords/score.js';
import { classifyIntent } from '../keywords/intent.js';

/**
 * Turning Search Console data into decisions.
 *
 * Raw GSC rows are just numbers. These five analyses are the ones that reliably
 * find money, and every one of them is a mechanical pattern an agent can execute
 * without judgement — which is precisely why they belong in a tool rather than
 * in a prompt:
 *
 *   1. Striking distance   — ranked 11-20, one good push from page one.
 *   2. CTR underperformers — ranking well but nobody clicks; a title problem.
 *   3. Cannibalisation     — several of our pages competing for one query.
 *   4. Decay               — pages that used to earn clicks and no longer do.
 *   5. Rising queries      — growing impressions we don't yet rank for properly.
 */

export interface StrikingDistanceRow {
  query: string;
  page: string | null;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  /** Clicks we'd gain at position 5, using standard CTR curves. */
  potential_clicks: number;
  potential_gain: number;
  intent: string;
}

/**
 * Queries sitting just off page one.
 *
 * The highest-ROI report in SEO: the page already exists, Google already
 * considers it relevant, and the gap to page one is usually a title rewrite,
 * some internal links, or a section the competitors have and we don't.
 */
export function findStrikingDistance(
  rows: GscRow[],
  opts: { minPosition?: number; maxPosition?: number; minImpressions?: number; limit?: number } = {},
): StrikingDistanceRow[] {
  const minPos = opts.minPosition ?? 8;
  const maxPos = opts.maxPosition ?? 25;
  const minImpressions = opts.minImpressions ?? 30;

  const out: StrikingDistanceRow[] = [];
  for (const r of rows) {
    const query = r.keys[0];
    if (!query) continue;
    if (r.position < minPos || r.position > maxPos) continue;
    if (r.impressions < minImpressions) continue;

    const potential = Math.round(r.impressions * ctrForPosition(5));
    const gain = Math.max(0, potential - r.clicks);
    if (gain <= 0) continue;

    out.push({
      query,
      page: r.keys[1] ?? null,
      position: round(r.position, 1),
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: round(r.ctr * 100, 2),
      potential_clicks: potential,
      potential_gain: gain,
      intent: classifyIntent(query).intent,
    });
  }
  out.sort((a, b) => b.potential_gain - a.potential_gain);
  return out.slice(0, opts.limit ?? 100);
}

export interface CtrOpportunity {
  query: string;
  page: string | null;
  position: number;
  impressions: number;
  clicks: number;
  actual_ctr: number;
  expected_ctr: number;
  /** How far below the position-normal CTR we are, in percentage points. */
  ctr_gap: number;
  potential_gain: number;
}

/**
 * Pages that rank well but get clicked far less than their position predicts.
 *
 * Almost always a title or meta description problem, which makes it the cheapest
 * fix in SEO — no new content, no links, just better copy. Comparing against a
 * position-normalised expected CTR is what separates a real problem from
 * "position 9 gets few clicks, obviously".
 */
export function findCtrOpportunities(
  rows: GscRow[],
  opts: { minImpressions?: number; maxPosition?: number; minGapRatio?: number; limit?: number } = {},
): CtrOpportunity[] {
  const minImpressions = opts.minImpressions ?? 100;
  const maxPosition = opts.maxPosition ?? 10;
  // Only flag when actual CTR is below 60% of expected — small shortfalls are noise.
  const minGapRatio = opts.minGapRatio ?? 0.6;

  const out: CtrOpportunity[] = [];
  for (const r of rows) {
    const query = r.keys[0];
    if (!query) continue;
    if (r.impressions < minImpressions || r.position > maxPosition) continue;

    const expected = ctrForPosition(Math.round(r.position));
    if (expected <= 0) continue;
    if (r.ctr >= expected * minGapRatio) continue;

    const potential = Math.round(r.impressions * expected);
    out.push({
      query,
      page: r.keys[1] ?? null,
      position: round(r.position, 1),
      impressions: r.impressions,
      clicks: r.clicks,
      actual_ctr: round(r.ctr * 100, 2),
      expected_ctr: round(expected * 100, 2),
      ctr_gap: round((expected - r.ctr) * 100, 2),
      potential_gain: Math.max(0, potential - r.clicks),
    });
  }
  out.sort((a, b) => b.potential_gain - a.potential_gain);
  return out.slice(0, opts.limit ?? 50);
}

export interface Cannibalization {
  query: string;
  total_impressions: number;
  pages: Array<{ page: string; position: number; clicks: number; impressions: number }>;
  /** The page Google favours most often — the one to consolidate onto. */
  primary_page: string;
  severity: 'high' | 'medium' | 'low';
}

/**
 * Multiple pages of ours competing for the same query.
 *
 * Google picks one and the others dilute the signal. Requires the query+page
 * dimension pair, which is why this takes two-dimensional rows.
 */
export function findCannibalization(
  rows: GscRow[],
  opts: { minImpressions?: number; minPages?: number; limit?: number } = {},
): Cannibalization[] {
  const minImpressions = opts.minImpressions ?? 50;
  const minPages = opts.minPages ?? 2;

  const byQuery = new Map<string, Array<{ page: string; position: number; clicks: number; impressions: number }>>();
  for (const r of rows) {
    const query = r.keys[0];
    const page = r.keys[1];
    if (!query || !page) continue;
    const list = byQuery.get(query) ?? [];
    list.push({ page, position: round(r.position, 1), clicks: r.clicks, impressions: r.impressions });
    byQuery.set(query, list);
  }

  const out: Cannibalization[] = [];
  for (const [query, pages] of byQuery) {
    if (pages.length < minPages) continue;
    const total = pages.reduce((s, p) => s + p.impressions, 0);
    if (total < minImpressions) continue;

    // Only genuinely competing pages count: a page that appears for a query a
    // handful of times isn't cannibalising, it's noise.
    const meaningful = pages.filter((p) => p.impressions >= total * 0.1);
    if (meaningful.length < minPages) continue;

    meaningful.sort((a, b) => a.position - b.position);
    const best = meaningful[0] as (typeof meaningful)[number];

    // Severity tracks how evenly split the impressions are — an even split means
    // Google genuinely can't decide, which is the damaging case.
    //
    // Note the scale: with two competing pages the top share can never fall
    // below 0.5, so a `< 0.5` bar for "high" could only ever be met by three or
    // more pages. A 56/44 split is Google flip-flopping between two pages and
    // deserves the same urgency, hence 0.65.
    const topShare = best.impressions / total;
    const severity: Cannibalization['severity'] =
      meaningful.length >= 3 || topShare < 0.65 ? 'high' : topShare < 0.85 ? 'medium' : 'low';

    out.push({
      query,
      total_impressions: total,
      pages: meaningful,
      primary_page: best.page,
      severity,
    });
  }

  out.sort((a, b) => b.total_impressions - a.total_impressions);
  return out.slice(0, opts.limit ?? 50);
}

export interface DecayRow {
  page: string;
  clicks_before: number;
  clicks_after: number;
  change: number;
  change_pct: number;
  impressions_before: number;
  impressions_after: number;
  position_before: number;
  position_after: number;
  /** Distinguishes "we lost rankings" from "the query dried up". */
  likely_cause: 'lost_rankings' | 'lost_impressions' | 'lost_ctr' | 'mixed';
}

/**
 * Pages that earned clicks in an earlier period and don't now.
 *
 * Content decay is the most under-served problem in SEO because nobody goes
 * looking for it — the page still exists and nothing appears broken. An agent
 * running this weekly catches it automatically.
 */
export function findDecay(
  before: GscRow[],
  after: GscRow[],
  opts: { minClicksBefore?: number; minDropPct?: number; limit?: number } = {},
): DecayRow[] {
  const minClicks = opts.minClicksBefore ?? 10;
  const minDrop = opts.minDropPct ?? 20;

  const agg = (rows: GscRow[]) => {
    const m = new Map<string, { clicks: number; impressions: number; positionWeighted: number }>();
    for (const r of rows) {
      const page = r.keys[0];
      if (!page) continue;
      const e = m.get(page) ?? { clicks: 0, impressions: 0, positionWeighted: 0 };
      e.clicks += r.clicks;
      e.impressions += r.impressions;
      // Weight position by impressions so a high-volume query dominates the average.
      e.positionWeighted += r.position * r.impressions;
      m.set(page, e);
    }
    return m;
  };

  const b = agg(before);
  const a = agg(after);

  const out: DecayRow[] = [];
  for (const [page, bv] of b) {
    if (bv.clicks < minClicks) continue;
    const av = a.get(page) ?? { clicks: 0, impressions: 0, positionWeighted: 0 };
    const change = av.clicks - bv.clicks;
    const changePct = bv.clicks > 0 ? (change / bv.clicks) * 100 : 0;
    if (changePct > -minDrop) continue;

    const posBefore = bv.impressions > 0 ? bv.positionWeighted / bv.impressions : 0;
    const posAfter = av.impressions > 0 ? av.positionWeighted / av.impressions : 0;

    const positionWorse = posAfter > posBefore + 1.5;
    const impressionsDown = av.impressions < bv.impressions * 0.8;
    let cause: DecayRow['likely_cause'];
    if (positionWorse && impressionsDown) cause = 'mixed';
    else if (positionWorse) cause = 'lost_rankings';
    else if (impressionsDown) cause = 'lost_impressions';
    else cause = 'lost_ctr';

    out.push({
      page,
      clicks_before: bv.clicks,
      clicks_after: av.clicks,
      change,
      change_pct: round(changePct, 1),
      impressions_before: bv.impressions,
      impressions_after: av.impressions,
      position_before: round(posBefore, 1),
      position_after: round(posAfter, 1),
      likely_cause: cause,
    });
  }

  out.sort((a2, b2) => a2.change - b2.change);
  return out.slice(0, opts.limit ?? 50);
}

export interface RisingQuery {
  query: string;
  impressions_before: number;
  impressions_after: number;
  growth_pct: number;
  position: number;
  clicks: number;
  /** True when impressions are growing but we rank too poorly to benefit. */
  untapped: boolean;
}

/** Queries with fast-growing impressions — trends worth getting ahead of. */
export function findRisingQueries(
  before: GscRow[],
  after: GscRow[],
  opts: { minImpressionsAfter?: number; minGrowthPct?: number; limit?: number } = {},
): RisingQuery[] {
  const minImpressions = opts.minImpressionsAfter ?? 50;
  const minGrowth = opts.minGrowthPct ?? 30;

  const b = new Map<string, number>();
  for (const r of before) {
    const q = r.keys[0];
    if (q) b.set(q, (b.get(q) ?? 0) + r.impressions);
  }

  const out: RisingQuery[] = [];
  for (const r of after) {
    const q = r.keys[0];
    if (!q || r.impressions < minImpressions) continue;
    const prev = b.get(q) ?? 0;
    // A brand-new query counts as 100% growth rather than dividing by zero.
    const growth = prev > 0 ? ((r.impressions - prev) / prev) * 100 : 100;
    if (growth < minGrowth) continue;
    out.push({
      query: q,
      impressions_before: prev,
      impressions_after: r.impressions,
      growth_pct: round(growth, 1),
      position: round(r.position, 1),
      clicks: r.clicks,
      untapped: r.position > 10,
    });
  }
  out.sort((x, y) => y.impressions_after * (y.growth_pct / 100) - x.impressions_after * (x.growth_pct / 100));
  return out.slice(0, opts.limit ?? 40);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface GscInsights {
  striking_distance: StrikingDistanceRow[];
  ctr_opportunities: CtrOpportunity[];
  cannibalization: Cannibalization[];
  decay: DecayRow[];
  rising: RisingQuery[];
}

export function gscInsightsToActions(insights: GscInsights): Action[] {
  const actions: Action[] = [];

  const sd = insights.striking_distance;
  if (sd.length > 0) {
    const totalGain = sd.reduce((s, r) => s + r.potential_gain, 0);
    // One action per page, not per keyword: the fix is "improve this page".
    const byPage = new Map<string, StrikingDistanceRow[]>();
    for (const r of sd.slice(0, 40)) {
      const key = r.page ?? '(unknown page)';
      const list = byPage.get(key);
      if (list) list.push(r);
      else byPage.set(key, [r]);
    }
    for (const [page, queries] of [...byPage].slice(0, 12)) {
      const gain = queries.reduce((s, q) => s + q.potential_gain, 0);
      const best = queries[0] as StrikingDistanceRow;
      actions.push(
        action({
          id: `gsc.striking.${page}`,
          priority: gain > 100 ? 'critical' : gain > 30 ? 'high' : 'medium',
          effort: 'small',
          category: 'rankings',
          title: `Push ${page === '(unknown page)' ? `"${best.query}"` : page} onto page one — about +${gain} clicks/mo available`,
          detail:
            `Ranks at position ${best.position} for ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} with real impression volume. ` +
            'The page already has relevance; it needs a stronger title targeting the exact query, more internal links, ' +
            'and whatever subtopics the current top 5 cover that it does not. Run seo_content_brief on the top query.',
          target: page !== '(unknown page)' ? page : best.query,
          impact_score: round(clamp(45 + Math.log10(gain + 1) * 18, 0, 100), 1),
          evidence: {
            queries: queries.slice(0, 8).map((q) => ({
              query: q.query,
              position: q.position,
              impressions: q.impressions,
              potential_gain: q.potential_gain,
            })),
            total_potential_clicks: gain,
          },
          fix: { type: 'optimize_existing_page', target_keyword: best.query, to: page },
        }),
      );
    }
    void totalGain;
  }

  for (const c of insights.ctr_opportunities.slice(0, 10)) {
    actions.push(
      action({
        id: `gsc.ctr.${c.page ?? c.query}`,
        priority: c.potential_gain > 50 ? 'high' : 'medium',
        effort: 'trivial',
        category: 'on-page',
        title: `Rewrite the title/meta for "${c.query}" — CTR is ${c.actual_ctr}% vs ${c.expected_ctr}% expected at position ${c.position}`,
        detail:
          `${c.impressions} impressions producing only ${c.clicks} clicks. At the normal click-through rate for position ` +
          `${c.position} this would be about ${c.clicks + c.potential_gain}. The ranking is fine — the snippet is not ` +
          'earning the click. Make the title match the query wording more directly and give the description a concrete benefit.',
        target: c.page ?? c.query,
        impact_score: round(clamp(40 + Math.log10(c.potential_gain + 1) * 20, 0, 95), 1),
        evidence: {
          query: c.query,
          position: c.position,
          impressions: c.impressions,
          actual_ctr: c.actual_ctr,
          expected_ctr: c.expected_ctr,
          potential_gain: c.potential_gain,
        },
        fix: { type: 'rewrite_title_and_meta', target_keyword: c.query, to: c.page ?? '' },
      }),
    );
  }

  for (const c of insights.cannibalization.filter((x) => x.severity !== 'low').slice(0, 8)) {
    actions.push(
      action({
        id: `gsc.cannibal.${c.query}`,
        priority: c.severity === 'high' ? 'high' : 'medium',
        effort: 'medium',
        category: 'content',
        title: `Resolve ${c.pages.length} pages competing for "${c.query}"`,
        detail:
          `Google is splitting ${c.total_impressions} impressions across ${c.pages.length} of your pages. ` +
          `Consolidate onto ${c.primary_page} (currently the strongest at position ${c.pages[0]?.position}), ` +
          '301 the weaker ones, and re-point their internal links. Or differentiate them onto genuinely distinct queries.',
        target: c.primary_page,
        impact_score: round(clamp(45 + Math.log10(c.total_impressions + 1) * 12, 0, 92), 1),
        evidence: { query: c.query, pages: c.pages, severity: c.severity },
        fix: { type: 'consolidate_pages', to: c.primary_page, from_pages: c.pages.slice(1).map((p) => p.page) },
      }),
    );
  }

  for (const d of insights.decay.slice(0, 8)) {
    actions.push(
      action({
        id: `gsc.decay.${d.page}`,
        priority: d.change < -100 ? 'high' : 'medium',
        effort: 'medium',
        category: 'content',
        title: `Refresh ${d.page} — clicks fell ${Math.abs(d.change_pct)}% (${d.clicks_before} → ${d.clicks_after})`,
        detail: decayAdvice(d),
        target: d.page,
        impact_score: round(clamp(40 + Math.log10(Math.abs(d.change) + 1) * 18, 0, 95), 1),
        evidence: d as unknown as Record<string, unknown>,
        fix: { type: 'refresh_content', to: d.page },
      }),
    );
  }

  for (const r of insights.rising.filter((x) => x.untapped).slice(0, 6)) {
    actions.push(
      action({
        id: `gsc.rising.${r.query}`,
        priority: 'medium',
        effort: 'large',
        category: 'content',
        title: `Build a dedicated page for the rising query "${r.query}" (+${r.growth_pct}% impressions)`,
        detail:
          `Impressions grew from ${r.impressions_before} to ${r.impressions_after} but the site only ranks at position ` +
          `${r.position}, so almost none of that demand converts to clicks. Growing queries are easier to win early. ` +
          'Run seo_content_brief on it before writing.',
        target: r.query,
        impact_score: round(clamp(38 + Math.log10(r.impressions_after + 1) * 14, 0, 88), 1),
        evidence: r as unknown as Record<string, unknown>,
        fix: { type: 'create_page', target_keyword: r.query },
      }),
    );
  }

  return actions;
}

function decayAdvice(d: DecayRow): string {
  switch (d.likely_cause) {
    case 'lost_rankings':
      return (
        `Average position slipped from ${d.position_before} to ${d.position_after} while impressions held up, so competitors ` +
        'overtook this page rather than demand disappearing. Refresh the content against what now ranks, and add internal links.'
      );
    case 'lost_impressions':
      return (
        `Position held (${d.position_before} → ${d.position_after}) but impressions fell from ${d.impressions_before} to ` +
        `${d.impressions_after}. That is falling demand or a SERP layout change (an AI overview or new feature pushing organic down), ` +
        'not a quality problem. Check whether the topic is seasonal before investing.'
      );
    case 'lost_ctr':
      return (
        'Position and impressions are stable but clicks fell, so the snippet stopped earning the click — often a new SERP feature ' +
        'above you or a competitor with a sharper title. Rewrite the title and description.'
      );
    default:
      return (
        `Both position (${d.position_before} → ${d.position_after}) and impressions (${d.impressions_before} → ${d.impressions_after}) ` +
        'declined. Treat this as a full content refresh: re-check search intent, then rewrite against the current top results.'
      );
  }
}
