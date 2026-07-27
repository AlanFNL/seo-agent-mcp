/**
 * Text analysis primitives.
 *
 * All of this is deliberately dependency-free and deterministic: an agent
 * calling the same tool twice on the same input must get identical numbers,
 * otherwise "what changed since last run" becomes meaningless.
 */

/**
 * Spanish function words, so they stop counting as content.
 *
 * Without these, "el mejor software de seguimiento del tiempo para las empresas"
 * contributed el/de/del/para/las as content tokens — over half the terms. That
 * inflates Jaccard similarity between unrelated Spanish pages, skews the
 * IDF background-share calculation that drives clustering, and pads word counts.
 *
 * Stored unaccented because `tokenize` folds diacritics (qué → que).
 *
 * Deliberately excluded, because each is also a meaningful English word and this
 * set is shared with English analysis: son, sea, sin, solo, van, era, tan, dice,
 * come, pie, mar.
 */
export const SPANISH_STOPWORDS = [
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'al', 'del', 'de', 'en',
  'por', 'para', 'con', 'sobre', 'entre', 'hasta', 'desde', 'durante', 'segun',
  'que', 'como', 'cuando', 'donde', 'quien', 'cual', 'cuales', 'porque', 'aunque', 'si',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella',
  'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'le', 'les', 'se', 'te', 'nos', 'yo', 'ella', 'ellos', 'ellas', 'usted',
  'es', 'estan', 'ser', 'fue', 'fueron', 'hay', 'ha', 'han', 'habia',
  'muy', 'mas', 'menos', 'pero', 'tambien', 'ya', 'aun', 'todavia',
  'todo', 'toda', 'todos', 'todas', 'otro', 'otra', 'otros', 'otras',
  'cada', 'mismo', 'misma', 'tanto', 'ahora', 'aqui', 'alli', 'asi', 'bien',
  'puede', 'pueden', 'tiene', 'tienen', 'hacer', 'hace', 'ver',
  // Second-person verb forms, both dialects. Listing voseo without its
  // peninsular twin made the same sentence tokenise differently by dialect:
  // "vos tenés" dropped both words while "tú tienes" kept "tienes" as content.
  // After diacritic folding sabés/sabes and hacés/haces coincide anyway.
  'tienes', 'puedes', 'quieres', 'quiere', 'eres', 'sois', 'vais', 'teneis', 'podeis', 'quereis',
  // Rioplatense (Argentina/Uruguay): voseo pronouns and forms, plus the local
  // spatial adverbs. "sos" is left out on purpose — SOS is a real English term
  // and this set is shared.
  'vos', 'aca', 'alla', 'che', 'ustedes', 'tenes', 'queres', 'podes', 'sabes',
  'haces', 'vas', 'anda', 'mira', 'fijate', 'nomas', 'igual',
];

export const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most',
  'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'our', 'ours', 'ourselves', 'out', 'over', 'own', 's', 'same', 'she', 'should', 'so', 'some',
  'such', 't', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will',
  'with', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

for (const w of SPANISH_STOPWORDS) STOPWORDS.add(w);

/** Question openers, used for intent detection and question-keyword mining. */
export const QUESTION_WORDS = [
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'can', 'do', 'does', 'is', 'are',
  'will', 'should', 'would', 'could', 'was', 'were', 'did', 'has', 'have',
];

/**
 * Split text into lowercase tokens.
 *
 * ASCII-only by design. This tool targets English and Spanish, and after NFKD
 * diacritic folding both are pure ASCII ("año" → "ano", "café" → "cafe"), so a
 * simple class is enough and stays predictable.
 *
 * Worth knowing before pointing it at another language: a non-Latin script
 * produces *zero* tokens here, and the failure is silent and severe. Measured on
 * Japanese, Chinese, Korean, Russian, Arabic, Greek and Hindi: `word_count`
 * comes out 0, so `content.empty` fires at error severity claiming the page
 * renders no text, and every page hashes to simhash 0, so two unrelated articles
 * score a token similarity of 1.0 and get reported as duplicates of each other.
 * Supporting one would mean Unicode classes plus per-character segmentation for
 * the unsegmented scripts — deliberately not done, not merely overlooked.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length > 0);
}

export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * A crude but stable English stemmer (suffix stripping only).
 *
 * Deliberately not a full Porter implementation: over-stemming merges distinct
 * commercial keywords ("rating" vs "rate") and that surfaces as wrong
 * clustering. Every rule here is chosen to match obvious variants without
 * collapsing meaning, and the thresholds are what enforce that.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4 && /(?:[sxz]|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && w.length > 3) w = w.slice(0, -1);

  // Gerunds. Leaving these alone split obvious topics apart: "invoice software
  // for freelancers", "freelance invoicing software" and "best invoicing
  // software freelancers" came back as three separate clusters, i.e. three pages
  // competing for one intent — the cannibalisation this tool's own audit flags.
  //
  // The 4-character floor is what keeps this conservative, and it preserves the
  // distinction this stemmer was originally written to protect: "rating" strips
  // to "rat", which is too short, so it stays "rating" and never merges with
  // "rate". Meanwhile "king", "thing" and "during" are untouched for the same
  // reason. Only clear verb stems survive: tracking → track, billing → bill,
  // invoicing → invoic.
  //
  // No de-doubling. There is no way to tell an inflectional double ("running" ->
  // "runn") from one inherent to the base ("billing" -> "bill") without a
  // dictionary, and guessing broke the common case: "billing" became "bil",
  // which matched nothing at all. Skipping it costs the run/running merge and
  // keeps bill/billing and sell/selling. A missed merge is much cheaper here
  // than a wrong stem.
  if (w.endsWith('ing') && w.length >= 7) {
    const base = w.slice(0, -3);
    if (base.length >= 4) w = base;
  }

  // Trailing 'e' deletion, which does two jobs.
  //
  // English: the base form lands on the same stem as its gerund —
  // invoice/invoicing, price/pricing, manage/managing, package/packaging.
  //
  // Spanish: consonant plurals take -es, so the -s rule above leaves
  // "ciudades" as "ciudade" while the singular is "ciudad". Stripping the 'e'
  // reunites them, and likewise hoteles/hotel and gestores/gestor.
  //
  // Two thresholds because the short words are where the collisions live. At 5+
  // characters only c/g/s/v/z qualify, which is where English actually drops the
  // 'e'; going wider there would collide "rate"/"rat" and "plane"/"plan". At 6+
  // any trailing 'e' goes, which keeps English singular and plural on the same
  // stem either way (minute/minutes → "minut", feature/features → "featur") and
  // leaves 4-5 letter words like rate, plane, site and care untouched.
  //
  // The 6+ rule is a measured trade, not a free win. Checked against a 234k-word
  // dictionary: it merges a handful of adjacent English pairs — local/locale,
  // moral/morale, final/finale, human/humane, sever/severe, rational/rationale,
  // premier/premiere — and in exchange it handles every Spanish plural whose
  // singular is five letters (hotel/hoteles, papel/papeles, nivel/niveles,
  // cartel/carteles), which raising the bar to 7 would break. Nothing in the core
  // SEO vocabulary merges wrongly; every family it forms is correct.
  if ((w.length >= 5 && /[cgsvz]e$/.test(w)) || (w.length >= 6 && w.endsWith('e'))) w = w.slice(0, -1);

  return w;
}

export function ngrams(tokens: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

export function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** Jaccard similarity over stemmed content tokens. Used for near-duplicate detection. */
export function tokenSimilarity(a: string, b: string): number {
  const sa = new Set(contentTokens(a).map(stem));
  const sb = new Set(contentTokens(b).map(stem));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * 64-bit SimHash over token shingles.
 *
 * Jaccard is O(n) per comparison, which is too slow for all-pairs duplicate
 * detection across a 5,000-page crawl. SimHash lets us bucket first and only
 * compare candidates within a small Hamming radius.
 */
export function simhash(text: string): bigint {
  const tokens = contentTokens(text).map(stem);
  const shingles = tokens.length >= 3 ? ngrams(tokens, 3) : tokens;
  if (shingles.length === 0) return 0n;
  const v = new Array<number>(64).fill(0);
  for (const s of shingles) {
    const h = hash64(s);
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      v[i] = (v[i] ?? 0) + (bit === 1n ? 1 : -1);
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if ((v[i] ?? 0) > 0) out |= 1n << BigInt(i);
  return out;
}

/** FNV-1a, widened to 64 bits. Fast and good enough for shingle hashing. */
export function hash64(str: string): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/** Short, stable, filesystem-safe id derived from content. */
export function shortHash(str: string): string {
  return hash64(str).toString(36).slice(0, 12);
}

/**
 * Hamming distance below which two documents are worth comparing properly.
 *
 * Measured, not guessed. Programmatically-generated near-duplicates that differ
 * only in the entity name land at 18-25 bits apart with a Jaccard similarity of
 * ~0.88; genuinely different pages on the same topic land at 33 with a Jaccard
 * of 0.03. An earlier threshold of 8 was tight enough to discard every real
 * duplicate — the worst kind of bug, because the check appeared to pass.
 *
 * This is only a candidate filter. Jaccard makes the actual call.
 */
export const SIMHASH_CANDIDATE_DISTANCE = 28;

/**
 * Above this many documents, use the simhash prefilter to avoid O(n²) full text
 * comparison. Below it, compare everything — a few thousand set intersections
 * costs milliseconds and cannot miss a pair.
 */
const EXACT_COMPARISON_LIMIT = 400;

export interface DuplicateCluster {
  /** Indices into the input array. */
  members: number[];
  /** Highest pairwise similarity observed within the cluster. */
  similarity: number;
}

/**
 * Group documents into near-duplicate clusters.
 *
 * Shared by the site audit and the programmatic-SEO safety gate so both use one
 * tuned, tested implementation rather than two subtly different thresholds.
 */
export function findNearDuplicates(
  docs: string[],
  opts: { threshold?: number; minTokens?: number } = {},
): DuplicateCluster[] {
  const threshold = opts.threshold ?? 0.85;
  const minTokens = opts.minTokens ?? 50;

  const eligible: number[] = [];
  const tokenSets: Array<Set<string> | null> = docs.map((d, i) => {
    const tokens = contentTokens(d).map(stem);
    // The eligibility floor is on document *length*, not vocabulary size.
    // Gating on unique tokens silently skipped exactly the documents this is
    // meant to catch: templated doorway pages repeat one sentence, so a 144-word
    // page can carry only 15 distinct terms. Low vocabulary diversity is a
    // duplicate-content signal, not a reason to exclude the page from the check.
    //
    // Measured in raw words rather than content tokens, so the floor means the
    // same thing in every language. Counting content tokens made it drift with
    // stopword coverage: adding Spanish function words took a 61-word Spanish
    // page from 58 countable tokens down to 38, dropping it below the floor and
    // silently excluding Spanish doorway pages from the check — the same class of
    // silent skip this comment already warns about.
    if (tokenize(d).length >= minTokens) {
      eligible.push(i);
      return new Set(tokens);
    }
    return null;
  });
  if (eligible.length < 2) return [];

  const usePrefilter = eligible.length > EXACT_COMPARISON_LIMIT;
  const hashes = usePrefilter ? new Map(eligible.map((i) => [i, simhash(docs[i] as string)])) : null;

  const clusters: DuplicateCluster[] = [];
  const claimed = new Set<number>();

  for (let a = 0; a < eligible.length; a++) {
    const i = eligible[a] as number;
    if (claimed.has(i)) continue;
    const setI = tokenSets[i] as Set<string>;
    const members = [i];
    let worst = 0;

    for (let b = a + 1; b < eligible.length; b++) {
      const j = eligible[b] as number;
      if (claimed.has(j)) continue;
      if (hashes) {
        const d = hammingDistance(hashes.get(i) as bigint, hashes.get(j) as bigint);
        if (d > SIMHASH_CANDIDATE_DISTANCE) continue;
      }
      const sim = jaccard(setI, tokenSets[j] as Set<string>);
      if (sim < threshold) continue;
      members.push(j);
      claimed.add(j);
      worst = Math.max(worst, sim);
    }

    if (members.length > 1) {
      claimed.add(i);
      clusters.push({ members, similarity: round(worst, 3) });
    }
  }

  return clusters;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function countSyllables(word: string, silentE = true): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return w.length > 0 ? 1 : 0;
  // The trailing-e rules are English: Spanish has no silent e, so stripping it
  // cost "clase" a syllable (cla-se counted as one).
  const cleaned = silentE
    ? w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '')
    : w;
  const groups = cleaned.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function splitSentences(text: string): string[] {
  // The lookahead has to accept any uppercase letter, not just A-Z, and Spanish
  // opening punctuation. With `[A-Z"'(]` a Spanish paragraph collapsed into one
  // "sentence": "Él trabaja mucho. Ámbito laboral complejo. Éxito asegurado."
  // counted as 1 instead of 3, because Á/É/Ñ are not in A-Z, and
  // "Es un sistema. ¿Conviene usarlo?" did not split because ¿ is not either.
  // Undercounting sentences inflates words-per-sentence, which then makes
  // readability look far worse than the text is and miscounts long sentences.
  // The lookbehind allows a closing quote or bracket after the terminal
  // punctuation, or 'He said. "Then it worked." Fine.' merges the last two —
  // the same sentence undercount, just from quoted speech instead of accents.
  return text
    .split(/(?<=[.!?]["'\u201d\u2019\u00bb)\]]?)\s+(?=[\p{Lu}\p{Lt}"'(¿¡\u00ab\u201c])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface Readability {
  /**
   * Reading ease on a ~0-100 scale, higher is easier. 60-70 is plain prose.
   *
   * Not always Flesch: see `formula`. Flesch's coefficients are fitted to English
   * syllable statistics, and Spanish words carry more syllables, so scoring
   * Spanish with them is savage — equivalent text scored 25.8 against English's
   * 88.7, and an ordinary administrative sentence came out at **-68.1**. Spanish
   * uses Fernández Huerta, which is the standard adaptation and lands on a
   * comparable scale, so the thresholds downstream still mean something.
   */
  reading_ease: number;
  /** Which formula produced `reading_ease`. */
  formula: 'flesch' | 'fernandez-huerta';
  /** Approximate school grade level. Only meaningful for English. */
  grade_level: number | null;
  words: number;
  sentences: number;
  avg_words_per_sentence: number;
  avg_syllables_per_word: number;
  /** Sentences over 30 words — the main readability killer in SEO copy. */
  long_sentences: number;
}

export function readability(text: string, language?: string): Readability {
  const spanish = (language ?? '').toLowerCase().startsWith('es');
  const sentences = splitSentences(text);
  const words = tokenize(text);
  const nWords = words.length;
  const nSentences = Math.max(1, sentences.length);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w, !spanish), 0);
  const wps = nWords / nSentences;
  const spw = nWords > 0 ? syllables / nWords : 0;
  const longSentences = sentences.filter((s) => tokenize(s).length > 30).length;
  return {
    // Fernández Huerta for Spanish, Flesch for English. Same shape, coefficients
    // fitted to the language.
    reading_ease: spanish
      ? round(206.84 - 1.02 * wps - 60 * spw, 1)
      : round(206.835 - 1.015 * wps - 84.6 * spw, 1),
    formula: spanish ? 'fernandez-huerta' : 'flesch',
    // Flesch-Kincaid maps to US school grades and has no Spanish equivalent, so
    // it is null rather than a number that looks meaningful and is not.
    grade_level: spanish ? null : round(0.39 * wps + 11.8 * spw - 15.59, 1),
    words: nWords,
    sentences: nSentences,
    avg_words_per_sentence: round(wps, 1),
    avg_syllables_per_word: round(spw, 2),
    long_sentences: longSentences,
  };
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Does `text` contain `phrase`, allowing for stemming and intervening stopwords?
 *
 * "best crm software" should match "the best CRM software" and "best CRMs
 * software" — exact substring matching misses both and produces false
 * "keyword missing" recommendations, which is worse than useless to an agent.
 */
export function containsPhrase(text: string, phrase: string): boolean {
  const hay = tokenize(text).map(stem);
  const needle = contentTokens(phrase).map(stem);
  if (needle.length === 0) return false;
  for (let i = 0; i < hay.length; i++) {
    let hi = i;
    let ni = 0;
    let gaps = 0;
    while (hi < hay.length && ni < needle.length) {
      if (hay[hi] === needle[ni]) {
        ni++;
        hi++;
      } else if (STOPWORDS.has(hay[hi] as string) && gaps < 2) {
        gaps++;
        hi++;
      } else break;
    }
    if (ni === needle.length) return true;
  }
  return false;
}

/** How many times `phrase` occurs in `text`, stem- and stopword-tolerant. */
export function countPhrase(text: string, phrase: string): number {
  const hay = tokenize(text).map(stem);
  const needle = contentTokens(phrase).map(stem);
  if (needle.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < hay.length; i++) {
    let hi = i;
    let ni = 0;
    let gaps = 0;
    while (hi < hay.length && ni < needle.length) {
      if (hay[hi] === needle[ni]) {
        ni++;
        hi++;
      } else if (STOPWORDS.has(hay[hi] as string) && gaps < 2) {
        gaps++;
        hi++;
      } else break;
    }
    if (ni === needle.length) {
      count++;
      i = hi - 1;
    }
  }
  return count;
}

/** Truncate on a word boundary, for snippets in tool output. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Extract candidate topical terms (1-3 grams) ranked by frequency × specificity.
 * This is what powers "terms competitors cover that you don't".
 */
export function extractTerms(text: string, limit = 40): Array<{ term: string; count: number; score: number }> {
  const tokens = contentTokens(text);
  if (tokens.length === 0) return [];
  const counts = new Map<string, number>();
  for (const n of [1, 2, 3]) {
    for (const g of ngrams(tokens, n)) {
      // A 3-gram appearing twice is far more meaningful than a unigram appearing twice.
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  const total = tokens.length;
  const scored: Array<{ term: string; count: number; score: number }> = [];
  for (const [term, count] of counts) {
    const words = term.split(' ').length;
    if (count < 2 && words === 1) continue;
    if (count < 2 && words > 1) continue;
    // Longer phrases carry more topical signal per occurrence.
    const score = (count / total) * 1000 * (1 + 0.6 * (words - 1));
    scored.push({ term, count, score: round(score, 3) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
