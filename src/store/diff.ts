import { getDb, rows } from '../core/db.js';
import type { Action, Severity } from '../core/types.js';
import { action } from '../core/envelope.js';
import { invalidInput } from '../core/errors.js';
import { round } from '../core/text.js';
import { getCrawlIssues, getCrawlPageSummaries, type StoredPageSummary } from './index.js';

/**
 * Crawl-over-crawl comparison.
 *
 * The question an agent actually wants answered on a recurring basis isn't
 * "what's wrong with this site" — it asked that last week and already has the
 * backlog. It's "what changed, and did my fixes work". That's this file.
 */

export interface CrawlDiff {
  from_crawl: number;
  to_crawl: number;
  from_date: string;
  to_date: string;
  health_score_before: number | null;
  health_score_after: number | null;
  health_delta: number | null;

  pages: {
    added: string[];
    removed: string[];
    total_before: number;
    total_after: number;
  };

  issues: {
    /** Issues present now that weren't before. Regressions. */
    new: Array<{ rule: string; severity: Severity; url: string; message: string }>;
    /** Issues that were present and are now gone. Wins. */
    resolved: Array<{ rule: string; severity: Severity; url: string }>;
    count_before: number;
    count_after: number;
    by_rule_delta: Array<{ rule: string; before: number; after: number; delta: number }>;
  };

  changed_pages: Array<{
    url: string;
    changes: Array<{ field: string; before: unknown; after: unknown }>;
  }>;
}

interface CrawlMeta {
  id: number;
  started_at: string;
  health_score: number | null;
}

function crawlMeta(id: number): CrawlMeta | null {
  const row = getDb()
    .prepare('SELECT id, started_at, health_score FROM crawls WHERE id = ?')
    .get(id) as CrawlMeta | undefined;
  return row ? { ...row } : null;
}

export function diffCrawls(fromId: number, toId: number, opts: { maxItems?: number } = {}): CrawlDiff {
  const max = opts.maxItems ?? 100;
  const from = crawlMeta(fromId);
  const to = crawlMeta(toId);
  if (!from || !to) {
    // A stale or guessed crawl id is an argument problem, not a bug in this
    // tool. Thrown as a plain Error it surfaced as INTERNAL, whose remedy tells
    // the agent to report a bug — so the agent abandons a call it could have
    // fixed by looking up the right id.
    throw invalidInput(
      `Crawl ${!from ? fromId : toId} does not exist.`,
      'Call seo_crawl_history to list the stored crawls and their ids for this site.',
    );
  }

  const beforePages = getCrawlPageSummaries(fromId);
  const afterPages = getCrawlPageSummaries(toId);
  const beforeByUrl = new Map(beforePages.map((p) => [p.url, p]));
  const afterByUrl = new Map(afterPages.map((p) => [p.url, p]));

  const added = afterPages.filter((p) => !beforeByUrl.has(p.url)).map((p) => p.url);
  const removed = beforePages.filter((p) => !afterByUrl.has(p.url)).map((p) => p.url);

  // Issue identity is (rule, url) — the same rule firing on a different page is
  // a different problem, and the same rule on the same page is the same problem
  // even if the wording of the message changed between versions.
  const beforeIssues = getCrawlIssues(fromId);
  const afterIssues = getCrawlIssues(toId);
  const keyOf = (i: { rule: string; url: string }) => `${i.rule}\u0000${i.url}`;
  const beforeKeys = new Set(beforeIssues.map(keyOf));
  const afterKeys = new Set(afterIssues.map(keyOf));

  const newIssues = afterIssues
    .filter((i) => !beforeKeys.has(keyOf(i)))
    // Errors first: an agent reading a truncated list needs the worst ones.
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, max)
    .map((i) => ({ rule: i.rule, severity: i.severity, url: i.url, message: i.message }));

  const resolved = beforeIssues
    .filter((i) => !afterKeys.has(keyOf(i)))
    .slice(0, max)
    .map((i) => ({ rule: i.rule, severity: i.severity, url: i.url }));

  const ruleCounts = new Map<string, { before: number; after: number }>();
  for (const i of beforeIssues) {
    const e = ruleCounts.get(i.rule) ?? { before: 0, after: 0 };
    e.before++;
    ruleCounts.set(i.rule, e);
  }
  for (const i of afterIssues) {
    const e = ruleCounts.get(i.rule) ?? { before: 0, after: 0 };
    e.after++;
    ruleCounts.set(i.rule, e);
  }
  const byRuleDelta = [...ruleCounts]
    .map(([rule, c]) => ({ rule, before: c.before, after: c.after, delta: c.after - c.before }))
    .filter((r) => r.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const changedPages: CrawlDiff['changed_pages'] = [];
  for (const after of afterPages) {
    const before = beforeByUrl.get(after.url);
    if (!before) continue;
    const changes = comparePage(before, after);
    if (changes.length > 0) changedPages.push({ url: after.url, changes });
  }

  return {
    from_crawl: fromId,
    to_crawl: toId,
    from_date: from.started_at,
    to_date: to.started_at,
    health_score_before: from.health_score,
    health_score_after: to.health_score,
    health_delta:
      from.health_score !== null && to.health_score !== null
        ? round(to.health_score - from.health_score, 1)
        : null,
    pages: {
      added: added.slice(0, max),
      removed: removed.slice(0, max),
      total_before: beforePages.length,
      total_after: afterPages.length,
    },
    issues: {
      new: newIssues,
      resolved,
      count_before: beforeIssues.length,
      count_after: afterIssues.length,
      by_rule_delta: byRuleDelta.slice(0, 40),
    },
    changed_pages: changedPages.slice(0, max),
  };
}

function severityRank(s: Severity): number {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}

function comparePage(
  before: StoredPageSummary,
  after: StoredPageSummary,
): Array<{ field: string; before: unknown; after: unknown }> {
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
  const track = (field: keyof StoredPageSummary) => {
    if (before[field] !== after[field]) {
      changes.push({ field, before: before[field], after: after[field] });
    }
  };
  track('status');
  track('title');
  track('meta_description');
  track('indexable');

  // Small word-count wobble is template noise, not a content change.
  if (Math.abs(after.word_count - before.word_count) > Math.max(30, before.word_count * 0.1)) {
    changes.push({ field: 'word_count', before: before.word_count, after: after.word_count });
  }
  if (before.depth !== after.depth) {
    changes.push({ field: 'depth', before: before.depth, after: after.depth });
  }
  // A meaningful swing in inbound internal links usually means a nav or hub change.
  if (Math.abs(after.internal_links_in - before.internal_links_in) > Math.max(2, before.internal_links_in * 0.25)) {
    changes.push({ field: 'internal_links_in', before: before.internal_links_in, after: after.internal_links_in });
  }
  // Simhash difference on an otherwise unchanged page = the body was rewritten.
  if (before.simhash && after.simhash && before.simhash !== after.simhash) {
    changes.push({ field: 'content_changed', before: true, after: true });
  }
  return changes;
}

/** Turn regressions into actions, so a diff is directly actionable. */
export function diffToActions(diff: CrawlDiff): Action[] {
  const actions: Action[] = [];

  const newErrors = diff.issues.new.filter((i) => i.severity === 'error');
  if (newErrors.length > 0) {
    actions.push(
      action({
        id: 'diff.new_errors',
        priority: 'critical',
        effort: 'small',
        category: 'regression',
        title: `Fix ${newErrors.length} new error-level issue(s) introduced since the last crawl`,
        detail:
          'These did not exist in the previous crawl, so something shipped between the two runs caused them. ' +
          'Recent regressions are usually the cheapest wins available because the cause is fresh.',
        impact_score: 92,
        evidence: {
          examples: newErrors.slice(0, 10).map((i) => ({ rule: i.rule, url: i.url, message: i.message })),
        },
        fix: { type: 'fix_regression', affected: newErrors.slice(0, 10).map((i) => i.url) },
      }),
    );
  }

  if (diff.pages.removed.length > 0) {
    actions.push(
      action({
        id: 'diff.pages_disappeared',
        priority: 'high',
        effort: 'small',
        category: 'regression',
        title: `${diff.pages.removed.length} page(s) present in the previous crawl are now unreachable`,
        detail:
          'Either they were intentionally removed (in which case 301 them so their link equity and rankings transfer), ' +
          'or internal links to them broke and they are now orphaned.',
        impact_score: 80,
        evidence: { removed: diff.pages.removed.slice(0, 15) },
        fix: { type: 'redirect_or_restore', affected: diff.pages.removed.slice(0, 15) },
      }),
    );
  }

  const deindexed = diff.changed_pages.filter((p) =>
    p.changes.some((c) => c.field === 'indexable' && c.before === 1 && c.after === 0),
  );
  if (deindexed.length > 0) {
    actions.push(
      action({
        id: 'diff.deindexed',
        priority: 'critical',
        effort: 'trivial',
        category: 'regression',
        title: `${deindexed.length} page(s) became non-indexable since the last crawl`,
        detail:
          'A page that was indexable and now is not will drop out of search entirely. ' +
          'This is almost always an accidental noindex from a staging config or CMS setting.',
        impact_score: 96,
        evidence: { pages: deindexed.slice(0, 15).map((p) => p.url) },
        fix: { type: 'remove_noindex', affected: deindexed.slice(0, 15).map((p) => p.url) },
      }),
    );
  }

  if (diff.health_delta !== null && diff.health_delta < -5) {
    actions.push(
      action({
        id: 'diff.health_declined',
        priority: 'high',
        effort: 'medium',
        category: 'regression',
        title: `Site health fell ${Math.abs(diff.health_delta)} points`,
        detail:
          `From ${diff.health_score_before} to ${diff.health_score_after}. ` +
          'Work the by_rule_delta list top-down — the rules with the largest positive delta caused the drop.',
        impact_score: 85,
        evidence: { worsened: diff.issues.by_rule_delta.filter((r) => r.delta > 0).slice(0, 10) },
      }),
    );
  }

  return actions;
}

/** Ranking movement between two dates, for the rank-tracking tools. */
export interface RankDiffRow {
  keyword: string;
  before: number | null;
  after: number | null;
  change: number | null;
  url: string | null;
  clicks_before: number | null;
  clicks_after: number | null;
}

export function diffRanks(project: string, fromDate: string, toDate: string, limit = 500): RankDiffRow[] {
  // One snapshot per keyword per date: take the latest within each date, since a
  // day can legitimately contain several checks.
  const result = getDb()
    .prepare(
      `WITH snap AS (
         SELECT keyword, position, url, clicks, substr(checked_at, 1, 10) AS d, checked_at,
                ROW_NUMBER() OVER (PARTITION BY keyword, substr(checked_at, 1, 10) ORDER BY checked_at DESC) AS rn
         FROM ranks
         WHERE project = ? AND substr(checked_at, 1, 10) IN (?, ?)
       ),
       latest AS (SELECT * FROM snap WHERE rn = 1)
       SELECT COALESCE(a.keyword, b.keyword) AS keyword,
              b.position AS before_pos, a.position AS after_pos,
              COALESCE(a.url, b.url) AS url,
              b.clicks AS clicks_before, a.clicks AS clicks_after
       FROM (SELECT * FROM latest WHERE d = ?) a
       FULL OUTER JOIN (SELECT * FROM latest WHERE d = ?) b ON a.keyword = b.keyword
       LIMIT ?`,
    )
    .all(project, fromDate, toDate, toDate, fromDate, limit) as Array<Record<string, unknown>>;

  return rows<Record<string, unknown>>(result).map((r) => {
    const before = r['before_pos'] as number | null;
    const after = r['after_pos'] as number | null;
    return {
      keyword: String(r['keyword']),
      before,
      after,
      change: before !== null && after !== null ? round(before - after, 1) : null,
      url: (r['url'] as string | null) ?? null,
      clicks_before: (r['clicks_before'] as number | null) ?? null,
      clicks_after: (r['clicks_after'] as number | null) ?? null,
    };
  });
}
