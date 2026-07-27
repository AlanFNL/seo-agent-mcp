import { z } from 'zod';
import { defineTool, limitSchema, locationSchema, languageSchema } from '../runtime.js';
import { buildContentBrief, buildBriefWithoutSerp } from '../../content/brief.js';
import { scoreContent, contentScoreToActions } from '../../content/optimize.js';
import { getSerp, createSerpProvider } from '../../providers/serp.js';
import { fetchPage } from '../../crawl/crawler.js';
import { expandKeyword } from '../../keywords/suggest.js';
import { isQuestion } from '../../keywords/intent.js';
import { spill } from '../../core/envelope.js';
import { invalidInput } from '../../core/errors.js';

/**
 * Content tools — the ones an agent uses while planning and writing.
 */

export const contentBriefTool = defineTool({
  name: 'seo_content_brief',
  title: 'Build a content brief from the live SERP',
  description:
    'Generate a writing brief grounded in the pages that actually rank. Fetches and parses the top results, then ' +
    'returns the competitive word-count benchmark, the subtopic terms most competitors cover, the section headings ' +
    'they share, the questions to answer (People Also Ask plus competitor headings), and a concrete H1/H2 outline ' +
    'with a suggested title, slug and meta description. ' +
    'Call this before writing anything. Feed required_terms into seo_content_score afterwards to check the draft. ' +
    'Degrades to a keyword-cluster-based brief when no SERP provider is configured — clearly flagged in `notes`.',
  inputSchema: {
    keyword: z.string().describe('The primary keyword the page will target.'),
    top_n: z.number().int().min(3).max(20).optional().default(10)
      .describe('How many ranking pages to fetch and analyse.'),
    location: locationSchema,
    language: languageSchema,
    mine_questions: z.boolean().optional().default(true)
      .describe('Also mine question keywords from autocomplete. Free, adds a few seconds.'),
    brand_terms: z.array(z.string()).optional().describe('Your brand names, so intent classification treats them as navigational.'),
  },
  async handler(args, ctx) {
    let extraQuestions: string[] = [];
    if (args.mine_questions) {
      try {
        const expansion = await expandKeyword(args.keyword, {
          strategies: ['questions'],
          language: args.language ?? ctx.cfg.defaults.language,
        });
        extraQuestions = [...new Set(expansion.suggestions.map((s) => s.keyword))].filter(isQuestion).slice(0, 25);
      } catch {
        // Autocomplete is a bonus here; never fail the brief over it.
      }
    }

    if (!createSerpProvider(ctx.cfg)) {
      const brief = buildBriefWithoutSerp(args.keyword, [], extraQuestions, args.brand_terms ?? [], args.language ?? ctx.cfg.defaults.language);
      return {
        summary:
          `Brief for "${args.keyword}" built without competitor grounding (no SERP provider configured). ` +
          `${brief.questions.length} question(s) mined from autocomplete. See notes for what is missing.`,
        data: brief,
        warnings: brief.notes,
        meta: { source: 'google-suggest' },
      };
    }

    const { data: serp, cost, cached } = await getSerp(ctx.cfg, {
      keyword: args.keyword,
      ...(args.location ? { location: args.location } : {}),
      ...(args.language ? { language: args.language } : {}),
      depth: Math.max(args.top_n, 10),
    });

    const brief = await buildContentBrief(serp, {
      topN: args.top_n,
      language: args.language ?? ctx.cfg.defaults.language,
      concurrency: 4,
      timeoutMs: ctx.cfg.crawl.timeoutMs,
      userAgent: ctx.cfg.crawl.userAgent,
      extraQuestions,
      ...(args.brand_terms ? { brandTerms: args.brand_terms } : {}),
    });

    const analysed = brief.competitors.filter((c) => !c.fetch_error).length;

    return {
      summary:
        `Brief for "${args.keyword}" (${brief.intent} intent). Analysed ${analysed} of ${brief.competitors.length} ` +
        `ranking pages: median ${brief.competitor_word_counts.median} words, target ${brief.target_word_count}. ` +
        `${brief.required_terms.length} required terms, ${brief.common_sections.length} shared sections, ` +
        `${brief.questions.length} questions to answer.`,
      data: brief,
      warnings: brief.notes,
      meta: {
        source: ctx.cfg.serp.provider,
        cached,
        cost,
        next: [
          'Write the draft against suggested_outline',
          'seo_content_score with required_terms from this brief to grade the draft before publishing',
        ],
      },
    };
  },
});

export const contentScoreTool = defineTool({
  name: 'seo_content_score',
  title: 'Score and improve a draft or live page',
  description:
    'Grade content against a target keyword and return specific, applyable edits — not just metrics. ' +
    'Checks keyword placement in every position that carries weight (title, H1, opening paragraph, subheadings, ' +
    'URL, meta, alt text), coverage of competitive terms, length against benchmark, heading structure, ' +
    'readability, internal links, and keyword stuffing. ' +
    'Pass `body` for a draft (markdown is parsed) or `url` to score a live page. ' +
    'Pass required_terms from seo_content_brief to make the score competitive rather than generic. Needs no API keys.',
  inputSchema: {
    primary_keyword: z.string().describe('The one keyword this page targets.'),
    language: languageSchema,
    body: z.string().optional().describe('Draft content. Markdown headings, lists and links are understood.'),
    url: z.string().optional().describe('Live URL to fetch and score instead of passing body.'),
    title: z.string().optional().describe('Title tag. Overrides the fetched one when scoring a URL.'),
    meta_description: z.string().optional(),
    h1: z.string().optional(),
    target_url: z.string().optional().describe('Intended URL, so the slug can be checked when scoring a draft.'),
    secondary_keywords: z.array(z.string()).optional(),
    required_terms: z.array(z.string()).optional()
      .describe('Terms competitors cover, from seo_content_brief. Without these the score cannot be competitive.'),
    target_words: z.number().int().min(50).max(20_000).optional()
      .describe('Word-count benchmark, from seo_content_brief.'),
  },
  async handler(args, ctx) {
    if (!args.body && !args.url) {
      throw invalidInput(
        'Nothing to score.',
        'Pass `body` with the draft content, or `url` to fetch and score a live page.',
      );
    }

    let input: Parameters<typeof scoreContent>[0];
    const warnings: string[] = [];

    if (args.url) {
      const { page } = await fetchPage(args.url, {
        timeoutMs: ctx.cfg.crawl.timeoutMs,
        userAgent: ctx.cfg.crawl.userAgent,
      });
      if (page.word_count === 0) {
        warnings.push(
          'The fetched page has no extractable text. If it renders client-side, Google may see the same empty page — ' +
            'that is itself a finding worth investigating.',
        );
      }
      input = {
        page,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.meta_description !== undefined ? { meta_description: args.meta_description } : {}),
        ...(args.h1 !== undefined ? { h1: args.h1 } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
      };
    } else {
      input = {
        body: args.body as string,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.meta_description !== undefined ? { meta_description: args.meta_description } : {}),
        ...(args.h1 !== undefined ? { h1: args.h1 } : {}),
        ...(args.target_url !== undefined ? { url: args.target_url } : {}),
      };
    }

    if (!args.required_terms || args.required_terms.length === 0) {
      warnings.push(
        'No required_terms supplied, so this score reflects on-page mechanics only, not competitive completeness. ' +
          'Run seo_content_brief first and pass its required_terms for a score that reflects what actually ranks.',
      );
    }

    const score = scoreContent(input, {
      primary: args.primary_keyword,
      language: args.language ?? ctx.cfg.defaults.language,
      ...(args.secondary_keywords ? { secondary: args.secondary_keywords } : {}),
      ...(args.required_terms ? { required_terms: args.required_terms } : {}),
      ...(args.target_words !== undefined ? { target_words: args.target_words } : {}),
    });

    return {
      summary:
        `Score ${score.score}/100 (grade ${score.grade}) for "${args.primary_keyword}". ` +
        `${score.word_count} words, ${score.placements.filter((p) => p.present).length}/${score.placements.length} keyword ` +
        `placements, ${score.required_terms_coverage.coverage_pct}% competitive term coverage. ` +
        `${score.issues.length} issue(s) to fix.`,
      data: score,
      actions: contentScoreToActions(score, input),
      warnings,
      meta: { source: 'built-in' },
    };
  },
});

export const pageOptimizeTool = defineTool({
  name: 'seo_page_optimize',
  title: 'Full optimisation plan for one page',
  description:
    'End-to-end optimisation for a single page: fetch it, build a competitive brief for the target keyword, score ' +
    'the page against that brief, and return every concrete change to make in priority order. ' +
    'This is the one-call version of seo_content_brief plus seo_content_score — use it when asked to ' +
    '"improve this page" or "optimise this URL".',
  inputSchema: {
    url: z.string().describe('The page to optimise.'),
    primary_keyword: z.string().describe('The keyword it should rank for.'),
    secondary_keywords: z.array(z.string()).optional(),
    location: locationSchema,
    top_n: z.number().int().min(3).max(15).optional().default(8),
  },
  async handler(args, ctx) {
    const { page } = await fetchPage(args.url, {
      timeoutMs: ctx.cfg.crawl.timeoutMs,
      userAgent: ctx.cfg.crawl.userAgent,
    });

    const warnings: string[] = [];
    let requiredTerms: string[] = [];
    let targetWords: number | undefined;
    let briefData: unknown = null;
    let cost = 0;

    if (createSerpProvider(ctx.cfg)) {
      const { data: serp, cost: c } = await getSerp(ctx.cfg, {
        keyword: args.primary_keyword,
        ...(args.location ? { location: args.location } : {}),
        depth: Math.max(args.top_n, 10),
      });
      cost += c;
      const brief = await buildContentBrief(serp, {
        topN: args.top_n,
        timeoutMs: ctx.cfg.crawl.timeoutMs,
        userAgent: ctx.cfg.crawl.userAgent,
      });
      requiredTerms = brief.required_terms.map((t) => t.term);
      targetWords = brief.target_word_count;
      briefData = {
        target_word_count: brief.target_word_count,
        competitor_word_counts: brief.competitor_word_counts,
        common_sections: brief.common_sections,
        questions: brief.questions,
        suggested_outline: brief.suggested_outline,
        serp_features: brief.serp_features,
        competitors: brief.competitors.map((c) => ({ url: c.url, position: c.position, word_count: c.word_count })),
      };
      warnings.push(...brief.notes);

      // Knowing whether we already rank changes the advice entirely.
      const ourPosition = serp.results.find((r) => {
        try {
          return new URL(r.url).hostname === new URL(page.final_url).hostname;
        } catch {
          return false;
        }
      });
      if (ourPosition) {
        warnings.push(
          `This domain already ranks at position ${ourPosition.position} for "${args.primary_keyword}" with ${ourPosition.url}` +
            (ourPosition.url !== page.final_url ? ' — a different page than the one being optimised, so check for cannibalisation.' : '.'),
        );
      }
    } else {
      warnings.push(
        'No SERP provider configured, so there is no competitive benchmark. The score below reflects on-page ' +
          'mechanics only. Configure a SERP provider for competitive term coverage and a real word-count target.',
      );
    }

    const score = scoreContent(
      { page },
      {
        primary: args.primary_keyword,
        // The page declares its own language; fall back to the configured default.
        language: page.lang ?? ctx.cfg.defaults.language,
        ...(args.secondary_keywords ? { secondary: args.secondary_keywords } : {}),
        required_terms: requiredTerms,
        ...(targetWords !== undefined ? { target_words: targetWords } : {}),
      },
    );

    return {
      summary:
        `${args.url} scores ${score.score}/100 (grade ${score.grade}) for "${args.primary_keyword}". ` +
        `${score.word_count} words vs ${targetWords ?? 'unknown'} benchmark, ` +
        `${score.required_terms_coverage.coverage_pct}% competitive coverage. ` +
        `${score.issues.length} issue(s), ${score.required_terms_coverage.missing.length} missing subtopic(s).`,
      data: {
        url: page.url,
        status: page.status,
        current: {
          title: page.title,
          meta_description: page.meta_description,
          h1: page.h1,
          word_count: page.word_count,
          internal_links: page.links.filter((l) => l.internal).length,
        },
        score,
        brief: briefData,
      },
      actions: contentScoreToActions(score, { page }),
      warnings,
      meta: { source: createSerpProvider(ctx.cfg) ? ctx.cfg.serp.provider : 'built-in', cost },
    };
  },
});

export { spill, limitSchema };
