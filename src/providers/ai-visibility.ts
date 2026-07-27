import Anthropic from '@anthropic-ai/sdk';
import type { Action } from '../core/types.js';
import { action } from '../core/envelope.js';
import { providerNotConfigured, SeoAgentError } from '../core/errors.js';
import { round, clamp } from '../core/text.js';
import { domainOf } from '../core/url.js';
import type { Config } from '../config.js';

/**
 * AI search visibility.
 *
 * Both Ahrefs (Brand Radar) and Semrush (AI Visibility) shipped this in the last
 * cycle, and the reason is that a growing share of commercial research never
 * reaches a blue link — someone asks an assistant "what's the best X" and acts
 * on the answer. Ranking #3 organically is worth much less if the assistant
 * summarising the SERP never names you.
 *
 * The check has to be an actual generation, not a heuristic: we ask Claude the
 * questions a buyer would ask, with web search enabled so it behaves like a
 * real assistant answering a real query, then measure whether the brand appears
 * in the answer and in the cited sources. Anything less — inferring visibility
 * from rankings — would just be re-reporting SERP data under a new name.
 */

export interface AiVisibilityQuery {
  prompt: string;
  /** Optional label for grouping, e.g. "comparison" or "recommendation". */
  category?: string;
}

export interface AiVisibilityResult {
  prompt: string;
  category: string | null;
  /** Did the assistant name the brand in its answer? */
  brand_mentioned: boolean;
  /** Did it cite a page on the brand's own domain? */
  domain_cited: boolean;
  /** Roughly where the first mention falls, as a fraction through the answer. 0 = opening. */
  mention_position: number | null;
  /** Competitors named in the same answer, in order of first appearance. */
  competitors_mentioned: string[];
  /** Domains the assistant cited. */
  cited_domains: string[];
  /** The sentence containing the first brand mention, for tone review. */
  mention_context: string | null;
  /** Full answer text, truncated. */
  answer_excerpt: string;
  /** Set when the model declined to answer. */
  refused?: boolean;
}

export interface AiVisibilityReport {
  brand: string;
  domain: string;
  model: string;
  queries_run: number;
  /** Percentage of prompts where the brand was named. */
  visibility_rate: number;
  /** Percentage of prompts where the brand's own site was cited. */
  citation_rate: number;
  /** 0-100 blended score weighting mention, citation and prominence. */
  visibility_score: number;
  results: AiVisibilityResult[];
  /** Competitors ranked by how often they appeared, with their share of voice. */
  competitor_share: Array<{ name: string; mentions: number; share_pct: number }>;
  /** Prompts where the brand was absent but competitors were named. */
  losing_prompts: string[];
  /** How assistants characterise the brand. Null when sentiment analysis was skipped. */
  sentiment: BrandSentiment | null;
}

/**
 * How AI assistants describe the brand, not merely whether they name it.
 *
 * Semrush ships this as AI Brand Sentiment and it is the half of AI visibility
 * that actually changes what you do. Being named in 80% of answers is a
 * different problem depending on whether the sentence is "the best choice for
 * small teams" or "cheap but unreliable" — the first is a win, the second is a
 * positioning emergency that a mention-count alone reports as success.
 */
export interface BrandSentiment {
  /** -100 (uniformly negative) to +100 (uniformly positive). */
  score: number;
  label: 'positive' | 'mixed' | 'neutral' | 'negative';
  /** Per-mention verdicts, in the order the prompts were run. */
  mentions: Array<{
    prompt: string;
    sentiment: 'positive' | 'neutral' | 'negative';
    /** The specific claim the assistant made. */
    claim: string;
  }>;
  /** Recurring positive themes, as the assistants phrased them. */
  strengths: string[];
  /** Recurring criticisms — the narrative to correct. */
  weaknesses: string[];
  /** Claims that are wrong or outdated and worth actively countering. */
  inaccuracies: string[];
}

/**
 * Generate the buyer questions worth testing for a topic.
 *
 * These mirror the query shapes that actually drive assistant-mediated
 * purchasing decisions, rather than informational queries where a brand mention
 * would be incidental.
 */
export function defaultPrompts(topic: string, brand?: string): AiVisibilityQuery[] {
  const t = topic.trim();
  const prompts: AiVisibilityQuery[] = [
    { prompt: `What is the best ${t}? Give me a shortlist with reasons.`, category: 'recommendation' },
    { prompt: `What are the top ${t} options in ${new Date().getFullYear()} and how do they compare?`, category: 'comparison' },
    { prompt: `I'm evaluating ${t} for a small team. What should I choose and why?`, category: 'recommendation' },
    { prompt: `What are the most affordable ${t} options that are still good?`, category: 'pricing' },
    { prompt: `Which ${t} do professionals actually use?`, category: 'authority' },
  ];
  if (brand) {
    prompts.push(
      { prompt: `Is ${brand} a good choice for ${t}? What are its strengths and weaknesses?`, category: 'brand-direct' },
      { prompt: `What are the best alternatives to ${brand}?`, category: 'brand-defensive' },
    );
  }
  return prompts;
}

const SYSTEM_PROMPT =
  'You are answering as a helpful research assistant would for someone making a purchasing decision. ' +
  'Search the web for current information, then give a direct, specific answer naming actual products, ' +
  'companies or tools — not generic advice about how to choose. Cite the sources you used.';

const SENTIMENT_SCHEMA = {
  type: 'object',
  properties: {
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
          claim: { type: 'string' },
        },
        required: ['index', 'sentiment', 'claim'],
        additionalProperties: false,
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
    inaccuracies: { type: 'array', items: { type: 'string' } },
  },
  required: ['mentions', 'strengths', 'weaknesses', 'inaccuracies'],
  additionalProperties: false,
} as const;

/**
 * Classify how the brand was characterised across the collected mentions.
 *
 * Deliberately a *separate* pass rather than asking the answering model to
 * self-assess: adding "and rate your own sentiment" to the buyer prompt would
 * change the answer being measured. One batched call classifies every mention,
 * so this costs a single request regardless of how many prompts were run.
 */
export async function analyzeSentiment(
  client: Anthropic,
  model: string,
  brand: string,
  mentions: Array<{ prompt: string; context: string }>,
): Promise<BrandSentiment | null> {
  if (mentions.length === 0) return null;

  const numbered = mentions
    .map((m, i) => `[${i}] ${m.context}`)
    .join('\n\n');

  let parsed: {
    mentions: Array<{ index: number; sentiment: 'positive' | 'neutral' | 'negative'; claim: string }>;
    strengths: string[];
    weaknesses: string[];
    inaccuracies: string[];
  };

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system:
        `You are auditing how AI assistants describe the brand "${brand}". For each numbered excerpt, ` +
        'judge the sentiment *toward that brand specifically* (ignore sentiment toward other brands ' +
        'mentioned alongside it) and quote or paraphrase the specific claim made about it. Then summarise ' +
        'the recurring strengths and criticisms across all excerpts. List under "inaccuracies" only claims ' +
        'that are internally contradictory, hedged as uncertain, or clearly outdated — not claims you ' +
        'merely disagree with.',
      output_config: { format: { type: 'json_schema', schema: SENTIMENT_SCHEMA } },
      messages: [{ role: 'user', content: numbered }],
    } as never);

    const block = (response as { content: Array<{ type: string; text?: string }> }).content.find(
      (b) => b.type === 'text',
    );
    if (!block?.text) return null;
    parsed = JSON.parse(block.text) as typeof parsed;
  } catch {
    // Sentiment is an enrichment; losing it must not fail the visibility report.
    return null;
  }

  const scored = parsed.mentions
    .filter((m) => m.index >= 0 && m.index < mentions.length)
    .map((m) => ({
      prompt: mentions[m.index]?.prompt ?? '',
      sentiment: m.sentiment,
      claim: m.claim,
    }));
  if (scored.length === 0) return null;

  const value = (x: string) => (x === 'positive' ? 1 : x === 'negative' ? -1 : 0);
  const score = round((scored.reduce((sum, m) => sum + value(m.sentiment), 0) / scored.length) * 100, 1);
  const negatives = scored.filter((m) => m.sentiment === 'negative').length;
  const positives = scored.filter((m) => m.sentiment === 'positive').length;

  // "Mixed" is distinct from "neutral" and matters: an even split of praise and
  // criticism needs a different response than uniform indifference.
  const label: BrandSentiment['label'] =
    negatives > 0 && positives > 0
      ? 'mixed'
      : score >= 25
        ? 'positive'
        : score <= -25
          ? 'negative'
          : 'neutral';

  return {
    score,
    label,
    mentions: scored,
    strengths: parsed.strengths.slice(0, 8),
    weaknesses: parsed.weaknesses.slice(0, 8),
    inaccuracies: parsed.inaccuracies.slice(0, 8),
  };
}

export async function checkAiVisibility(
  cfg: Config,
  opts: {
    brand: string;
    domain?: string;
    queries: AiVisibilityQuery[];
    competitors?: string[];
    model?: string;
    useWebSearch?: boolean;
    /** Run the sentiment pass. One extra request total, not one per prompt. */
    analyzeSentiment?: boolean;
  },
): Promise<AiVisibilityReport> {
  if (!cfg.anthropicKey) {
    throw providerNotConfigured(
      'AI search visibility testing',
      ['ANTHROPIC_API_KEY'],
      'seo_serp and seo_competitors_discover for traditional search visibility',
    );
  }

  const client = new Anthropic({ apiKey: cfg.anthropicKey });
  const model = opts.model ?? 'claude-opus-5';
  const brand = opts.brand.trim();
  const domain = opts.domain ? domainOf(opts.domain) : '';
  const competitors = opts.competitors ?? [];

  const results: AiVisibilityResult[] = [];

  for (const query of opts.queries) {
    let text = '';
    let citedDomains: string[] = [];
    let refused = false;

    try {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        // Server-side fallback: safety classifiers can decline, and a declined
        // request would otherwise register as "brand not mentioned" — a false
        // negative that silently corrupts the visibility rate.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        ...(opts.useWebSearch !== false
          ? { tools: [{ type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: 5 }] }
          : {}),
        messages: [{ role: 'user', content: query.prompt }],
      });

      // A refusal returns HTTP 200 with empty or partial content, so this has to
      // be checked before reading the blocks.
      if (response.stop_reason === 'refusal') {
        refused = true;
      }

      for (const block of response.content) {
        if (block.type === 'text') text += block.text;
        if (block.type === 'web_search_tool_result') {
          const content = block.content;
          // On error this is a single object rather than a list of results.
          if (Array.isArray(content)) {
            for (const r of content) {
              const url = (r as { url?: string }).url;
              if (url) citedDomains.push(domainOf(url));
            }
          }
        }
      }
    } catch (err) {
      throw new SeoAgentError(
        'PROVIDER_ERROR',
        `Anthropic API call failed: ${err instanceof Error ? err.message : String(err)}`,
        'Check ANTHROPIC_API_KEY is valid and the account has credit.',
      );
    }

    citedDomains = [...new Set(citedDomains)].filter(Boolean);
    const analysis = analyzeMention(text, brand, domain, competitors, citedDomains);
    results.push({
      prompt: query.prompt,
      category: query.category ?? null,
      ...analysis,
      ...(refused ? { refused: true } : {}),
    });
  }

  const answered = results.filter((r) => !r.refused);
  const denominator = Math.max(1, answered.length);
  const mentioned = answered.filter((r) => r.brand_mentioned);
  const cited = answered.filter((r) => r.domain_cited);

  // Prominence matters: being named in the opening sentence of a recommendation
  // is worth far more than a passing mention in a closing list.
  const prominence =
    mentioned.length > 0
      ? mentioned.reduce((s, r) => s + (1 - (r.mention_position ?? 0.5)), 0) / mentioned.length
      : 0;

  const visibilityRate = (mentioned.length / denominator) * 100;
  const citationRate = (cited.length / denominator) * 100;
  const score = clamp(visibilityRate * 0.55 + citationRate * 0.25 + prominence * 100 * 0.2, 0, 100);

  const competitorCounts = new Map<string, number>();
  for (const r of answered) {
    for (const c of r.competitors_mentioned) {
      competitorCounts.set(c, (competitorCounts.get(c) ?? 0) + 1);
    }
  }
  const totalMentions = [...competitorCounts.values()].reduce((a, b) => a + b, 0) + mentioned.length;
  const competitorShare = [...competitorCounts]
    .map(([name, mentions]) => ({
      name,
      mentions,
      share_pct: totalMentions > 0 ? round((mentions / totalMentions) * 100, 1) : 0,
    }))
    .sort((a, b) => b.mentions - a.mentions);

  let sentiment: BrandSentiment | null = null;
  if (opts.analyzeSentiment !== false) {
    sentiment = await analyzeSentiment(
      client,
      model,
      brand,
      mentioned
        .filter((r) => r.mention_context)
        .map((r) => ({ prompt: r.prompt, context: r.mention_context as string })),
    );
  }

  return {
    brand,
    domain,
    model,
    queries_run: results.length,
    visibility_rate: round(visibilityRate, 1),
    citation_rate: round(citationRate, 1),
    visibility_score: round(score, 1),
    results,
    competitor_share: competitorShare,
    losing_prompts: answered
      .filter((r) => !r.brand_mentioned && r.competitors_mentioned.length > 0)
      .map((r) => r.prompt),
    sentiment,
  };
}

/**
 * Detect brand and competitor mentions in an assistant's answer.
 * Exported so the matching rules can be tested without spending API calls.
 */
export function analyzeMention(
  text: string,
  brand: string,
  domain: string,
  competitors: string[],
  citedDomains: string[],
): Omit<AiVisibilityResult, 'prompt' | 'category' | 'refused'> {
  const lower = text.toLowerCase();
  const brandLower = brand.toLowerCase();

  const match = brandPattern(brandLower).exec(lower);
  const mentioned = match !== null;
  const position = mentioned && text.length > 0 ? round((match as RegExpExecArray).index / text.length, 3) : null;

  let context: string | null = null;
  if (mentioned) {
    const idx = (match as RegExpExecArray).index;
    const start = Math.max(0, text.lastIndexOf('.', idx) + 1);
    const endDot = text.indexOf('.', idx);
    const end = endDot === -1 ? Math.min(text.length, idx + 200) : endDot + 1;
    context = text.slice(start, end).trim().slice(0, 300);
  }

  const found: Array<{ name: string; at: number }> = [];
  for (const c of competitors) {
    const cLower = c.toLowerCase();
    if (cLower === brandLower) continue;
    const m = brandPattern(cLower).exec(lower);
    if (m) found.push({ name: c, at: m.index });
  }
  found.sort((a, b) => a.at - b.at);

  return {
    brand_mentioned: mentioned,
    domain_cited: domain !== '' && citedDomains.includes(domain),
    mention_position: position,
    competitors_mentioned: found.map((f) => f.name),
    cited_domains: citedDomains,
    mention_context: context,
    answer_excerpt: text.slice(0, 1200),
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word matcher for a brand name, tolerating punctuation.
 *
 * A plain `\b...\b` wrapper is wrong for real brand names. `\b` asserts a
 * word/non-word transition, so `\bC\+\+\b` can never match "C++ " — the
 * character after `+` is a space, and neither is a word character, so there is
 * no boundary there. The same silently breaks "Yahoo!", "AT&T" and any other
 * brand that does not begin and end alphanumerically: the visibility check would
 * report them as never mentioned.
 *
 * So the boundary assertion is chosen per end: `\b` where the brand's own edge
 * is a word character (keeping "Coda" from matching inside "Codator"), and a
 * whitespace-boundary lookaround where it is not.
 */
function brandPattern(brandLower: string): RegExp {
  const escaped = escapeRegex(brandLower);
  const lead = /^\w/.test(brandLower) ? '\\b' : '(?<!\\S)';
  const trail = /\w$/.test(brandLower) ? '\\b' : '(?!\\S)';
  return new RegExp(`${lead}${escaped}${trail}`, 'i');
}

export function aiVisibilityToActions(report: AiVisibilityReport): Action[] {
  const actions: Action[] = [];

  if (report.visibility_score < 40 && report.queries_run > 0) {
    actions.push(
      action({
        id: 'ai.low_visibility',
        priority: 'high',
        effort: 'large',
        category: 'ai-visibility',
        title: `Brand appears in only ${report.visibility_rate}% of AI assistant answers for this topic`,
        detail:
          'A growing share of commercial research never reaches a search result page — the assistant answers directly. ' +
          'Assistants name brands they find discussed on third-party sources they trust: comparison articles, ' +
          'review sites, forum threads, and structured pages that state clearly what the product is and who it is for. ' +
          'Improving this is a digital-PR and content-clarity problem more than a technical SEO one.',
        impact_score: round(clamp(90 - report.visibility_score, 0, 95), 1),
        evidence: {
          visibility_rate: report.visibility_rate,
          citation_rate: report.citation_rate,
          losing_prompts: report.losing_prompts.slice(0, 5),
          competitors_winning: report.competitor_share.slice(0, 5),
        },
        fix: { type: 'improve_ai_visibility', affected: report.losing_prompts.slice(0, 5) },
      }),
    );
  }

  if (report.citation_rate < 20 && report.visibility_rate > 30) {
    actions.push(
      action({
        id: 'ai.mentioned_not_cited',
        priority: 'medium',
        effort: 'medium',
        category: 'ai-visibility',
        title: `Named in ${report.visibility_rate}% of answers but own site cited in only ${report.citation_rate}%`,
        detail:
          'Assistants know the brand but source their claims elsewhere, so competitors and review sites control the ' +
          'narrative. Publish the pages an assistant would want to cite: specific pricing, a plain feature comparison, ' +
          'and clear "who this is for" positioning — the factual pages that are easy to quote.',
        impact_score: 62,
        evidence: { visibility_rate: report.visibility_rate, citation_rate: report.citation_rate },
        fix: { type: 'publish_citable_pages' },
      }),
    );
  }

  const sentiment = report.sentiment;
  if (sentiment && (sentiment.label === 'negative' || sentiment.label === 'mixed') && sentiment.weaknesses.length > 0) {
    actions.push(
      action({
        id: 'ai.negative_narrative',
        priority: sentiment.label === 'negative' ? 'high' : 'medium',
        effort: 'medium',
        category: 'ai-visibility',
        title: `AI assistants describe the brand as ${sentiment.label} (${sentiment.score > 0 ? '+' : ''}${sentiment.score}/100)`,
        detail:
          `Recurring criticism: ${sentiment.weaknesses.slice(0, 3).join('; ')}. ` +
          'Assistants repeat whatever the sources they trust say, so this narrative lives on third-party ' +
          'review sites, comparison articles and forum threads rather than on your own pages. Publish ' +
          'material that directly addresses each criticism, and where a claim is out of date, get the ' +
          'source updated — being named more often does not help while the description stays this one.',
        impact_score: round(clamp(55 - sentiment.score * 0.35, 0, 95), 1),
        evidence: {
          sentiment_score: sentiment.score,
          label: sentiment.label,
          weaknesses: sentiment.weaknesses,
          strengths: sentiment.strengths,
          example_claims: sentiment.mentions.slice(0, 4),
        },
        fix: { type: 'correct_brand_narrative', affected: sentiment.weaknesses.slice(0, 5) },
      }),
    );
  }

  if (sentiment && sentiment.inaccuracies.length > 0) {
    actions.push(
      action({
        id: 'ai.factual_inaccuracies',
        priority: 'high',
        effort: 'small',
        category: 'ai-visibility',
        title: `Correct ${sentiment.inaccuracies.length} inaccurate claim(s) AI assistants make about the brand`,
        detail:
          'These are stated as fact but are wrong, outdated or self-contradictory. They are the cheapest ' +
          'AI-visibility fix available: publish an unambiguous, easily-quoted page stating the correct ' +
          'figure or capability, and correct the third-party sources the assistants cited.',
        impact_score: round(clamp(60 + sentiment.inaccuracies.length * 5, 0, 90), 1),
        evidence: { inaccuracies: sentiment.inaccuracies },
        fix: { type: 'publish_correction', affected: sentiment.inaccuracies },
      }),
    );
  }

  const dominant = report.competitor_share[0];
  if (dominant && dominant.share_pct > 25) {
    actions.push(
      action({
        id: 'ai.competitor_dominance',
        priority: 'medium',
        effort: 'large',
        category: 'ai-visibility',
        title: `${dominant.name} holds ${dominant.share_pct}% share of voice in AI answers for this topic`,
        detail:
          'Check which sources the assistant cites when it recommends them — those pages are the leverage point. ' +
          'Getting represented in the same comparison articles and listicles is usually faster than out-ranking them organically.',
        impact_score: round(clamp(35 + dominant.share_pct, 0, 80), 1),
        evidence: { competitor_share: report.competitor_share.slice(0, 5) },
        fix: { type: 'target_citation_sources', to: dominant.name },
      }),
    );
  }

  return actions;
}
