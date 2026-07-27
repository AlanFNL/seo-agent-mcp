import { z } from 'zod';
import { languageSchema, defineTool, limitSchema } from '../runtime.js';
import { discoverPatterns, buildPseoPlan, checkIndexRisk, pseoToActions, type PseoPattern } from '../../pseo/index.js';
import { toKeywords } from '../../keywords/cluster.js';
import { scoreKeywords } from '../../keywords/score.js';
import { difficultyFromLexical } from '../../keywords/difficulty.js';
import { getKeywords } from '../../store/index.js';
import { spill, action } from '../../core/envelope.js';
import { invalidInput } from '../../core/errors.js';
import type { Keyword } from '../../core/types.js';

/**
 * Programmatic SEO tools.
 *
 * Three-step workflow, in order: discover a pattern, plan the pages, validate
 * the drafts before publishing. The third step is not optional — see the module
 * comment in src/pseo/index.ts.
 */

function resolveKeywords(inline: string[] | undefined, project: string | undefined): Keyword[] {
  let keywords: Keyword[];
  if (inline && inline.length > 0) {
    keywords = toKeywords(inline, { source: 'input' });
  } else if (project) {
    keywords = getKeywords(project, { limit: 5000 });
    if (keywords.length === 0) {
      throw invalidInput(
        `Project "${project}" has no stored keywords.`,
        'Run seo_keyword_ideas with save_to_project first, or pass `keywords` inline.',
      );
    }
  } else {
    throw invalidInput(
      'No keywords supplied.',
      'Pass `keywords` inline, or a `project` that has keywords stored via seo_keyword_ideas.',
    );
  }
  return scoreKeywords(
    keywords.map((k) => (k.difficulty === null ? { ...k, difficulty: difficultyFromLexical(k.keyword).difficulty } : k)),
  );
}

export const pseoDiscoverTool = defineTool({
  name: 'pseo_discover_patterns',
  title: 'Find programmatic SEO opportunities',
  description:
    'Analyse a keyword set for repeating templates that could become a programmatic page set — patterns like ' +
    '"{tool} alternatives", "{city} plumbers" or "{x} vs {y}". Returns each template with its entity list, ' +
    'combined volume, intent, recommended page type and a viability score. ' +
    'Run this after seo_keyword_ideas to see whether the topic supports scaled publishing. Needs no API keys.',
  inputSchema: {
    keywords: z.array(z.string()).min(4).max(5000).optional()
      .describe('Keywords to analyse. Omit to use keywords stored under `project`.'),
    project: z.string().optional(),
    min_entities: z.number().int().min(2).max(100).optional().default(4)
      .describe('Minimum distinct entities for a template to count as a pattern.'),
    limit: limitSchema(100, 20),
  },
  async handler(args) {
    const keywords = resolveKeywords(args.keywords, args.project);
    const patterns = discoverPatterns(keywords, { minMatches: args.min_entities, maxPatterns: args.limit });
    const spilled = spill('pseo_discover_patterns', patterns, args.limit);

    return {
      summary:
        patterns.length === 0
          ? `No repeating templates found across ${keywords.length} keywords with at least ${args.min_entities} distinct entities. ` +
            'This topic may not suit programmatic SEO — try a broader keyword set, or lower min_entities.'
          : `${patterns.length} programmatic pattern(s) found. Best: "${patterns[0]?.template}" with ` +
            `${patterns[0]?.entities.length} entities (viability ${patterns[0]?.viability}/100).`,
      data: { keywords_analysed: keywords.length, patterns: spilled.rows },
      actions: pseoToActions(patterns),
      meta: {
        source: 'built-in',
        ...spilled.meta,
        next: ['pseo_build_plan on the highest-viability pattern to get concrete page specs'],
      },
    };
  },
});

export const pseoBuildPlanTool = defineTool({
  name: 'pseo_build_plan',
  title: 'Build a programmatic page plan',
  description:
    'Turn a pattern into a concrete build plan: one page spec per entity with URL path, title, H1, meta ' +
    'description, primary and secondary keywords, required sections (flagged for which must be unique per entity), ' +
    'schema type, internal link mesh, and the per-entity data fields you need to source. ' +
    'Also returns the uniqueness requirements that keep the set out of doorway-page territory. ' +
    'Pass either a template string or let it pick the best pattern from your keywords.',
  inputSchema: {
    keywords: z.array(z.string()).min(4).max(5000).optional(),
    project: z.string().optional(),
    template: z.string().optional()
      .describe('Pattern to build, using {x} for the variable slot, e.g. "{x} alternatives". Omit to use the highest-viability pattern.'),
    language: languageSchema,
    base_path: z.string().optional().describe('URL prefix for the generated pages, e.g. "/alternatives".'),
    max_pages: z.number().int().min(1).max(2000).optional().default(100),
    target_word_count: z.number().int().min(200).max(10_000).optional(),
    existing_urls: z.array(z.string()).optional()
      .describe('URLs you already publish, so the plan skips pages that would duplicate them.'),
    limit: limitSchema(500, 30),
  },
  async handler(args, ctx) {
    const keywords = resolveKeywords(args.keywords, args.project);

    let pattern: PseoPattern | undefined;
    if (args.template) {
      const normalized = args.template.trim().toLowerCase();
      const found = discoverPatterns(keywords, { minMatches: 1, maxPatterns: 500 });
      pattern = found.find((p) => p.template === normalized);
      if (!pattern) {
        throw invalidInput(
          `No keywords match the template "${args.template}".`,
          'Check the template uses {x} for the variable slot and that its constant words appear in your keyword set. ' +
            'Call pseo_discover_patterns to see the templates that do match.',
        );
      }
    } else {
      pattern = discoverPatterns(keywords, { minMatches: 3, maxPatterns: 5 })[0];
      if (!pattern) {
        throw invalidInput(
          'No usable programmatic pattern found in this keyword set.',
          'Run pseo_discover_patterns to inspect what was found, or pass a `template` explicitly.',
        );
      }
    }

    const plan = buildPseoPlan(pattern, keywords, {
      ...(args.base_path ? { basePath: args.base_path } : {}),
      limit: args.max_pages,
      language: args.language ?? ctx.cfg.defaults.language,
      ...(args.target_word_count !== undefined ? { targetWordCount: args.target_word_count } : {}),
      ...(args.existing_urls ? { existingUrls: args.existing_urls } : {}),
    });

    const spilled = spill('pseo_build_plan', plan.pages, args.limit);

    return {
      summary:
        `Plan for "${plan.pattern}": ${plan.total_pages} pages under ${plan.base_path}` +
        (plan.estimated_total_volume > 0 ? `, targeting ${plan.estimated_total_volume} searches/mo` : '') +
        `. ${plan.data_model.length} data fields required per entity. Build the hub page first.`,
      data: {
        pattern: plan.pattern,
        base_path: plan.base_path,
        total_pages: plan.total_pages,
        estimated_total_volume: plan.estimated_total_volume,
        hub_page: plan.hub_page,
        data_model: plan.data_model,
        uniqueness_requirements: plan.uniqueness_requirements,
        pages: spilled.rows,
      },
      actions: [
        action({
          id: 'pseo.validate_before_publish',
          priority: 'critical',
          effort: 'trivial',
          category: 'programmatic-seo',
          title: 'Validate the generated drafts with pseo_check_index_risk before publishing any of them',
          detail:
            `This plan produces ${plan.total_pages} pages from one template. If the generated content is thin or ` +
            'near-duplicate, Google can classify the whole directory as doorway pages, which damages the rest of the ' +
            'site too. Generate the drafts, run pseo_check_index_risk, and only publish once the verdict is "safe".',
          impact_score: 95,
          evidence: { pages_planned: plan.total_pages, requirements: plan.uniqueness_requirements.length },
          fix: { type: 'run_index_risk_check', to: 'pseo_check_index_risk' },
        }),
      ],
      warnings: plan.warnings,
      meta: { source: 'built-in', ...spilled.meta },
    };
  },
});

export const pseoIndexRiskTool = defineTool({
  name: 'pseo_check_index_risk',
  title: 'Validate generated pages before publishing',
  description:
    'The safety gate for programmatic SEO. Checks a set of generated drafts for thin content, near-duplicate bodies, ' +
    'duplicate titles and metas, and low vocabulary uniqueness across the set — the exact signals that get a ' +
    'templated directory classified as doorway pages. Returns a verdict of safe, risky or do_not_publish, plus ' +
    'the specific pages to fix. ' +
    'Always run this before publishing a programmatic set. Catching it here is free; catching it after Google does is not.',
  inputSchema: {
    // `url_path` is accepted as an alias because that is the field name
    // pseo_build_plan emits. This tool is the mandatory next step after that
    // one, so requiring the agent to rename the field first put a validation
    // error in the middle of the safety path — the one place friction is least
    // affordable, since the cheap way out is to skip the check.
    pages: z.array(
      z
        .object({
          url: z.string().optional(),
          url_path: z.string().optional(),
          title: z.string(),
          body: z.string(),
          meta_description: z.string().optional(),
        })
        .transform((p, ctx) => {
          const url = p.url ?? p.url_path;
          if (url === undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each page needs a url (or url_path, as returned by pseo_build_plan).' });
            return z.NEVER;
          }
          return { url, title: p.title, body: p.body, ...(p.meta_description !== undefined ? { meta_description: p.meta_description } : {}) };
        }),
    ).min(1).max(2000).describe('The generated drafts to validate. Accepts either `url` or `url_path` (what pseo_build_plan returns).'),
    min_words: z.number().int().min(50).max(5000).optional().default(300)
      .describe('Word count below which a page counts as thin.'),
    max_similarity: z.number().min(0.5).max(1).optional().default(0.8)
      .describe('Similarity above which two pages count as near-duplicates.'),
  },
  async handler(args) {
    const report = checkIndexRisk({
      pages: args.pages,
      minWords: args.min_words,
      maxSimilarity: args.max_similarity,
    });

    const actions =
      report.verdict === 'safe'
        ? []
        : [
            action({
              id: 'pseo.fix_before_publish',
              priority: report.verdict === 'do_not_publish' ? 'critical' : 'high',
              effort: 'large',
              category: 'programmatic-seo',
              title:
                report.verdict === 'do_not_publish'
                  ? `Do not publish: ${report.pages_checked} pages score ${report.risk_score}/100 for index risk`
                  : `Revise before publishing: index risk is ${report.risk_score}/100`,
              detail: report.recommendation,
              impact_score: report.verdict === 'do_not_publish' ? 98 : 75,
              evidence: {
                thin_pages: report.thin_pages.slice(0, 20),
                duplicate_clusters: report.duplicate_clusters.slice(0, 10),
                duplicate_titles: report.duplicate_titles.slice(0, 10),
                avg_uniqueness: report.avg_uniqueness,
              },
              fix: { type: 'revise_generated_content', affected: report.thin_pages.slice(0, 20).map((p) => p.url) },
            }),
          ];

    return {
      summary:
        `Verdict: ${report.verdict.replace(/_/g, ' ').toUpperCase()}. Risk ${report.risk_score}/100 across ` +
        `${report.pages_checked} pages. ${report.thin_pages.length} thin, ` +
        `${report.duplicate_clusters.reduce((s, c) => s + c.urls.length, 0)} near-duplicate, ` +
        `${report.avg_uniqueness}% average uniqueness.`,
      data: report,
      actions,
      meta: { source: 'built-in' },
    };
  },
});
