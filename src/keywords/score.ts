import type { Keyword, Intent } from '../core/types.js';
import { clamp, round } from '../core/text.js';
import { INTENT_VALUE } from './intent.js';

/**
 * Opportunity scoring — the number an agent should actually sort by.
 *
 * Volume alone is a trap: it's why so much SEO content targets huge
 * informational terms that never convert and can never be won. This score
 * combines the four things that determine whether writing a page is worth it:
 *
 *   1. How much traffic is available (volume × realistic CTR for the position)
 *   2. How hard it is to get (difficulty, ideally personalised to the domain)
 *   3. How valuable a visitor is (intent, CPC as a market-priced proxy)
 *   4. How close we already are (striking distance beats starting from zero)
 *
 * Point 4 is the one most tools bury and agents most need. Moving a keyword from
 * position 12 to 8 is usually cheaper and faster than ranking a new page at all,
 * so those get scored up hard.
 */

/**
 * Organic CTR by position. Approximate industry averages — the exact figures
 * shift year to year, but the shape (a brutal cliff after ~3, near-zero past
 * page one) is stable and is what drives the scoring.
 */
const CTR_BY_POSITION: number[] = [
  0, 0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.032, 0.028, 0.025,
];

export function ctrForPosition(position: number): number {
  if (position < 1) return 0;
  if (position <= 10) return CTR_BY_POSITION[Math.round(position)] ?? 0.025;
  if (position <= 20) return 0.011;
  if (position <= 30) return 0.005;
  if (position <= 50) return 0.002;
  return 0.0005;
}

/** Expected monthly clicks if we ranked at `position`. */
export function estimateClicks(volume: number, position: number): number {
  return Math.round(volume * ctrForPosition(position));
}

export interface OpportunityInput {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: Intent;
  /** Our current position, if we rank at all. */
  position?: number | null;
  /** Target position to model. Defaults to a realistic 5 rather than 1. */
  targetPosition?: number;
  words?: number;
}

export interface OpportunityScore {
  opportunity: number;
  /** Extra monthly clicks we'd gain by reaching the target position. */
  traffic_upside: number | null;
  /** Monetary value of that upside, using CPC as the price of a click. */
  value_upside: number | null;
  /** Ranks 11-20: already visible, cheapest possible win. */
  striking_distance: boolean;
  reasoning: string;
}

export function scoreOpportunity(input: OpportunityInput): OpportunityScore {
  const target = input.targetPosition ?? 5;
  const current = input.position ?? null;
  const strikingDistance = current !== null && current > 10 && current <= 20;

  // --- traffic component -------------------------------------------------
  let trafficUpside: number | null = null;
  let trafficComponent: number;
  if (input.volume !== null && input.volume > 0) {
    const currentClicks = current !== null ? estimateClicks(input.volume, current) : 0;
    const targetClicks = estimateClicks(input.volume, target);
    trafficUpside = Math.max(0, targetClicks - currentClicks);
    // Log scale: the difference between 10 and 100 extra clicks matters far more
    // than between 5,000 and 5,090.
    trafficComponent = clamp(Math.log10(trafficUpside + 1) * 22, 0, 55);
  } else {
    // No volume data. Fall back on specificity: mid-length phrases are the
    // sweet spot, and we say so rather than pretending to know traffic.
    const words = input.words ?? input.keyword.trim().split(/\s+/).length;
    trafficComponent = words <= 1 ? 26 : words <= 3 ? 30 : words <= 5 ? 24 : 16;
  }

  // --- difficulty component ---------------------------------------------
  const difficulty = input.difficulty ?? 45;
  // Inverted and curved: KD 0-30 is nearly free, 70+ is a wall.
  const difficultyComponent = clamp(25 * (1 - (difficulty / 100) ** 1.5), 0, 25);

  // --- value component ---------------------------------------------------
  const intentValue = INTENT_VALUE[input.intent];
  // CPC is the market's own estimate of a click's worth; cap so one $90 legal
  // keyword doesn't swamp an entire list.
  const cpcSignal = input.cpc !== null ? clamp(Math.log10(input.cpc + 1) / Math.log10(21), 0, 1) : 0;
  const valueComponent = clamp(intentValue * 12 + cpcSignal * 8, 0, 20);

  // --- position bonus ----------------------------------------------------
  let positionBonus = 0;
  let positionNote = 'not currently ranking';
  if (current !== null) {
    if (strikingDistance) {
      positionBonus = 18;
      positionNote = `already at position ${current} — striking distance, cheapest win available`;
    } else if (current <= 3) {
      // Little headroom left; don't waste effort here.
      positionBonus = -8;
      positionNote = `already at position ${current}, limited upside`;
    } else if (current <= 10) {
      positionBonus = 10;
      positionNote = `at position ${current} on page 1, worth pushing higher`;
    } else if (current <= 40) {
      positionBonus = 6;
      positionNote = `at position ${current}, page exists but needs work`;
    } else {
      positionBonus = 1;
      positionNote = `at position ${current}, effectively invisible`;
    }
  }

  const opportunity = clamp(trafficComponent + difficultyComponent + valueComponent + positionBonus, 0, 100);

  const valueUpside =
    trafficUpside !== null && input.cpc !== null ? round(trafficUpside * input.cpc, 2) : null;

  return {
    opportunity: round(opportunity, 1),
    traffic_upside: trafficUpside,
    value_upside: valueUpside,
    striking_distance: strikingDistance,
    reasoning:
      `${input.intent} intent; difficulty ${input.difficulty === null ? 'unknown' : difficulty}; ` +
      `${input.volume === null ? 'volume unknown' : `${input.volume}/mo`}; ${positionNote}` +
      (trafficUpside !== null ? `; ~+${trafficUpside} clicks/mo at position ${target}` : ''),
  };
}

/** Score a whole list in place, returning it sorted by opportunity. */
export function scoreKeywords(
  keywords: Keyword[],
  opts: { targetPosition?: number } = {},
): Keyword[] {
  const scored = keywords.map((k) => {
    const s = scoreOpportunity({
      keyword: k.keyword,
      volume: k.volume,
      difficulty: k.difficulty,
      cpc: k.cpc,
      intent: k.intent,
      position: k.position ?? null,
      ...(opts.targetPosition !== undefined ? { targetPosition: opts.targetPosition } : {}),
      words: k.words,
    });
    return { ...k, opportunity: s.opportunity };
  });
  scored.sort((a, b) => (b.opportunity ?? 0) - (a.opportunity ?? 0) || a.keyword.localeCompare(b.keyword));
  return scored;
}

/**
 * Total traffic value of a keyword set, the way Ahrefs reports "traffic value":
 * what you'd pay in ads for the same clicks.
 */
export function trafficValue(keywords: Keyword[]): { clicks: number; value: number } {
  let clicks = 0;
  let value = 0;
  for (const k of keywords) {
    if (k.volume === null || k.position === null || k.position === undefined) continue;
    const c = estimateClicks(k.volume, k.position);
    clicks += c;
    if (k.cpc !== null) value += c * k.cpc;
  }
  return { clicks, value: round(value, 2) };
}
