import type { Intent } from '../core/types.js';
import { tokenize } from '../core/text.js';

/**
 * Search-intent classification.
 *
 * Rule-based on purpose. An LLM could classify intent more subtly, but an agent
 * calling this tool *is* an LLM — making it pay for a second model round-trip to
 * label 2,000 keywords would be absurd. Deterministic rules are fast, free,
 * reproducible, and about as accurate as Semrush's own labels on the head terms
 * that matter.
 *
 * The agent can always override a label it disagrees with; that's the point of
 * returning `confidence` and `signals` rather than a bare enum.
 */

const TRANSACTIONAL = [
  'buy', 'purchase', 'order', 'checkout', 'coupon', 'discount', 'deal', 'deals', 'promo',
  'cheap', 'cheapest', 'price', 'pricing', 'cost', 'quote', 'subscribe', 'signup', 'sign up',
  'free trial', 'download', 'install', 'hire', 'book', 'booking', 'shop', 'for sale',
  'near me', 'delivery', 'shipping',
  // Spanish
  'comprar', 'compra', 'precio', 'precios', 'coste', 'costo', 'cuesta', 'oferta', 'ofertas',
  'descuento', 'barato', 'baratos', 'gratis', 'contratar', 'pedir', 'reservar', 'presupuesto',
  'suscribirse', 'descargar', 'instalar', 'envio', 'en venta', 'cerca de mi',
  // Rioplatense: "cuánto sale" is the ordinary way to ask a price, and instalment
  // pricing ("en cuotas", "sin interés") is a standard purchase signal in AR.
  'cuanto sale', 'cuanto salen', 'cuotas', 'en cuotas', 'sin interes', 'mercado pago',
  'envio gratis', 'conviene comprar', 'precio en pesos', 'comprar online',
];

const COMMERCIAL = [
  'best', 'top', 'review', 'reviews', 'compare', 'comparison', 'vs', 'versus',
  'alternative', 'alternatives', 'competitor', 'competitors', 'software', 'tool', 'tools',
  'app', 'apps', 'platform', 'service', 'services', 'agency', 'vendor', 'provider',
  'solution', 'solutions', 'recommended', 'rated', 'ranking', 'which', 'worth it',
  'pros and cons', 'features', 'plans',
  // Spanish
  'mejor', 'mejores', 'comparar', 'comparativa', 'comparacion', 'alternativa', 'alternativas',
  'opiniones', 'resenas', 'valoraciones', 'herramienta', 'herramientas', 'programa', 'programas',
  'plataforma', 'servicio', 'servicios', 'proveedor', 'proveedores', 'solucion', 'soluciones',
  'caracteristicas', 'funciones', 'planes', 'merece la pena',
  // Rioplatense phrasing for the same "is it worth it / which should I pick" idea.
  'conviene', 'cual conviene', 'vale la pena', 'recomendados', 'recomendado',
  'comparativa precios', 'mejor opcion',
];

const INFORMATIONAL = [
  'what', 'why', 'how', 'when', 'where', 'who', 'guide', 'tutorial', 'learn', 'course',
  'meaning', 'definition', 'define', 'example', 'examples', 'ideas', 'tips', 'checklist',
  'template', 'templates', 'explained', 'explain', 'benefits', 'types', 'difference',
  'statistics', 'stats', 'trends', 'history', 'does', 'do', 'is', 'are', 'can',
  // Spanish
  'guia', 'tutorial', 'aprender', 'curso', 'significado', 'definicion', 'ejemplo', 'ejemplos',
  'ideas', 'consejos', 'plantilla', 'plantillas', 'explicado', 'ventajas', 'beneficios',
  'tipos', 'diferencia', 'diferencias', 'estadisticas', 'tendencias', 'historia',
  'para que sirve', 'que es', 'como funciona',
  // Rioplatense: monotributo and factura electrónica drive a lot of informational
  // search for business software in Argentina.
  'como hago', 'que tal', 'monotributo', 'factura electronica', 'como se hace',
  'paso a paso', 'requisitos',
];

/** Words that mean the searcher already knows where they're going. */
const NAVIGATIONAL = ['login', 'log in', 'sign in', 'signin', 'dashboard', 'portal', 'account', 'app', 'download app', 'careers', 'contact', 'support', 'status', 'docs', 'documentation', 'api',
  // Spanish
  'iniciar sesion', 'acceder', 'acceso', 'cuenta', 'contacto', 'soporte', 'ayuda', 'panel', 'documentacion',
  // Rioplatense: the platforms an Argentinian user is usually navigating to.
  'mercado libre', 'afip', 'mi afip', 'homebanking'];

export interface IntentResult {
  intent: Intent;
  /** 0-1. Low confidence means the agent should look at the SERP itself. */
  confidence: number;
  /** Which terms drove the classification. */
  signals: string[];
  /**
   * Relative commercial value, 0-1. Used in opportunity scoring: a
   * transactional keyword with 200 searches often beats an informational one
   * with 5,000.
   */
  value: number;
}

export function classifyIntent(keyword: string, brandTerms: string[] = []): IntentResult {
  const kw = keyword.toLowerCase().trim();
  const tokens = tokenize(kw);
  const tokenSet = new Set(tokens);
  // Multi-word signals are stored unaccented, but `kw` still carries accents, so
  // "iniciar sesion" never matched "iniciar sesión" and "como funciona" never
  // matched "cómo funciona". Match phrases against the folded token stream.
  const folded = tokens.join(' ');

  const matched: Record<Intent, string[]> = {
    transactional: [],
    commercial: [],
    informational: [],
    navigational: [],
  };

  const matchList = (list: string[], bucket: Intent) => {
    for (const term of list) {
      if (term.includes(' ')) {
        if (kw.includes(term) || folded.includes(term)) matched[bucket].push(term);
      } else if (tokenSet.has(term)) {
        matched[bucket].push(term);
      }
    }
  };

  matchList(TRANSACTIONAL, 'transactional');
  matchList(COMMERCIAL, 'commercial');
  matchList(INFORMATIONAL, 'informational');
  matchList(NAVIGATIONAL, 'navigational');

  // A brand name in the query dominates everything else — "acme login" is
  // navigational regardless of what other words appear.
  for (const brand of brandTerms) {
    const b = brand.toLowerCase().trim();
    if (b && kw.includes(b)) {
      matched.navigational.push(b);
      return {
        intent: 'navigational',
        confidence: 0.9,
        signals: matched.navigational,
        value: 0.4,
      };
    }
  }

  // Question form is a strong informational signal even without a keyword match.
  // Delegating to isQuestion rather than repeating an English-only regex here:
  // the duplicate list meant Spanish questions never earned the boost, so
  // "cómo funciona el software de fichaje" scored commercial off the word
  // "software" alone while its English equivalent came out informational.
  const startsWithQuestion = isQuestion(kw);
  if (startsWithQuestion) matched.informational.push('question-form');

  // Weight the buckets. Transactional outranks commercial outranks the rest,
  // because a transactional signal is rarely accidental.
  const scores: Record<Intent, number> = {
    transactional: matched.transactional.length * 3.2,
    commercial: matched.commercial.length * 2.4,
    navigational: matched.navigational.length * 2.6,
    informational: matched.informational.length * 1.9,
  };

  // "best crm software" hits both commercial and informational lists; the
  // commercial reading is right, so break that specific tie deliberately.
  if (scores.commercial > 0 && scores.informational > 0 && !startsWithQuestion) {
    scores.commercial += 1.5;
  }

  let intent: Intent = 'informational';
  let best = -1;
  for (const [k, v] of Object.entries(scores) as Array<[Intent, number]>) {
    if (v > best) {
      best = v;
      intent = k;
    }
  }

  // Nothing matched at all: fall back on length. Short head terms are usually
  // commercial exploration; long tails are usually questions.
  if (best === 0) {
    intent = tokens.length <= 2 ? 'commercial' : 'informational';
    return { intent, confidence: 0.3, signals: [], value: intent === 'commercial' ? 0.6 : 0.3 };
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = total > 0 ? Math.min(0.95, 0.45 + (best / total) * 0.5) : 0.3;

  return {
    intent,
    confidence: Math.round(confidence * 100) / 100,
    signals: matched[intent].slice(0, 5),
    value: INTENT_VALUE[intent],
  };
}

/** How much a click on each intent type is worth, roughly, for scoring. */
export const INTENT_VALUE: Record<Intent, number> = {
  transactional: 1.0,
  commercial: 0.8,
  navigational: 0.35,
  informational: 0.3,
};

/** Which page type usually wins for each intent — feeds the content planner. */
export const INTENT_PAGE_TYPE: Record<Intent, 'blog-post' | 'landing-page' | 'comparison' | 'guide'> = {
  transactional: 'landing-page',
  commercial: 'comparison',
  navigational: 'landing-page',
  informational: 'blog-post',
};

export function isQuestion(keyword: string): boolean {
  const kw = keyword.toLowerCase().trim();
  if (kw.endsWith('?')) return true;
  // Spanish opens questions with ¿ as often as it closes them with ?.
  if (kw.startsWith('\u00bf')) return true;
  // Accented and unaccented spellings both appear in real query data, and this
  // runs on the raw keyword rather than folded tokens, so both are listed.
  if (/^(what|why|how|when|where|who|which|can|could|should|would|will|does|do|did|is|are|was|were|has|have)\b/.test(kw)) return true;
  // Not \b here: it does not fire after an accented letter, so "qué" and
  // "por qué" failed while "cómo" happened to pass.
  // Rioplatense adds "cuánto sale", "cómo hago", "dónde consigo" and "conviene".
  return /^(para qu[eé]|por qu[eé]|cu[aá]nto cuesta|cu[aá]nto sale[n]?|c[oó]mo hago|d[oó]nde consigo|se puede|conviene|qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|qui[eé]n|cu[aá]l(?:es)?|cu[aá]nt[oa]s?|puedo)(?=[\s?!.,]|$)/.test(kw);
}
