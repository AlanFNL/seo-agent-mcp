/**
 * Page copy templates, keyed by language.
 *
 * Everything in here ends up as text on a published page — titles, meta
 * descriptions, section headings. That makes it different from the rest of the
 * codebase's English strings, which are instructions addressed to the calling
 * agent and can stay English regardless of the site's language.
 *
 * This module exists because the same bug was fixed three times in three places
 * before anyone noticed the pattern: `pseo/index.ts` handed back "Compare
 * options for software de facturacion para autonomos", `keywords/cluster.ts`
 * suggested "Software De Facturacion: Compared & Reviewed (2026)", and
 * `content/brief.ts` produced an outline with "Frequently Asked Questions" and
 * "Which Option Should You Choose?". Each was a separate template literal buried
 * in a switch. Centralising them means the next language, or the next page type,
 * is one edit in one file.
 *
 * Spanish also differs in casing: English headline Title Case reads as an error
 * in Spanish, which uses sentence case. `headline()` handles that, so callers
 * never choose between titleCase and capitalizeFirst themselves.
 */

export type CopyLanguage = 'en' | 'es';

export interface PageCopy {
  language: CopyLanguage;

  /** Section headings for templated pages. */
  sections: {
    overview: string;
    how_it_works: string;
    /** Appended to a subject, so it carries its own leading space. */
    at_a_glance: string;
    pricing: string;
    pros_cons: string;
    alternatives: string;
    who_for: string;
    the_tool: string;
    how_to_use: string;
    worked_examples: string;
    definition: string;
    example: string;
    related_terms: string;
    key_considerations: string;
    faq: string;
    which_to_choose: string;
    /** "What is X?" — takes the subject. */
    what_is: (subject: string) => string;
    /** "X: quick answer" — takes the subject. */
    quick_answer: (subject: string) => string;
  };

  /** Title patterns per page type. */
  title: {
    comparison: (subject: string, year: number) => string;
    guide: (subject: string) => string;
    glossary: (subject: string) => string;
    /** Comparison title without a year, for the content brief. */
    compared: (subject: string) => string;
    tool: (subject: string) => string;
    product: (subject: string) => string;
  };

  /** Meta description patterns per intent. */
  meta: {
    commercial: (phrase: string) => string;
    transactional: (phrase: string) => string;
    informational: (phrase: string) => string;
  };
}

const EN: PageCopy = {
  language: 'en',
  sections: {
    overview: 'overview',
    how_it_works: 'how it works',
    at_a_glance: ' at a glance',
    pricing: 'Pricing',
    pros_cons: 'Pros and cons',
    alternatives: 'Best alternatives',
    who_for: 'Who should choose it',
    the_tool: 'the tool',
    how_to_use: 'How to use it',
    worked_examples: 'worked examples',
    definition: 'Definition',
    example: 'Example',
    related_terms: 'Related terms',
    key_considerations: 'Key considerations',
    faq: 'Frequently asked questions',
    which_to_choose: 'Which option should you choose?',
    what_is: (s) => `What Is ${s}?`,
    quick_answer: (s) => `${s}: Quick Answer`,
  },
  title: {
    comparison: (s, year) => `${s}: Compared & Reviewed (${year})`,
    guide: (s) => `${s}: A Complete Guide`,
    glossary: (s) => `${s} — Definition & Examples`,
    compared: (s) => `${s}: Compared`,
    tool: (s) => `Free ${s}`,
    product: (s) => `${s} — Pricing & Plans`,
  },
  meta: {
    commercial: (p) => `Compare options for ${p}. Real pricing, features and a clear recommendation — updated regularly.`,
    transactional: (p) => `Get started with ${p}. Pricing, setup steps, and what to expect.`,
    informational: (p) => `Everything you need to know about ${p}, explained simply with practical examples.`,
  },
};

const ES: PageCopy = {
  language: 'es',
  sections: {
    overview: 'qué es',
    how_it_works: 'cómo funciona',
    at_a_glance: ' de un vistazo',
    pricing: 'Precios',
    pros_cons: 'Ventajas y desventajas',
    alternatives: 'Mejores alternativas',
    who_for: 'Para quién es',
    the_tool: 'la herramienta',
    how_to_use: 'Cómo usarlo',
    worked_examples: 'ejemplos prácticos',
    definition: 'Definición',
    example: 'Ejemplo',
    related_terms: 'Términos relacionados',
    key_considerations: 'Aspectos clave',
    faq: 'Preguntas frecuentes',
    which_to_choose: '¿Qué opción conviene elegir?',
    what_is: (s) => `¿Qué es ${s}?`,
    quick_answer: (s) => `${s}: respuesta rápida`,
  },
  title: {
    comparison: (s, year) => `${s}: comparativa y opiniones (${year})`,
    guide: (s) => `${s}: guía completa`,
    glossary: (s) => `${s}: definición y ejemplos`,
    compared: (s) => `${s}: comparativa`,
    tool: (s) => `${s} gratis`,
    product: (s) => `${s}: precios y planes`,
  },
  meta: {
    commercial: (p) => `Compara opciones de ${p}. Precios reales, funciones y una recomendación clara — actualizado con frecuencia.`,
    transactional: (p) => `Empezá con ${p}. Precios, pasos de configuración y qué esperar.`,
    informational: (p) => `Todo lo que necesitás saber sobre ${p}, explicado con ejemplos prácticos.`,
  },
};

export function isSpanishLanguage(language: string | undefined): boolean {
  return (language ?? '').toLowerCase().startsWith('es');
}

/** Copy for a language tag. Anything that isn't Spanish falls back to English. */
export function pageCopy(language?: string): PageCopy {
  return isSpanishLanguage(language) ? ES : EN;
}

/**
 * Capitalise a heading or title for the language.
 *
 * English uses Title Case for headlines; Spanish uses sentence case, where Title
 * Case looks like a mistake — "Software De Facturacion Para Autonomos" reads
 * wrong to a Spanish speaker in a way it does not in English.
 */
export function headline(text: string, language: string | undefined, titleCase: (s: string) => string): string {
  if (!isSpanishLanguage(language)) return titleCase(text);
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
