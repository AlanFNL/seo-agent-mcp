import { describe, it, expect } from 'vitest';
import {
  tokenize,
  contentTokens,
  stem,
  containsPhrase,
  countPhrase,
  readability,
  simhash,
  hammingDistance,
  findNearDuplicates,
  jaccard,
  extractTerms,
  truncate,
  splitSentences,
  SIMHASH_CANDIDATE_DISTANCE,
  tokenSimilarity,
} from '../src/core/text.js';

describe('tokenize', () => {
  it('lowercases and splits on punctuation', () => {
    expect(tokenize('Hello, World! Foo-bar.')).toEqual(['hello', 'world', 'foo', 'bar']);
  });

  it('strips accents so "café" matches "cafe"', () => {
    expect(tokenize('Café')).toEqual(tokenize('Cafe'));
  });

  it('keeps + and # so "c++" and "c#" survive as terms', () => {
    expect(tokenize('C++ and C# developers')).toContain('c++');
    expect(tokenize('C++ and C# developers')).toContain('c#');
  });

  it('drops stopwords in contentTokens but keeps them in tokenize', () => {
    expect(tokenize('the best of the best')).toHaveLength(5);
    expect(contentTokens('the best of the best')).toEqual(['best', 'best']);
  });
});

describe('stem', () => {
  it('normalises plurals', () => {
    expect(stem('tools')).toBe(stem('tool'));
    expect(stem('companies')).toBe(stem('company'));
    expect(stem('boxes')).toBe(stem('box'));
  });

  it('does not over-stem short words or double-s endings', () => {
    expect(stem('is')).toBe('is');
    expect(stem('class')).toBe('class');
    expect(stem('bus')).toBe('bus');
  });
});

describe('containsPhrase', () => {
  it('matches exactly', () => {
    expect(containsPhrase('the best crm software today', 'best crm software')).toBe(true);
  });

  it('matches across an intervening stopword', () => {
    // "reviews of crm software" should still count as covering "crm software".
    expect(containsPhrase('reviews of the crm software', 'crm software')).toBe(true);
  });

  it('matches a stemmed variant', () => {
    expect(containsPhrase('we compared many crm tools', 'crm tool')).toBe(true);
  });

  it('does not match when a content word is absent', () => {
    expect(containsPhrase('the best software today', 'best crm software')).toBe(false);
  });

  it('does not match words out of order', () => {
    expect(containsPhrase('software crm best', 'best crm software')).toBe(false);
  });
});

describe('countPhrase', () => {
  it('counts non-overlapping occurrences', () => {
    const text = 'crm software is good. crm software is fast. we like crm software.';
    expect(countPhrase(text, 'crm software')).toBe(3);
  });

  it('returns zero for an absent phrase', () => {
    expect(countPhrase('nothing relevant here', 'crm software')).toBe(0);
  });
});

describe('readability', () => {
  it('scores simple prose as easier than dense prose', () => {
    const simple = 'The cat sat. The dog ran. It was fun. We had a good day.';
    const dense =
      'Notwithstanding the aforementioned considerations, the implementation necessitates ' +
      'comprehensive architectural reconfiguration alongside substantial infrastructural modernisation initiatives.';
    expect(readability(simple).reading_ease).toBeGreaterThan(
      readability(dense).reading_ease,
    );
  });

  it('counts long sentences', () => {
    const long = `${'word '.repeat(40)}. Short one.`;
    expect(readability(long).long_sentences).toBe(1);
  });

  it('never divides by zero on empty input', () => {
    const r = readability('');
    expect(Number.isFinite(r.reading_ease)).toBe(true);
    expect(r.words).toBe(0);
  });
});

describe('simhash / duplicate detection', () => {
  const doorway = (entity: string) =>
    `Looking for ${entity} alternatives? We compare the best options. ${entity} is popular but not for everyone. ` +
    `Here are the top choices to consider when you evaluate ${entity} alternatives for your team. `.repeat(8);

  it('gives identical text a distance of zero', () => {
    const t = doorway('notion');
    expect(hammingDistance(simhash(t), simhash(t))).toBe(0);
  });

  it('clusters templated near-duplicates that differ only in one noun', () => {
    const bodies = ['notion', 'airtable', 'asana', 'trello'].map(doorway);
    const clusters = findNearDuplicates(bodies, { threshold: 0.8, minTokens: 40 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toHaveLength(4);
    expect(clusters[0]?.similarity).toBeGreaterThan(0.8);
  });

  it('does not cluster genuinely different pages on the same topic', () => {
    const bodies = [
      'Notion combines documents and databases in one workspace. Coda matches the database model closely. '.repeat(10),
      'Airtable is a relational database wearing a spreadsheet costume. Baserow is open source and self-hostable. '.repeat(10),
      'Asana priced timeline features into Premium. Height offers dependencies on the free plan entirely. '.repeat(10),
    ];
    expect(findNearDuplicates(bodies, { threshold: 0.8, minTokens: 40 })).toHaveLength(0);
  });

  it('gates on document length, not vocabulary size', () => {
    // Repetitive text has tiny unique vocabulary but is long — it must still be
    // checked, since that is exactly the doorway-page shape.
    const bodies = [doorway('notion'), doorway('airtable')];
    const uniqueTokens = new Set(contentTokens(bodies[0] as string).map(stem)).size;
    expect(uniqueTokens).toBeLessThan(40);
    expect(findNearDuplicates(bodies, { threshold: 0.8, minTokens: 40 })).toHaveLength(1);
  });

  it('skips documents below the length floor', () => {
    expect(findNearDuplicates(['tiny text', 'tiny text'], { minTokens: 50 })).toHaveLength(0);
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets and 0 for disjoint sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('is symmetric', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });
});

describe('extractTerms', () => {
  it('surfaces repeated multi-word phrases above incidental unigrams', () => {
    const text = `${'pipeline management is essential. '.repeat(5)} An unrelated aside appears once.`;
    const terms = extractTerms(text, 20).map((t) => t.term);
    expect(terms).toContain('pipeline management');
  });
});

describe('truncate / splitSentences', () => {
  it('truncates on a word boundary', () => {
    const out = truncate('the quick brown fox jumps over', 15);
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('jum…');
  });

  it('leaves short strings untouched', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('splits sentences on terminal punctuation', () => {
    expect(splitSentences('One. Two! Three? Four')).toHaveLength(4);
  });
});

describe('stem: gerunds', () => {
  // Gerunds are everywhere in search queries. Leaving them unstemmed split one
  // obvious topic into three clusters — "invoice software for freelancers",
  // "freelance invoicing software", "best invoicing software freelancers" — i.e.
  // three pages competing for one intent, which is the cannibalisation this
  // tool's own audit reports.
  it('matches a gerund to its base form', () => {
    for (const [a, b] of [
      ['invoice', 'invoicing'], ['price', 'pricing'], ['track', 'tracking'],
      ['bill', 'billing'], ['manage', 'managing'], ['package', 'packaging'],
      ['license', 'licensing'], ['source', 'sourcing'], ['sell', 'selling'],
      ['build', 'building'], ['host', 'hosting'],
    ]) {
      expect(stem(a as string), `${a} vs ${b}`).toBe(stem(b as string));
    }
  });

  // The whole reason this stemmer is not Porter. The 4-character floor on the
  // stripped base is what protects these: "rating" -> "rat" is too short, so it
  // is left alone. Widening the 'e'-deletion rule past c/g/s/v/z would collide
  // rate/rat and plane/plan.
  it('keeps distinct commercial terms apart', () => {
    for (const [a, b] of [
      ['rate', 'rating'], ['plane', 'plan'], ['care', 'car'], ['site', 'sit'],
      ['advice', 'advise'], ['loose', 'lose'], ['custom', 'customer'],
    ]) {
      expect(stem(a as string), `${a} vs ${b} must stay distinct`).not.toBe(stem(b as string));
    }
  });

  it('does not maul short words that merely end in -ing', () => {
    for (const w of ['king', 'thing', 'ring', 'during', 'bring', 'sing']) {
      expect(stem(w), w).toBe(w);
    }
  });

  it('leaves an inherent double consonant alone rather than guessing', () => {
    // "billing" -> "bill", not "bil". De-doubling would serve run/running and
    // break bill/billing and sell/selling, which are the commoner terms.
    expect(stem('billing')).toBe('bill');
    expect(stem('selling')).toBe('sell');
  });
});

describe('duplicate detection thresholds survive the stemmer', () => {
  // SIMHASH_CANDIDATE_DISTANCE and the 0.85/0.75 similarity thresholds were
  // measured against the old stemmer, so changing stemming could have silently
  // invalidated them. Templated pages differing only by entity must stay well
  // inside the radius; genuinely different pages must stay far outside.
  const tpl = (city: string) =>
    `Looking for the best plumbers in ${city}? Our directory lists vetted plumbing companies serving ${city} ` +
    `and the surrounding area. Every ${city} plumber is licensed, insured and reviewed by real customers. ` +
    `Compare quotes from ${city} plumbers today and book an appointment online.`;

  it('keeps near-duplicates inside the candidate radius and above the similarity floor', () => {
    const a = tpl('Bristol');
    const b = tpl('Leeds');
    expect(hammingDistance(simhash(a), simhash(b))).toBeLessThanOrEqual(SIMHASH_CANDIDATE_DISTANCE);
    expect(tokenSimilarity(a, b)).toBeGreaterThan(0.85);
  });

  it('keeps genuinely different pages well below the pSEO gate', () => {
    const other =
      'Choosing a boiler for a small flat means balancing output against space. A combi unit avoids a hot water ' +
      'tank entirely. Flow rate is the number to check: below ten litres a minute a shower feels weak.';
    expect(tokenSimilarity(tpl('Bristol'), other)).toBeLessThan(0.75);
  });
});

describe('Spanish support', () => {
  // This tool is used for English and Spanish. Spanish was never exercised, and
  // three things were wrong: function words counted as content, consonant
  // plurals did not stem, and questions were not recognised.
  it('drops Spanish function words from content tokens', () => {
    // el/de/del/para/las/en/la were all being counted as content terms, which
    // inflates Jaccard similarity between unrelated pages and skews the IDF
    // background-share calculation that clustering depends on.
    expect(contentTokens('el mejor software de seguimiento del tiempo para las empresas en la nube'))
      .toEqual(['mejor', 'software', 'seguimiento', 'tiempo', 'empresas', 'nube']);
  });

  it('leaves English content tokens untouched', () => {
    expect(contentTokens('the best time tracking software for small business teams in the cloud'))
      .toEqual(['best', 'time', 'tracking', 'software', 'small', 'business', 'teams', 'cloud']);
  });

  it('does not treat English words that look Spanish as stopwords', () => {
    // Excluded from the Spanish list on purpose, because each is a real English
    // word and the set is shared: son, sea, sin, solo, van, era, tan.
    for (const w of ['son', 'sea', 'sin', 'solo', 'van', 'era', 'tan']) {
      expect(contentTokens(`the ${w} matters`), w).toContain(w);
    }
  });

  it('folds Spanish diacritics consistently so variants match', () => {
    expect(tokenize('año diseño café pequeño instalación')).toEqual(['ano', 'diseno', 'cafe', 'pequeno', 'instalacion']);
    // Inverted punctuation is a delimiter, not part of a word.
    expect(tokenize('¿Qué es el software?')).toEqual(['que', 'es', 'el', 'software']);
  });

  it('stems Spanish consonant plurals onto their singular', () => {
    // The -s rule alone left "ciudades" as "ciudade" against a singular of
    // "ciudad", so a page about "gestores de proyectos" never clustered with one
    // about "gestor de proyectos".
    for (const [singular, plural] of [
      ['ciudad', 'ciudades'], ['hotel', 'hoteles'], ['gestor', 'gestores'],
      ['control', 'controles'], ['funcion', 'funciones'], ['mes', 'meses'],
      ['casa', 'casas'], ['empresa', 'empresas'], ['proyecto', 'proyectos'],
    ]) {
      expect(stem(singular as string), `${singular}/${plural}`).toBe(stem(plural as string));
    }
  });
});

describe('Argentinian Spanish (rioplatense)', () => {
  it('tokenises the same sentence identically in either dialect', () => {
    // Voseo was added without its peninsular twin at first, so "vos tenés"
    // dropped both words while "tú tienes" kept "tienes" as a content term —
    // the same page would cluster differently depending on dialect.
    const ar = contentTokens('si vos tenés un negocio acá, podés usar este software de gestión');
    const es = contentTokens('si tú tienes un negocio aquí, puedes usar este software de gestión');
    expect(ar).toEqual(es);
    expect(ar).toEqual(['negocio', 'usar', 'software', 'gestion']);
  });

  it('treats acá/allá as function words like aquí/allí', () => {
    expect(contentTokens('acá y allá')).toEqual([]);
    expect(contentTokens('aquí y allí')).toEqual([]);
  });

  it('still keeps SOS out of the stopword list', () => {
    // "sos" is second-person "you are" in rioplatense but also a real English
    // term, and this set is shared with English analysis.
    expect(contentTokens('the sos signal')).toContain('sos');
  });
});

describe('stem: the trailing-e threshold is a measured trade', () => {
  // Extending the 'e' strip to 6+ characters is what makes Spanish consonant
  // plurals work. It costs a few adjacent English merges. Both sides are pinned
  // here so the boundary is not widened or narrowed casually.
  it('leaves 4-5 letter words alone, which is what protects the risky pairs', () => {
    for (const [a, b] of [['rate', 'rating'], ['plane', 'plan'], ['site', 'sit'], ['care', 'car'], ['past', 'paste']]) {
      expect(stem(a as string), `${a}/${b}`).not.toBe(stem(b as string));
    }
  });

  it('needs the 6-character rule for Spanish five-letter singulars', () => {
    // Raising the threshold to 7 would break every one of these.
    for (const [singular, plural] of [['hotel', 'hoteles'], ['papel', 'papeles'], ['nivel', 'niveles'], ['cartel', 'carteles']]) {
      expect(stem(singular as string), `${singular}/${plural}`).toBe(stem(plural as string));
    }
  });

  it('forms only correct families across the core SEO vocabulary', () => {
    // The check that actually matters: does this stemmer mangle the words this
    // tool handles all day? Verified against a 234k-word dictionary that the
    // only English casualties are adjacent pairs like rational/rationale.
    const vocab = [
      'keyword', 'keywords', 'search', 'searches', 'rank', 'ranking', 'rankings',
      'link', 'links', 'linking', 'page', 'pages', 'site', 'sites', 'index', 'indexing',
      'crawl', 'crawling', 'title', 'titles', 'image', 'images', 'click', 'clicks',
      'impression', 'impressions', 'domain', 'domains', 'anchor', 'anchors',
      'sitemap', 'sitemaps', 'redirect', 'redirects', 'duplicate', 'duplicates',
      'snippet', 'snippets', 'query', 'queries', 'price', 'pricing', 'review', 'reviews',
      'service', 'services', 'guide', 'guides', 'template', 'templates',
    ];
    const families = new Map<string, string[]>();
    for (const w of vocab) {
      const k = stem(w);
      const arr = families.get(k);
      if (arr) arr.push(w);
      else families.set(k, [w]);
    }
    // Every multi-word family must share a common opening, i.e. be the same word.
    for (const [key, words] of families) {
      if (words.length < 2) continue;
      const prefix = (words[0] as string).slice(0, 4);
      for (const w of words) {
        expect(w.startsWith(prefix), `${key} wrongly merged ${words.join(', ')}`).toBe(true);
      }
    }
    // And the families we rely on did form.
    expect(families.get(stem('pricing'))).toEqual(['price', 'pricing']);
    expect(families.get(stem('rankings'))).toEqual(['rank', 'ranking', 'rankings']);
  });
});

describe('duplicate detection on Spanish content', () => {
  // Adding Spanish stopwords and Spanish plural stemming changes the token sets
  // that simhash and Jaccard are computed from, so the 0.85/0.75 thresholds had
  // to be re-measured for Spanish rather than assumed to carry over.
  const tpl = (city: string) =>
    `Buscas un software de facturacion en ${city}? Nuestro directorio lista las mejores herramientas ` +
    `de gestion que operan en ${city}. Cada programa de facturacion en ${city} esta homologado, es ` +
    `seguro y fue evaluado por usuarios reales. Compara precios de software en ${city} y contrata ` +
    `online hoy mismo. Cubrimos facturacion electronica, monotributo y gestion de stock en ${city}.`;

  const different =
    'Elegir un plan de monotributo depende de tus ingresos anuales y de la actividad que declaras ante ' +
    'AFIP. Las categorias se recategorizan cada seis meses, asi que conviene revisar la facturacion ' +
    'acumulada antes del vencimiento. Un contador puede calcularlo, pero la app ya muestra el limite.';

  it('flags Spanish templated pages that differ only by city', () => {
    const a = tpl('Buenos Aires');
    const b = tpl('Cordoba');
    expect(hammingDistance(simhash(a), simhash(b))).toBeLessThanOrEqual(SIMHASH_CANDIDATE_DISTANCE);
    expect(tokenSimilarity(a, b)).toBeGreaterThan(0.85);
  });

  it('does not flag genuinely different Spanish pages on one topic', () => {
    expect(tokenSimilarity(tpl('Buenos Aires'), different)).toBeLessThan(0.75);
  });

  it('clusters the templated Spanish pages and leaves the distinct one out', () => {
    const clusters = findNearDuplicates([tpl('Buenos Aires'), tpl('Cordoba'), different], { threshold: 0.85 });
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.members.length).toBe(2);
  });
});

describe('readability by language', () => {
  const enSimple = 'Time tracking software records the hours your team works. It turns them into payroll and invoices. Most tools charge per user per month.';
  const esSimple = 'El software de facturación electrónica registra las horas que trabaja tu equipo. Las convierte en liquidaciones y facturas. La mayoría cobra por usuario por mes.';
  const esHard = 'La recategorización del monotributo constituye un procedimiento administrativo semestral mediante el cual el contribuyente actualiza su encuadramiento tributario considerando la facturación acumulada durante los doce meses precedentes.';

  it('does not punish Spanish for being Spanish', () => {
    // Flesch's coefficients are fitted to English syllable counts, and Spanish
    // words carry more syllables. Scored with Flesch, this ordinary Spanish
    // paragraph came out at 25.8 against the English equivalent's 88.7, and a
    // routine administrative sentence scored -68.1.
    const es = readability(esSimple, 'es');
    const en = readability(enSimple, 'en');
    expect(es.formula).toBe('fernandez-huerta');
    expect(en.formula).toBe('flesch');
    expect(es.reading_ease).toBeGreaterThan(50);
    // Both are plain prose, so they should land in the same broad band.
    expect(Math.abs(es.reading_ease - en.reading_ease)).toBeLessThan(35);
  });

  it('still rates genuinely dense Spanish as hard', () => {
    expect(readability(esHard, 'es').reading_ease).toBeLessThan(30);
  });

  it('reports no grade level for Spanish rather than a meaningless number', () => {
    // Flesch-Kincaid maps to US school grades and has no Spanish equivalent.
    expect(readability(esSimple, 'es').grade_level).toBeNull();
    expect(readability(enSimple, 'en').grade_level).not.toBeNull();
  });

  it('counts Spanish syllables without the English silent-e rule', () => {
    // "clase" is cla-se. Stripping a silent e cost it a syllable.
    const es = readability('La clase base tiene una fase simple.', 'es');
    const en = readability('La clase base tiene una fase simple.', 'en');
    expect(es.avg_syllables_per_word).toBeGreaterThan(en.avg_syllables_per_word);
  });

  it('defaults to Flesch when no language is given', () => {
    expect(readability(enSimple).formula).toBe('flesch');
  });
});

describe('splitSentences across both languages', () => {
  // Sentence count feeds words-per-sentence, which feeds readability and the
  // long-sentence warnings. Undercounting it makes text look far denser than it
  // is. The old lookahead was [A-Z"'(], so a Spanish paragraph whose sentences
  // begin with accented capitals collapsed into one.
  const count = (t: string) => splitSentences(t).length;

  it('splits Spanish sentences beginning with an accented capital', () => {
    expect(count('Él trabaja mucho. Ámbito laboral complejo. Éxito asegurado.')).toBe(3);
    expect(count('Trabajamos juntos. Ñandú es un ave. Fin.')).toBe(3);
  });

  it('splits before Spanish opening punctuation', () => {
    expect(count('Es un sistema. ¿Conviene usarlo? Sí.')).toBe(3);
    expect(count('Funciona bien. ¡Probalo ahora! Listo.')).toBe(3);
    expect(count('Hola. ¿Qué tal? ¡Genial! Éxito.')).toBe(4);
  });

  it('splits after a closing quote in either language', () => {
    expect(count('He said. "Then it worked." Fine.')).toBe(3);
    expect(count('Dijo esto. «Funciona bien.» Listo.')).toBe(3);
  });

  it('leaves English behaviour intact and does not over-split', () => {
    expect(count('Time tracking helps. It saves money. Try it today.')).toBe(3);
    expect(count('Just one sentence here.')).toBe(1);
    // A mid-sentence abbreviation must not become a sentence boundary.
    expect(count('See fig. 2 for details.')).toBe(1);
  });

  it('reports a sane sentence count through readability', () => {
    const r = readability('¿Qué es la facturación electrónica? Es un sistema de AFIP. ¿Conviene usarlo? Sí, siempre.', 'es');
    expect(r.sentences).toBe(4);
    // With one "sentence" the average was 3x too high, which alone dragged the
    // reading-ease score down.
    expect(r.avg_words_per_sentence).toBeLessThan(6);
  });
});
