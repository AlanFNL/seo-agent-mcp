import { httpFetch, mapLimit } from '../core/http.js';
import { cached, cacheKey, TTL } from '../core/cache.js';

/**
 * Keyword discovery from search-engine autocomplete.
 *
 * This is the load-bearing free data source in the whole toolkit, and it is
 * genuinely good data: autocomplete suggestions are derived from real query
 * logs, ordered by popularity, and available for any language/region without a
 * key. Ahrefs' "Search suggestions" report is the same underlying signal.
 *
 * What autocomplete cannot give us is volume. So the strategy is: mine breadth
 * here for free, then optionally enrich with volume from a metrics provider —
 * and when there's no provider, rank by the signals we *can* observe
 * (suggestion rank, source agreement, modifier commercial value).
 */

export type SuggestEngine = 'google' | 'bing' | 'duckduckgo';

export interface Suggestion {
  keyword: string;
  /** Position in the autocomplete list. Lower means more popular. */
  rank: number;
  engine: SuggestEngine;
  /** The expanded query that produced it, e.g. "crm software f". */
  via: string;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');

/** Question openers. Maps to Ahrefs' "Questions" report and PAA mining. */
export const QUESTION_MODIFIERS = [
  'what', 'what is', 'why', 'how', 'how to', 'how much', 'how many', 'when', 'where',
  'who', 'which', 'can', 'do', 'does', 'is', 'are', 'should', 'will', 'would',
];

/** Prepositions surface long-tail intent that alphabet soup misses. */
export const PREPOSITION_MODIFIERS = ['for', 'with', 'without', 'to', 'in', 'on', 'near', 'like', 'from', 'about', 'vs'];

/** Comparison intent — high commercial value, usually low competition. */
export const COMPARISON_MODIFIERS = ['vs', 'versus', 'or', 'alternative to', 'compared to', 'alternatives'];

/** Commercial and transactional modifiers, the ones that convert. */
export const COMMERCIAL_MODIFIERS = [
  'best', 'top', 'cheap', 'cheapest', 'free', 'buy', 'price', 'pricing', 'cost',
  'review', 'reviews', 'alternatives', 'software', 'tool', 'tools', 'app', 'platform',
  'service', 'agency', 'template', 'templates', 'example', 'examples', 'ideas',
  'checklist', 'guide', 'tutorial', 'course', 'for beginners', 'near me',
];

/**
 * Spanish modifier sets, used when `language` starts with "es".
 *
 * Expanding a Spanish seed with English modifiers produces queries like "best
 * software de fichaje", which autocomplete has nothing useful to say about, so
 * most of the request budget was being spent on noise.
 *
 * Rioplatense terms are folded in rather than kept separate: "cuánto sale" and
 * "en cuotas" cost one request each and are merely dead weight outside
 * Argentina, whereas splitting the sets would mean guessing the country.
 */
export const QUESTION_MODIFIERS_ES = [
  'que es', 'que', 'como', 'como funciona', 'como hago', 'por que', 'para que', 'para que sirve',
  'cuando', 'donde', 'cual', 'cuales', 'cuanto cuesta', 'cuanto sale', 'quien', 'se puede',
];

export const PREPOSITION_MODIFIERS_ES = [
  'para', 'con', 'sin', 'de', 'en', 'cerca de', 'como', 'vs', 'desde', 'sobre',
];

export const COMPARISON_MODIFIERS_ES = [
  'vs', 'o', 'alternativas', 'alternativas a', 'comparado con', 'comparativa', 'diferencia',
];

export const COMMERCIAL_MODIFIERS_ES = [
  'mejor', 'mejores', 'barato', 'baratos', 'gratis', 'comprar', 'precio', 'precios',
  'opiniones', 'resenas', 'alternativas', 'software', 'herramienta', 'herramientas',
  'programa', 'programas', 'plantilla', 'plantillas', 'ejemplos', 'guia', 'tutorial',
  'curso', 'en cuotas', 'online', 'cerca de mi',
];

/** Spanish modifiers that read naturally after the seed rather than before it. */
const ES_SUFFIX_MODIFIERS = new Set([
  'gratis', 'precio', 'precios', 'opiniones', 'resenas', 'online', 'en cuotas', 'cerca de mi',
]);

export function isSpanish(language: string | undefined): boolean {
  return (language ?? '').toLowerCase().startsWith('es');
}

export interface ExpandOptions {
  engines?: SuggestEngine[];
  /** Which expansion strategies to run. Each costs one request per modifier. */
  strategies?: Array<'alphabet' | 'digits' | 'questions' | 'prepositions' | 'comparisons' | 'commercial' | 'plain'>;
  language?: string;
  /** Two-letter country code, lowercase. */
  country?: string;
  concurrency?: number;
  /** Recurse into the top N results of the first pass for deeper long-tail. */
  depth?: number;
  bypassCache?: boolean;
  maxKeywords?: number;
}

/** Exported for testing: pure, and the language branch is easy to get wrong. */
export function buildQueries(
  seed: string,
  strategies: NonNullable<ExpandOptions['strategies']>,
  language?: string,
): string[] {
  const queries = new Set<string>();
  const s = seed.trim().toLowerCase();
  const es = isSpanish(language);
  const questionMods = es ? QUESTION_MODIFIERS_ES : QUESTION_MODIFIERS;
  const prepositionMods = es ? PREPOSITION_MODIFIERS_ES : PREPOSITION_MODIFIERS;
  const comparisonMods = es ? COMPARISON_MODIFIERS_ES : COMPARISON_MODIFIERS;
  const commercialMods = es ? COMMERCIAL_MODIFIERS_ES : COMMERCIAL_MODIFIERS;
  for (const strategy of strategies) {
    switch (strategy) {
      case 'plain':
        queries.add(s);
        break;
      case 'alphabet':
        // Trailing space is what triggers "next word" suggestions rather than
        // completions of the current word — this is the whole trick.
        for (const c of ALPHABET) queries.add(`${s} ${c}`);
        break;
      case 'digits':
        for (const d of DIGITS) queries.add(`${s} ${d}`);
        break;
      case 'questions':
        for (const m of questionMods) queries.add(`${m} ${s}`);
        break;
      case 'prepositions':
        for (const m of prepositionMods) queries.add(`${s} ${m}`);
        break;
      case 'comparisons':
        for (const m of comparisonMods) queries.add(`${s} ${m}`);
        break;
      case 'commercial':
        // The year is computed rather than listed. Hardcoded as '2026' it would
        // have gone stale on 1 January, still spending a request on last year's
        // query while missing the one people are actually typing. The title
        // generators already derived it; this list did not.
        queries.add(`${s} ${new Date().getFullYear()}`);
        for (const m of commercialMods) {
          // "near me" reads naturally as a suffix; the rest as prefixes.
          const suffix = es ? ES_SUFFIX_MODIFIERS.has(m) : m === 'near me' || m === 'for beginners';
          if (suffix) queries.add(`${s} ${m}`);
          else queries.add(`${m} ${s}`);
        }
        break;
    }
  }
  return [...queries];
}

async function fetchSuggestions(
  engine: SuggestEngine,
  query: string,
  language: string,
  country: string,
): Promise<string[]> {
  const key = cacheKey('suggest', { engine, query, language, country });
  const { value } = await cached<string[]>(
    key,
    TTL.suggest,
    async () => {
      const url = suggestUrl(engine, query, language, country);
      const res = await httpFetch(url, { retries: 1, timeoutMs: 8000, maxBytes: 256 * 1024 });
      if (res.status >= 400) return [];
      return parseSuggestions(engine, res.body);
    },
    { source: `suggest:${engine}` },
  );
  return value;
}

function suggestUrl(engine: SuggestEngine, query: string, language: string, country: string): string {
  const q = encodeURIComponent(query);
  switch (engine) {
    case 'google':
      // client=firefox returns the cleanest JSON array of the available formats.
      return `https://suggestqueries.google.com/complete/search?client=firefox&hl=${encodeURIComponent(language)}&gl=${encodeURIComponent(country)}&q=${q}`;
    case 'bing':
      return `https://api.bing.com/osjson.aspx?query=${q}&language=${encodeURIComponent(language)}`;
    case 'duckduckgo':
      return `https://duckduckgo.com/ac/?q=${q}&type=list`;
  }
}

/** All three engines return an OpenSearch-ish array, but not identically. */
export function parseSuggestions(engine: SuggestEngine, body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    const second = parsed[1];
    if (Array.isArray(second)) {
      return second
        .map((x) => {
          if (typeof x === 'string') return x;
          // Google's client=chrome variant nests the phrase in an array.
          if (Array.isArray(x) && typeof x[0] === 'string') return x[0];
          if (x && typeof x === 'object' && 'phrase' in x) return String((x as { phrase: unknown }).phrase);
          return null;
        })
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
    }
    // DuckDuckGo without type=list returns [{phrase: "..."}].
    if (parsed.every((x) => x && typeof x === 'object' && 'phrase' in x)) {
      return parsed.map((x) => String((x as { phrase: unknown }).phrase));
    }
  }
  void engine;
  return [];
}

export interface ExpandResult {
  seed: string;
  suggestions: Suggestion[];
  /** Deduped keyword -> how many engines returned it. Cross-engine agreement is a popularity proxy. */
  agreement: Map<string, number>;
  queries_made: number;
  engines_used: SuggestEngine[];
  errors: number;
}

/**
 * Fan out over engines × strategies and collect every distinct suggestion.
 *
 * With the default strategy set this makes ~90 requests per engine, which the
 * per-host throttle spreads out politely. Everything is cached for a day, so an
 * agent iterating on the same topic pays that cost once.
 */
export async function expandKeyword(seed: string, opts: ExpandOptions = {}): Promise<ExpandResult> {
  const engines = opts.engines ?? ['google'];
  const strategies = opts.strategies ?? ['plain', 'alphabet', 'questions', 'prepositions', 'commercial'];
  const language = opts.language ?? 'en';
  const country = opts.country ?? 'us';
  const maxKeywords = opts.maxKeywords ?? 2000;

  const queries = buildQueries(seed, strategies, opts.language);
  const jobs: Array<{ engine: SuggestEngine; query: string }> = [];
  for (const engine of engines) for (const query of queries) jobs.push({ engine, query });

  const suggestions: Suggestion[] = [];
  const agreement = new Map<string, Set<SuggestEngine>>();
  let errors = 0;

  const results = await mapLimit(jobs, opts.concurrency ?? 4, async (job) => ({
    job,
    items: await fetchSuggestions(job.engine, job.query, language, country),
  }));

  for (const r of results) {
    if (!r.ok) {
      errors++;
      continue;
    }
    const { job, items } = r.value;
    items.forEach((kw, i) => {
      const clean = kw.trim().toLowerCase();
      if (!clean) return;
      suggestions.push({ keyword: clean, rank: i, engine: job.engine, via: job.query });
      const set = agreement.get(clean) ?? new Set<SuggestEngine>();
      set.add(job.engine);
      agreement.set(clean, set);
    });
  }

  // Recurse into the strongest results for deeper long-tail. Only 'alphabet' on
  // the second pass — running every strategy again explodes the request count
  // for very little extra coverage.
  const depth = opts.depth ?? 1;
  if (depth > 1) {
    const seen = new Set(suggestions.map((s) => s.keyword));
    const topSeeds = rankSuggestions(suggestions, agreement)
      .slice(0, 10)
      .map((s) => s.keyword)
      .filter((k) => k !== seed.toLowerCase());
    for (const sub of topSeeds) {
      const nested = await expandKeyword(sub, {
        ...opts,
        depth: depth - 1,
        strategies: ['alphabet'],
        maxKeywords: Math.max(0, maxKeywords - seen.size),
      });
      for (const s of nested.suggestions) {
        if (seen.has(s.keyword)) continue;
        seen.add(s.keyword);
        suggestions.push(s);
        const set = agreement.get(s.keyword) ?? new Set<SuggestEngine>();
        set.add(s.engine);
        agreement.set(s.keyword, set);
      }
      if (seen.size >= maxKeywords) break;
    }
  }

  return {
    seed,
    suggestions,
    agreement: new Map([...agreement].map(([k, v]) => [k, v.size])),
    queries_made: jobs.length,
    engines_used: engines,
    errors,
  };
}

/**
 * Order suggestions without volume data.
 *
 * Signal, in order of weight: how high autocomplete ranked it (a direct
 * popularity proxy), how many engines agree on it, and how many distinct
 * expansions surfaced it.
 */
export function rankSuggestions(
  suggestions: Suggestion[],
  agreement: Map<string, number | Set<SuggestEngine>>,
): Array<{ keyword: string; score: number; best_rank: number; engines: number; hits: number }> {
  const grouped = new Map<string, { bestRank: number; hits: number }>();
  for (const s of suggestions) {
    const g = grouped.get(s.keyword);
    if (g) {
      g.bestRank = Math.min(g.bestRank, s.rank);
      g.hits++;
    } else {
      grouped.set(s.keyword, { bestRank: s.rank, hits: 1 });
    }
  }
  const out = [...grouped].map(([keyword, g]) => {
    const a = agreement.get(keyword);
    const engines = typeof a === 'number' ? a : (a?.size ?? 1);
    // Rank 0 is worth much more than rank 9; decay accordingly.
    const rankScore = 1 / (1 + g.bestRank);
    const score = rankScore * 60 + engines * 15 + Math.min(g.hits, 10) * 2.5;
    return { keyword, score: Math.round(score * 100) / 100, best_rank: g.bestRank, engines, hits: g.hits };
  });
  out.sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword));
  return out;
}
