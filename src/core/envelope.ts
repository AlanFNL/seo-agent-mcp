import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Action, Envelope, EnvelopeMeta, Priority, Effort } from './types.js';
import { tryGetDb, nowIso } from './db.js';
import { shortHash } from './text.js';
import { loadConfig } from '../config.js';

/**
 * Response construction.
 *
 * Two rules drive everything here:
 *
 * 1. Never blow the agent's context. A 5,000-page crawl serialised inline is
 *    tens of thousands of tokens the agent didn't ask for and can't skim. Large
 *    result sets are written to disk and replaced with a summary plus a handle.
 * 2. Always answer "so what?". Raw metrics make an agent do a second reasoning
 *    pass to figure out what matters. `actions` does that pass up front.
 */

export interface BuildOptions {
  summary: string;
  actions?: Action[];
  warnings?: string[];
  meta?: Partial<EnvelopeMeta>;
  startedAt?: number;
}

export function ok<T>(tool: string, data: T, opts: BuildOptions): Envelope<T> {
  const actions = opts.actions ? rankActions(opts.actions) : undefined;
  return {
    ok: true,
    tool,
    summary: opts.summary,
    data,
    ...(actions && actions.length > 0 ? { actions } : {}),
    meta: {
      cached: false,
      took_ms: opts.startedAt ? Date.now() - opts.startedAt : 0,
      ...opts.meta,
    },
    ...(opts.warnings && opts.warnings.length > 0 ? { warnings: opts.warnings } : {}),
  };
}

export function fail(
  tool: string,
  error: { code: string; message: string; remedy: string; details?: Record<string, unknown> },
  startedAt?: number,
): Envelope<{ error: typeof error }> {
  return {
    ok: false,
    tool,
    summary: `${error.code}: ${error.message}`,
    data: { error },
    meta: { cached: false, took_ms: startedAt ? Date.now() - startedAt : 0 },
  };
}

const PRIORITY_WEIGHT: Record<Priority, number> = {
  critical: 1000,
  high: 500,
  medium: 200,
  low: 50,
};
const EFFORT_DIVISOR: Record<Effort, number> = {
  trivial: 1,
  small: 1.4,
  medium: 2.2,
  large: 4,
};

/**
 * Sort actions the way a competent SEO would work a backlog: severity first,
 * then payoff per unit of effort. An agent executing top-down should be doing
 * the most valuable cheap things before the expensive speculative ones.
 */
export function rankActions(actions: Action[]): Action[] {
  const seen = new Set<string>();
  const deduped = actions.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  return deduped.sort((a, b) => {
    const sa = (PRIORITY_WEIGHT[a.priority] + a.impact_score) / EFFORT_DIVISOR[a.effort];
    const sb = (PRIORITY_WEIGHT[b.priority] + b.impact_score) / EFFORT_DIVISOR[b.effort];
    if (sb !== sa) return sb - sa;
    return a.id.localeCompare(b.id);
  });
}

export function action(a: Omit<Action, 'id'> & { id?: string }): Action {
  const id =
    a.id ?? `${a.category}.${shortHash(`${a.category}|${a.title}|${a.target ?? ''}`)}`;
  return { ...a, id };
}

export interface Spilled<T> {
  rows: T[];
  meta: Pick<EnvelopeMeta, 'truncated' | 'total_available' | 'returned' | 'artifact'>;
}

/**
 * Cap an inline array, writing the full set to an artifact file when it
 * overflows so nothing is actually lost — the agent can read the file if it
 * genuinely needs all 4,000 rows.
 */
export function spill<T>(tool: string, all: T[], limit?: number): Spilled<T> {
  const cfg = loadConfig();
  const cap = limit ?? cfg.maxInlineRows;
  if (all.length <= cap) {
    return { rows: all, meta: { truncated: false, total_available: all.length, returned: all.length } };
  }
  const id = `${tool}-${shortHash(`${tool}${all.length}${nowIso()}`)}`;
  let artifactPath: string | undefined;
  try {
    mkdirSync(cfg.artifactDir, { recursive: true });
    artifactPath = join(cfg.artifactDir, `${id}.json`);
    writeFileSync(artifactPath, JSON.stringify(all, null, 2), 'utf8');
    tryGetDb()
      ?.prepare('INSERT OR REPLACE INTO artifacts (id, tool, path, rows, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, tool, artifactPath, all.length, nowIso());
  } catch {
    // If we can't write the artifact we still return the truncated rows rather
    // than failing the call — partial data is more useful than an error.
    artifactPath = undefined;
  }
  return {
    rows: all.slice(0, cap),
    meta: {
      truncated: true,
      total_available: all.length,
      returned: cap,
      ...(artifactPath ? { artifact: artifactPath } : {}),
    },
  };
}

/** Render an envelope as the JSON text an MCP tool returns. */
export function toToolResult<T>(env: Envelope<T>): string {
  return JSON.stringify(env, jsonSafe, 2);
}

/** BigInt (simhash) and Map/Set values would otherwise throw during serialisation. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
