import { tryGetDb, nowIso } from './db.js';
import { budgetExceeded } from './errors.js';

/**
 * Provider spend guard.
 *
 * Agents don't feel money. Left alone, a research loop will happily fire 4,000
 * SERP lookups at $0.003 each and the user finds out via their credit card.
 * Every metered call goes through here; when the cap is hit, tools degrade to
 * the free data sources instead of silently burning more.
 */

let cap = Infinity;
let spent = 0;

/**
 * Set the session spend cap. `undefined` means no cap.
 *
 * `0` means spend nothing, and must not be confused with "unset". The original
 * `maxUnits && maxUnits > 0 ? maxUnits : Infinity` treated 0 as falsy, so
 * SEO_AGENT_BUDGET=0 — the obvious way to freeze all paid calls — silently
 * granted *unlimited* spend. A safety flag that inverts its own meaning is worse
 * than no flag, so anything that isn't a usable positive number now blocks
 * rather than opens: negatives clamp to 0, and a malformed value (NaN) is
 * treated as 0 because the user plainly intended a cap and defaulting to
 * unlimited is the one outcome they cannot recover from.
 */
export function configureBudget(maxUnits: number | undefined): void {
  if (maxUnits === undefined) cap = Infinity;
  else if (Number.isFinite(maxUnits)) cap = Math.max(0, maxUnits);
  else cap = 0;
  spent = 0;
}

export function budgetStatus(): { spent: number; cap: number | null; remaining: number | null } {
  return {
    spent: Math.round(spent * 1000) / 1000,
    cap: cap === Infinity ? null : cap,
    remaining: cap === Infinity ? null : Math.max(0, Math.round((cap - spent) * 1000) / 1000),
  };
}

export function canSpend(units: number): boolean {
  return spent + units <= cap;
}

/** Throws BUDGET_EXCEEDED rather than overspending. Call before a metered request. */
export function reserve(units: number): void {
  if (!canSpend(units)) throw budgetExceeded(spent, cap);
}

export function record(provider: string, tool: string, units: number): void {
  spent += units;
  try {
    tryGetDb()
      ?.prepare('INSERT INTO usage (provider, tool, units, at) VALUES (?, ?, ?, ?)')
      .run(provider, tool, units, nowIso());
  } catch {
    // Usage logging is best-effort; never fail a tool call over bookkeeping.
  }
}

export function usageSummary(sinceIso?: string): Array<{ provider: string; calls: number; units: number }> {
  const since = sinceIso ?? new Date(Date.now() - 30 * 86400_000).toISOString();
  const db = tryGetDb();
  if (!db) return [];
  const res = db
    .prepare(
      'SELECT provider, COUNT(*) AS calls, SUM(units) AS units FROM usage WHERE at >= ? GROUP BY provider ORDER BY units DESC',
    )
    .all(since) as Array<{ provider: string; calls: number; units: number }>;
  return res.map((r) => ({ provider: r.provider, calls: Number(r.calls), units: Number(r.units) }));
}
