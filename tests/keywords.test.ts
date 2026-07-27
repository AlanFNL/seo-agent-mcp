import { describe, it, expect } from 'vitest';
import { classifyIntent, isQuestion, INTENT_VALUE } from '../src/keywords/intent.js';
import { difficultyFromLexical, difficultyFromSerp, personalizeDifficulty } from '../src/keywords/difficulty.js';
import { scoreOpportunity, ctrForPosition, estimateClicks, scoreKeywords } from '../src/keywords/score.js';
import { clusterByLexical, clusterBySerp, toKeywords, recommendPageType, clusterPageSpec } from '../src/keywords/cluster.js';
import { parseSuggestions, buildQueries } from '../src/keywords/suggest.js';
import type { SerpData } from '../src/core/types.js';
import { COMMERCIAL_MODIFIERS, COMMERCIAL_MODIFIERS_ES, QUESTION_MODIFIERS, QUESTION_MODIFIERS_ES } from '../src/keywords/suggest.js';

describe('classifyIntent', () => {
  it('recognises transactional intent', () => {
    expect(classifyIntent('buy crm software').intent).toBe('transactional');
    expect(classifyIntent('crm software pricing').intent).toBe('transactional');
  });

  it('recognises commercial investigation', () => {
    expect(classifyIntent('best crm software').intent).toBe('commercial');
    expect(classifyIntent('hubspot vs salesforce').intent).toBe('commercial');
  });

  it('recognises informational intent', () => {
    expect(classifyIntent('what is a crm').intent).toBe('informational');
    expect(classifyIntent('how to set up a sales pipeline').intent).toBe('informational');
  });

  it('lets a brand term override everything else', () => {
    const r = classifyIntent('best acmecorp pricing', ['acmecorp']);
    expect(r.intent).toBe('navigational');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('breaks the commercial/informational tie toward commercial for "best X"', () => {
    // "best" is commercial, "software" is commercial, but "guide"-ish words
    // could pull it informational — the commercial read is the right one.
    expect(classifyIntent('best project management software').intent).toBe('commercial');
  });

  it('reports low confidence when nothing matches', () => {
    const r = classifyIntent('zorbulax quimtrell');
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('values transactional clicks above informational ones', () => {
    expect(INTENT_VALUE.transactional).toBeGreaterThan(INTENT_VALUE.informational);
  });
});

describe('isQuestion', () => {
  it('detects question forms', () => {
    expect(isQuestion('how to rank on google')).toBe(true);
    expect(isQuestion('what is seo')).toBe(true);
    expect(isQuestion('is seo dead?')).toBe(true);
  });

  it('does not treat statements as questions', () => {
    expect(isQuestion('best seo tools')).toBe(false);
  });
});

describe('difficulty', () => {
  it('rates long-tail keywords easier than head terms (lexical)', () => {
    const head = difficultyFromLexical('crm');
    const tail = difficultyFromLexical('how to migrate crm data from spreadsheets');
    expect(tail.difficulty).toBeLessThan(head.difficulty);
  });

  it('labels the lexical estimate as low confidence so agents do not over-trust it', () => {
    const est = difficultyFromLexical('best crm');
    expect(est.method).toBe('lexical');
    expect(est.confidence).toBeLessThan(0.5);
    expect(String(est.factors['note'])).toMatch(/no SERP data/i);
  });

  it('stays within 0-100 for pathological inputs', () => {
    for (const kw of ['a', 'x'.repeat(200), 'one two three four five six seven eight']) {
      const d = difficultyFromLexical(kw).difficulty;
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(100);
    }
  });

  const serp = (domains: string[], features: string[] = []): SerpData => ({
    keyword: 'k',
    location: 'United States',
    device: 'desktop',
    results: domains.map((d, i) => ({
      position: i + 1,
      url: `https://${d}/page`,
      title: 't',
      snippet: 's',
      domain: d,
    })),
    features,
    people_also_ask: [],
    related_searches: [],
    fetched_at: '2026-01-01T00:00:00Z',
  });

  it('rates a big-brand SERP harder than a long-tail one', () => {
    const brands = serp(['wikipedia.org', 'amazon.com', 'forbes.com', 'nytimes.com', 'youtube.com']);
    const small = serp(['smallblog.net', 'nichesite.io', 'anotherblog.org', 'tinysite.co', 'indie.dev']);
    expect(difficultyFromSerp(brands).difficulty).toBeGreaterThan(difficultyFromSerp(small).difficulty);
  });

  it('rates a UGC-heavy SERP as more winnable', () => {
    const ugc = serp(['reddit.com', 'quora.com', 'stackoverflow.com', 'blog.io', 'site.com']);
    const editorial = serp(['forbes.com', 'nytimes.com', 'bbc.com', 'site.com', 'blog.io']);
    expect(difficultyFromSerp(ugc).difficulty).toBeLessThan(difficultyFromSerp(editorial).difficulty);
  });

  it('raises confidence and switches method once authority data is available', () => {
    const s = serp(['a.com', 'b.com', 'c.com', 'd.com', 'e.com']);
    const authority = new Map([['a.com', 80], ['b.com', 75], ['c.com', 70], ['d.com', 65], ['e.com', 60]]);
    const withAuth = difficultyFromSerp(s, authority);
    expect(withAuth.method).toBe('serp+authority');
    expect(withAuth.confidence).toBeGreaterThan(difficultyFromSerp(s).confidence);
  });

  it('says an empty SERP is trivially easy but low confidence', () => {
    const est = difficultyFromSerp(serp([]));
    expect(est.difficulty).toBe(0);
    expect(est.confidence).toBeLessThan(0.5);
  });
});

describe('personalizeDifficulty', () => {
  it('makes a hard keyword realistic for a strong domain', () => {
    const weak = personalizeDifficulty(60, 20);
    const strong = personalizeDifficulty(60, 90);
    expect(strong.personal_difficulty).toBeLessThan(weak.personal_difficulty);
    expect(strong.verdict).not.toBe('unrealistic');
  });

  it('falls back to absolute difficulty with no authority, and says so', () => {
    const r = personalizeDifficulty(45, null);
    expect(r.personal_difficulty).toBe(45);
    expect(r.note).toMatch(/No domain authority/i);
  });
});

describe('CTR and opportunity scoring', () => {
  it('models the CTR cliff after position 3', () => {
    expect(ctrForPosition(1)).toBeGreaterThan(ctrForPosition(2));
    expect(ctrForPosition(3)).toBeGreaterThan(ctrForPosition(10));
    expect(ctrForPosition(11)).toBeLessThan(ctrForPosition(10));
    expect(ctrForPosition(100)).toBeLessThan(0.01);
  });

  it('estimates clicks from volume and position', () => {
    expect(estimateClicks(1000, 1)).toBeGreaterThan(estimateClicks(1000, 5));
    expect(estimateClicks(0, 1)).toBe(0);
  });

  it('ranks a striking-distance keyword above an identical one that does not rank', () => {
    const base = { keyword: 'k', volume: 1000, difficulty: 40, cpc: 2, intent: 'commercial' as const };
    const striking = scoreOpportunity({ ...base, position: 14 });
    const absent = scoreOpportunity({ ...base, position: null });
    expect(striking.striking_distance).toBe(true);
    expect(striking.opportunity).toBeGreaterThan(absent.opportunity);
  });

  it('penalises keywords already at the top, where there is little headroom', () => {
    const base = { keyword: 'k', volume: 1000, difficulty: 40, cpc: 2, intent: 'commercial' as const };
    expect(scoreOpportunity({ ...base, position: 2 }).opportunity).toBeLessThan(
      scoreOpportunity({ ...base, position: 8 }).opportunity,
    );
  });

  it('prefers an easier keyword when everything else is equal', () => {
    const base = { keyword: 'k', volume: 500, cpc: 1, intent: 'commercial' as const };
    expect(scoreOpportunity({ ...base, difficulty: 10 }).opportunity).toBeGreaterThan(
      scoreOpportunity({ ...base, difficulty: 85 }).opportunity,
    );
  });

  it('prefers transactional over informational at equal volume and difficulty', () => {
    const base = { keyword: 'k', volume: 500, difficulty: 40, cpc: 1 };
    expect(scoreOpportunity({ ...base, intent: 'transactional' }).opportunity).toBeGreaterThan(
      scoreOpportunity({ ...base, intent: 'informational' }).opportunity,
    );
  });

  it('still produces a usable score with no volume data', () => {
    const s = scoreOpportunity({ keyword: 'some long tail phrase', volume: null, difficulty: null, cpc: null, intent: 'informational' });
    expect(s.opportunity).toBeGreaterThan(0);
    expect(s.traffic_upside).toBeNull();
    expect(s.reasoning).toMatch(/volume unknown/);
  });

  it('sorts a keyword list by opportunity descending', () => {
    const scored = scoreKeywords(
      toKeywords([
        { keyword: 'hard low value', volume: 100, difficulty: 90, cpc: 0.1, intent: 'informational' },
        { keyword: 'easy high value', volume: 2000, difficulty: 10, cpc: 8, intent: 'transactional' },
      ]),
    );
    expect(scored[0]?.keyword).toBe('easy high value');
  });
});

describe('clusterByLexical', () => {
  const keywords = toKeywords([
    'crm software',
    'best crm software',
    'crm software for small business',
    'crm software pricing',
    'email marketing tools',
    'best email marketing tools',
    'email marketing automation',
  ]);

  it('groups related keywords and separates unrelated topics', () => {
    const { clusters } = clusterByLexical(keywords, { minOverlap: 0.5 });
    const crm = clusters.find((c) => c.keywords.some((k) => k.includes('crm')));
    const email = clusters.find((c) => c.keywords.some((k) => k.includes('email')));
    expect(crm).toBeDefined();
    expect(email).toBeDefined();
    expect(crm?.keywords.every((k) => !k.includes('email'))).toBe(true);
    expect(email?.keywords.every((k) => !k.includes('crm'))).toBe(true);
  });

  it('assigns every keyword exactly once', () => {
    const { clusters, unclustered } = clusterByLexical(keywords);
    const assigned = clusters.flatMap((c) => c.keywords);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.length + unclustered.length).toBe(keywords.length);
  });

  it('gives each cluster a head that is one of its own members', () => {
    for (const c of clusterByLexical(keywords).clusters) {
      expect(c.keywords).toContain(c.head);
    }
  });

  it('can keep question keywords out of page clusters', () => {
    const mixed = toKeywords(['crm software', 'what is crm software', 'crm software pricing']);
    const { clusters } = clusterByLexical(mixed, { separateQuestions: true });
    for (const c of clusters) {
      const questions = c.keywords.filter(isQuestion).length;
      expect(questions === 0 || questions === c.keywords.length).toBe(true);
    }
  });

  it('does not collapse a seed-expanded set into one giant cluster', () => {
    // Every keyword from an autocomplete expansion shares the seed's tokens.
    // Weighting all tokens equally makes everything look similar to everything,
    // which on real data put 68 of 76 keywords in a single cluster — not a
    // content plan. IDF weighting discounts the ubiquitous seed terms.
    const seedExpanded = toKeywords([
      'static site generator',
      'best static site generator',
      'best free static site generator',
      'static site generator for blog',
      'static site generator for documentation',
      'is hugo a static site generator',
      'is nextjs a static site generator',
      'is astro a static site generator',
      'how do static site generators work',
      'how to build a static site generator',
      'static site generator vs cms',
      'static site generator python',
      'static site generator rust',
      'fastest static site generator',
      'examples of static site generators',
      'static site generator with cms',
    ]);
    const { clusters } = clusterByLexical(seedExpanded);
    const largest = Math.max(...clusters.map((c) => c.keywords.length));

    expect(clusters.length).toBeGreaterThan(3);
    // No cluster may swallow the majority of the set.
    expect(largest).toBeLessThan(seedExpanded.length * 0.5);

    // The distinct sub-intents must land in different clusters.
    const clusterOf = (kw: string) => clusters.findIndex((c) => c.keywords.includes(kw));
    expect(clusterOf('is hugo a static site generator')).not.toBe(clusterOf('static site generator python'));
    expect(clusterOf('static site generator vs cms')).not.toBe(clusterOf('best free static site generator'));
  });

  it('does not collapse when seed tokens have tiny but non-zero IDF', () => {
    // The subtle version of the same failure. If the seed words appear in *almost*
    // every keyword rather than all of them, their IDF is small but non-zero, so a
    // pure ratio test still passes trivially — on a real 45-keyword expansion this
    // left 37 in one cluster. Distinctive-token gating is what actually fixes it.
    const set = toKeywords([
      'static site generator',
      'which static site generator',
      'what is static site generator',
      'build a static site generator',
      'static site generator for blog',
      'static site generator astro',
      'static site generator python',
      'static site generator rust',
      'is hugo a static site generator',
      'is docusaurus a static site generator',
      'fastest static site generator',
      'static site generator examples',
      'how do static site generators work',
      // One entry lacking a seed token, so the seed tokens are not universal.
      'jamstack build tooling',
    ]);
    const { clusters } = clusterByLexical(set);
    const largest = Math.max(...clusters.map((c) => c.keywords.length));
    expect(largest).toBeLessThan(set.length * 0.4);
    expect(clusters.length).toBeGreaterThan(5);

    const clusterOf = (kw: string) => clusters.findIndex((c) => c.keywords.includes(kw));
    // Different languages are different pages.
    expect(clusterOf('static site generator python')).not.toBe(clusterOf('static site generator rust'));
    // A wholly unrelated keyword must not be absorbed.
    expect(clusterOf('jamstack build tooling')).not.toBe(clusterOf('static site generator'));
  });

  it('still separates two genuinely different topics in a small set', () => {
    // The guard against seed-collapse must not blur unrelated topics: an earlier
    // hard-cutoff version stripped a head down to just "best", which then
    // attracted every unrelated keyword containing that word.
    const twoTopics = toKeywords([
      'best crm software',
      'crm software pricing',
      'best email marketing tools',
      'email marketing automation',
    ]);
    const { clusters } = clusterByLexical(twoTopics);
    for (const c of clusters) {
      const hasCrm = c.keywords.some((k) => k.includes('crm'));
      const hasEmail = c.keywords.some((k) => k.includes('email'));
      expect(hasCrm && hasEmail, `cluster "${c.head}" mixes topics`).toBe(false);
    }
  });

  it('rejects a candidate that shares only a generic modifier with the head', () => {
    // This case exists specifically to kill the mutation that deletes the
    // topical-overlap gate. Here "crm"/"software" are frequent enough to count as
    // background, so the head's distinctive set collapses to just {best} — and a
    // distinctive-token check alone then happily absorbs any keyword containing
    // "best", including one from an entirely unrelated topic. Only the overlap
    // gate stops it.
    const set = toKeywords([
      'crm software',
      'best crm software',
      'crm software pricing',
      'crm software reviews',
      'best email marketing tools',
    ]);
    const { clusters } = clusterByLexical(set);
    for (const c of clusters) {
      const hasCrm = c.keywords.some((k) => k.includes('crm'));
      const hasEmail = c.keywords.some((k) => k.includes('email'));
      expect(hasCrm && hasEmail, `cluster "${c.head}" merged crm with email on the shared word "best"`).toBe(false);
    }
  });

  it('is deterministic across runs', () => {
    const a = clusterByLexical(keywords).clusters.map((c) => c.head);
    const b = clusterByLexical(keywords).clusters.map((c) => c.head);
    expect(a).toEqual(b);
  });
});

describe('clusterBySerp', () => {
  it('groups keywords whose SERPs overlap and splits those that do not', () => {
    const kws = toKeywords(['term a', 'term b', 'unrelated c']);
    const mk = (urls: string[]): SerpData => ({
      keyword: 'x',
      location: 'United States',
      device: 'desktop',
      results: urls.map((u, i) => ({ position: i + 1, url: u, title: '', snippet: '', domain: '' })),
      features: [],
      people_also_ask: [],
      related_searches: [],
      fetched_at: '',
    });
    const shared = ['https://1.com', 'https://2.com', 'https://3.com', 'https://4.com'];
    const serps = new Map([
      ['term a', mk(shared)],
      ['term b', mk(shared)],
      ['unrelated c', mk(['https://9.com', 'https://8.com', 'https://7.com'])],
    ]);
    const { clusters, method } = clusterBySerp(kws, serps, { minSharedUrls: 3 });
    expect(method).toBe('serp');
    const together = clusters.find((c) => c.keywords.includes('term a'));
    expect(together?.keywords).toContain('term b');
    expect(together?.keywords).not.toContain('unrelated c');
  });
});

describe('recommendPageType / clusterPageSpec', () => {
  it('maps query shape to the right page format', () => {
    expect(recommendPageType('notion vs airtable', 'commercial')).toBe('comparison');
    expect(recommendPageType('what is a crm', 'informational')).toBe('glossary');
    expect(recommendPageType('how to build a pipeline', 'informational')).toBe('guide');
    expect(recommendPageType('roi calculator', 'informational')).toBe('tool');
    expect(recommendPageType('buy crm license', 'transactional')).toBe('product');
  });

  it('produces a slug and a title within the SERP display limit', () => {
    const spec = clusterPageSpec({
      head: 'best crm software for very small businesses in north america',
      keywords: [],
      total_volume: 0,
      avg_difficulty: null,
      intent: 'commercial',
      page_type: 'comparison',
    });
    expect(spec.slug).toMatch(/^[a-z0-9-]+$/);
    expect(spec.title.length).toBeLessThanOrEqual(60);
  });

  it('uppercases acronyms instead of title-casing them', () => {
    const spec = clusterPageSpec({
      head: 'best crm software',
      keywords: [],
      total_volume: 0,
      avg_difficulty: null,
      intent: 'commercial',
      page_type: 'comparison',
    });
    expect(spec.h1).toContain('CRM');
    expect(spec.h1).not.toContain('Crm');
  });
});

describe('parseSuggestions', () => {
  it('parses the Google/Bing OpenSearch array shape', () => {
    const body = JSON.stringify(['seed', ['first result', 'second result'], [], {}]);
    expect(parseSuggestions('google', body)).toEqual(['first result', 'second result']);
  });

  it('parses the DuckDuckGo phrase-object shape', () => {
    const body = JSON.stringify([{ phrase: 'alpha' }, { phrase: 'beta' }]);
    expect(parseSuggestions('duckduckgo', body)).toEqual(['alpha', 'beta']);
  });

  it('returns an empty list for malformed responses rather than throwing', () => {
    expect(parseSuggestions('google', 'not json at all')).toEqual([]);
    expect(parseSuggestions('google', '{}')).toEqual([]);
    expect(parseSuggestions('google', '[]')).toEqual([]);
  });
});

describe('toKeywords', () => {
  it('deduplicates case-insensitively and classifies intent', () => {
    const out = toKeywords(['Best CRM', 'best crm', 'what is crm']);
    expect(out).toHaveLength(2);
    expect(out.find((k) => k.keyword === 'what is crm')?.intent).toBe('informational');
  });

  it('counts words and drops empty entries', () => {
    const out = toKeywords(['a b c', '', '   ']);
    expect(out).toHaveLength(1);
    expect(out[0]?.words).toBe(3);
  });
});

describe('clustering across morphological variants', () => {
  // Scope note: this covers phrasings that differ *only* in gerund vs base form.
  // Keywords differing by modifier ("best X" vs "cheap X") are deliberately kept
  // apart by the two-gate shouldJoin — that is the over-merge guard, not a bug.
  // No test here for "gerund phrasing joins its base form" at the cluster level.
  // One was written and then removed: deleting gerund stemming did not make it
  // fail, because those keywords also share their remaining tokens and clear the
  // topical-overlap floor on their own. Constructing a pair that depends *only*
  // on gerund stemming is impossible by design — two keywords sharing a single
  // token make that token background, and shouldJoin then requires distinctive
  // overlap they do not have. The mechanism is pinned in tests/text.test.ts
  // ('stem: gerunds'), where removing it fails immediately. A test that cannot
  // fail is worse than no test, because it reads as coverage.

  it('still keeps genuinely different topics in separate clusters', () => {
    const kws = scoreKeywords(
      toKeywords([
        'employee time tracking software', 'time tracking software for employees',
        'invoice software for freelancers', 'freelance invoicing software',
        'payroll software small business', 'small business payroll software',
      ]),
    );
    const { clusters } = clusterByLexical(kws);
    // Three topics: must not collapse into one, which is the failure mode the
    // two-gate shouldJoin exists to prevent.
    expect(clusters.length).toBeGreaterThanOrEqual(3);
    const biggest = Math.max(...clusters.map((c) => c.keywords.length));
    expect(biggest).toBeLessThanOrEqual(3);
  });
});

describe('Spanish intent and question detection', () => {
  it('recognises Spanish questions, accented or not', () => {
    for (const q of [
      'qué es un crm', 'que es un crm', 'cómo funciona el fichaje', 'por qué usar un crm',
      'para qué sirve un crm', 'cuándo usar un crm', 'dónde comprar software',
      'cuánto cuesta un crm', '¿cuál es el mejor crm?',
    ]) {
      expect(isQuestion(q), q).toBe(true);
    }
  });

  it('does not mistake a word merely starting with a question stem', () => {
    // "queso" begins with "que". The boundary check has to reject it, and it
    // cannot use \b because that does not fire after an accented letter.
    for (const kw of ['queso manchego', 'comodin de comodines', 'cualidades del equipo']) {
      expect(isQuestion(kw), kw).toBe(false);
    }
  });

  it('classifies Spanish commercial and transactional intent', () => {
    expect(classifyIntent('mejor software de fichaje').intent).toBe('commercial');
    expect(classifyIntent('opiniones sobre clockify').intent).toBe('commercial');
    expect(classifyIntent('alternativas a toggl').intent).toBe('commercial');
    expect(classifyIntent('comprar software de fichaje').intent).toBe('transactional');
    expect(classifyIntent('software de fichaje precio').intent).toBe('transactional');
    expect(classifyIntent('iniciar sesión en clockify').intent).toBe('navigational');
  });

  it('gives a Spanish question the same informational boost as its English twin', () => {
    // The question-form boost used a second English-only regex, so Spanish
    // questions never earned it: "cómo funciona el software de fichaje" scored
    // commercial off the word "software" alone, while "how does time tracking
    // software work" came out informational.
    expect(classifyIntent('cómo funciona el software de fichaje').intent).toBe('informational');
    expect(classifyIntent('qué es el mejor crm').intent).toBe('informational');
    expect(classifyIntent('how does time tracking software work').intent).toBe('informational');
  });

  it('matches multi-word Spanish signals through the accents', () => {
    // Signal phrases are stored unaccented; the keyword is not.
    expect(classifyIntent('iniciar sesión en clockify').signals).toContain('iniciar sesion');
  });
});

describe('Argentinian Spanish intent', () => {
  it('reads "cuánto sale" as a transactional question', () => {
    // The ordinary way to ask a price in Argentina; "cuánto cuesta" alone missed it.
    expect(isQuestion('cuánto sale un software de facturación')).toBe(true);
    expect(classifyIntent('cuánto sale un software de facturación').intent).toBe('transactional');
  });

  it('recognises instalment pricing as a purchase signal', () => {
    // "en cuotas" and "sin interés" are standard purchase intent in AR.
    expect(classifyIntent('software de facturación en cuotas').intent).toBe('transactional');
    expect(classifyIntent('12 cuotas sin interés software').intent).toBe('transactional');
  });

  it('handles rioplatense question openers', () => {
    for (const q of ['cómo hago una factura electrónica', 'dónde consigo software de gestión', 'conviene comprar un crm']) {
      expect(isQuestion(q), q).toBe(true);
    }
  });

  it('classifies local platform and tax terms', () => {
    expect(classifyIntent('afip mi cuenta').intent).toBe('navigational');
    expect(classifyIntent('mercado pago para facturar').intent).toBe('transactional');
    expect(classifyIntent('qué conviene para monotributo').intent).toBe('informational');
  });

  it('reads "vale la pena" like the peninsular "merece la pena"', () => {
    expect(classifyIntent('vale la pena un crm').intent).toBe('commercial');
    expect(classifyIntent('merece la pena un crm').intent).toBe('commercial');
  });
});

describe('language-aware keyword expansion', () => {
  const ALL = ['plain', 'questions', 'prepositions', 'comparisons', 'commercial'] as const;

  it('expands a Spanish seed with Spanish modifiers', () => {
    // English modifiers on a Spanish seed produce "best software de facturacion",
    // which autocomplete has nothing to say about — most of the request budget
    // went on noise. Measured on a real seed: 184 keywords from 79 Spanish
    // queries versus 146 from 88 English ones.
    const q = buildQueries('software de facturacion', [...ALL], 'es');
    expect(q).toContain('mejor software de facturacion');
    expect(q).toContain('que es software de facturacion');
    expect(q).toContain('software de facturacion gratis');
    expect(q).toContain('software de facturacion para');
    // And none of the English ones.
    expect(q).not.toContain('best software de facturacion');
    expect(q).not.toContain('cheap software de facturacion');
  });

  it('includes rioplatense phrasing for Spanish seeds', () => {
    const q = buildQueries('software de gestion', [...ALL], 'es-AR');
    expect(q).toContain('cuanto sale software de gestion');
    expect(q).toContain('software de gestion en cuotas');
    expect(q).toContain('como hago software de gestion');
  });

  it('still uses English modifiers for English and for an unset language', () => {
    for (const lang of ['en', 'en-GB', undefined]) {
      const q = buildQueries('time tracking software', [...ALL], lang);
      expect(q, String(lang)).toContain('best time tracking software');
      expect(q, String(lang)).not.toContain('mejor time tracking software');
    }
  });

  it('puts Spanish suffix modifiers after the seed, not before', () => {
    const q = buildQueries('crm', [...ALL], 'es');
    // "crm gratis" reads correctly; "gratis crm" does not.
    expect(q).toContain('crm gratis');
    expect(q).not.toContain('gratis crm');
    expect(q).toContain('mejor crm');
  });
});

describe('year modifier is computed, not hardcoded', () => {
  it('queries the current year for both languages', () => {
    const year = new Date().getFullYear();
    for (const lang of ['en', 'es']) {
      expect(buildQueries('crm software', ['commercial'], lang), lang).toContain(`crm software ${year}`);
    }
  });

  it('keeps year literals out of the modifier lists', () => {
    // '2026' was listed as a commercial modifier. It would have gone stale on
    // 1 January — still spending a request on last year's query and missing the
    // one people are typing — and the failure is invisible until the calendar
    // rolls over. The title generators already derived the year; this did not.
    for (const list of [COMMERCIAL_MODIFIERS, COMMERCIAL_MODIFIERS_ES, QUESTION_MODIFIERS, QUESTION_MODIFIERS_ES]) {
      for (const m of list) {
        expect(/\b(19|20)\d\d\b/.test(m), `year literal in modifier "${m}"`).toBe(false);
      }
    }
  });
});
