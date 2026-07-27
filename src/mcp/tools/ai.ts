import { z } from 'zod';
import { defineTool } from '../runtime.js';
import { checkAiVisibility, aiVisibilityToActions, defaultPrompts } from '../../providers/ai-visibility.js';
import { getPageSpeed, pageSpeedToActions } from '../../providers/pagespeed.js';
import { reserve, record } from '../../core/budget.js';

/**
 * AI-era visibility and Core Web Vitals.
 *
 * Both of these mirror capabilities Ahrefs and Semrush added in their most
 * recent cycles, and both need a key — see each tool's `remedy` for the free
 * fallback.
 */

export const aiVisibilityTool = defineTool({
  name: 'seo_ai_visibility',
  title: 'Check whether AI assistants recommend your brand',
  description:
    'Ask an AI assistant the questions a buyer would ask about your category, with live web search enabled, ' +
    'then measure whether your brand gets named, how prominently, whether your own site is cited as a source, ' +
    'which competitors take share of voice, and — the half that changes what you do — HOW you are described: ' +
    'sentiment, recurring strengths and criticisms, and any claims assistants state that are factually wrong. ' +
    'This is the AI-search equivalent of rank tracking: a growing share of commercial research never reaches a ' +
    'results page, so ranking well organically is worth less if the assistant summarising the topic never mentions you. ' +
    'Requires ANTHROPIC_API_KEY.',
  inputSchema: {
    brand: z.string().describe('Your brand or product name, as a buyer would say it.'),
    topic: z.string().describe('The category to test, e.g. "project management software".'),
    domain: z.string().optional().describe('Your domain, to detect whether your own site gets cited as a source.'),
    competitors: z.array(z.string()).optional()
      .describe('Competitor names to detect in the answers, for share-of-voice measurement.'),
    prompts: z.array(z.string()).optional()
      .describe('Custom buyer questions to test. Omit to use a generated set covering recommendation, comparison, pricing and brand-defensive queries.'),
    use_web_search: z.boolean().optional().default(true)
      .describe('Let the assistant search the web, matching how a real assistant answers. Disable to test the model\'s unaided knowledge of your brand.'),
    analyze_sentiment: z.boolean().optional().default(true)
      .describe('Also classify HOW the brand is described — sentiment, recurring strengths and criticisms, and factually wrong claims. One extra request in total, not one per prompt.'),
  },
  async handler(args, ctx) {
    const queries = args.prompts && args.prompts.length > 0
      ? args.prompts.map((p) => ({ prompt: p }))
      : defaultPrompts(args.topic, args.brand);

    // Reserve the worst case *before* spending: one request per prompt plus at
    // most one batched sentiment pass. Charging only afterwards left the single
    // most expensive tool here outside SEO_AGENT_BUDGET entirely — an agent
    // looping over prompt sets could spend without limit while `seo_usage`
    // faithfully reported the overspend after the fact.
    //
    // Gated on the key being present so a missing key still reports
    // PROVIDER_NOT_CONFIGURED rather than a budget error for spend that could
    // never have happened. Same ordering the SERP provider uses: resolve the
    // provider, then reserve.
    if (ctx.cfg.anthropicKey) reserve(queries.length + (args.analyze_sentiment ? 1 : 0));

    const report = await checkAiVisibility(ctx.cfg, {
      brand: args.brand,
      ...(args.domain ? { domain: args.domain } : {}),
      queries,
      ...(args.competitors ? { competitors: args.competitors } : {}),
      useWebSearch: args.use_web_search,
      analyzeSentiment: args.analyze_sentiment,
    });

    // One request per prompt, plus one batched sentiment classification. The
    // sentiment pass is skipped when nothing was mentioned, so charge for it only
    // when it actually ran — meta.cost must match what was really spent.
    const cost = queries.length + (report.sentiment ? 1 : 0);
    record('anthropic', 'ai_visibility', cost);

    const refused = report.results.filter((r) => r.refused).length;
    const warnings: string[] = [];
    if (refused > 0) {
      warnings.push(
        `${refused} prompt(s) were declined by the model's safety classifiers and are excluded from the rates ` +
          'so they do not register as false "not mentioned" results.',
      );
    }
    if (!args.competitors || args.competitors.length === 0) {
      warnings.push(
        'No competitors supplied, so share-of-voice is empty. Pass `competitors` to see who is being recommended instead of you.',
      );
    }

    return {
      summary:
        `${report.brand} appeared in ${report.visibility_rate}% of ${report.queries_run} AI assistant answer(s) ` +
        `about "${args.topic}", with the site cited as a source in ${report.citation_rate}%. ` +
        `Overall AI visibility score: ${report.visibility_score}/100.` +
        (report.sentiment
          ? ` Described as ${report.sentiment.label} (${report.sentiment.score > 0 ? '+' : ''}${report.sentiment.score}/100)` +
            (report.sentiment.weaknesses.length > 0
              ? `; recurring criticism: ${report.sentiment.weaknesses.slice(0, 2).join('; ')}.`
              : '.')
          : '') +
        (report.competitor_share[0]
          ? ` Top competitor by share of voice: ${report.competitor_share[0].name} (${report.competitor_share[0].share_pct}%).`
          : ''),
      data: report,
      actions: aiVisibilityToActions(report),
      warnings,
      meta: { source: `anthropic:${report.model}`, cost },
    };
  },
});

export const pageSpeedTool = defineTool({
  name: 'seo_page_speed',
  title: 'Core Web Vitals and page speed',
  description:
    'Fetch Core Web Vitals (LCP, INP, CLS) and the Lighthouse performance score for a URL, plus a ranked list of ' +
    'specific optimisation opportunities. ' +
    'Reports real-user field data from the Chrome UX Report where available — that is the data Google actually uses ' +
    'as a ranking signal — and falls back to lab measurements, clearly labelled, when a URL has too little traffic. ' +
    'Requires PAGESPEED_API_KEY (free from Google).',
  inputSchema: {
    url: z.string().describe('The URL to measure.'),
    strategy: z.enum(['mobile', 'desktop']).optional().default('mobile')
      .describe('Google indexes mobile-first, so mobile is the default and the one that matters for ranking.'),
  },
  async handler(args, ctx) {
    // Cheap, but it is metered and counted, so it must respect the same cap.
    // Gated on the key for the same reason as above.
    if (ctx.cfg.pagespeedKey) reserve(1);
    const { result, cached } = await getPageSpeed(ctx.cfg, args.url, args.strategy);
    if (!cached) record('pagespeed', 'page_speed', 1);

    const source = result.field_data ? 'field (real users, last 28 days)' : 'lab (single simulated load)';
    const metrics = result.field_data ?? result.lab_data;

    return {
      summary:
        `${args.url} (${args.strategy}): performance score ${result.performance_score ?? 'n/a'}/100. ` +
        `LCP ${metrics.lcp ?? 'n/a'}ms, INP ${metrics.inp ?? 'n/a'}ms, CLS ${metrics.cls ?? 'n/a'}. ` +
        `Data source: ${source}.` +
        (result.passes_cwv === true
          ? ' Passes the Core Web Vitals assessment.'
          : result.passes_cwv === false
            ? ' Fails the Core Web Vitals assessment.'
            : ''),
      data: result,
      actions: pageSpeedToActions(result),
      warnings: result.field_data
        ? []
        : [
            'No Chrome UX Report data for this URL, which usually means it has too little traffic. ' +
              'The metrics below are from a single simulated load and are directional only — Google ranks on field data.',
          ],
      meta: { source: 'pagespeed-insights', cached, cost: cached ? 0 : 1 },
    };
  },
});
