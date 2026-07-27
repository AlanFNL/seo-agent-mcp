import { describe, it, expect } from 'vitest';
import {
  scoreContent,
  contentScoreToActions,
  competitiveTerms,
  parseMarkdownHeadings,
  stripMarkdown,
} from '../src/content/optimize.js';
import { discoverPatterns, buildPseoPlan, checkIndexRisk, matchEntity } from '../src/pseo/index.js';
import { toKeywords } from '../src/keywords/cluster.js';
import { scoreKeywords } from '../src/keywords/score.js';
import {
  findStrikingDistance,
  findCtrOpportunities,
  findCannibalization,
  findDecay,
  findRisingQueries,
} from '../src/analysis/gsc-insights.js';
import type { GscRow } from '../src/providers/gsc.js';
import { buildBriefWithoutSerp } from '../src/content/brief.js';
import { clusterByLexical } from '../src/keywords/cluster.js';
import { clusterPageSpec } from '../src/keywords/cluster.js';

// ---------------------------------------------------------------------------
// Content scoring
// ---------------------------------------------------------------------------

const GOOD_DRAFT = `# Best CRM Software for Small Teams

Choosing the best CRM software comes down to pipeline management, contact management,
and whether there is a free trial you can test with real data.

## Pipeline management

Good pipeline management means seeing every deal and its stage at a glance.

## Contact management

Contact management is where teams live day to day. Look for deduplication and history.

## Pricing and free trial

Most vendors offer a free trial. Compare pricing across seat tiers.

${'Every serious evaluation should include a hands-on test with your own data. '.repeat(50)}
`;

describe('scoreContent discrimination', () => {
  const KW = 'employee time tracking software';

  // The scorer's whole purpose is to rank better content above worse content.
  // It used to fail that outright on body-only input: a well-structured article
  // scored 26.5 while 600 words of filler that never mentioned the keyword
  // scored 27.0. Two causes — unsupplied title/URL/meta counted as misses, and a
  // four-word phrase used a normal six times read as 9.16% "density" and was
  // penalised as stuffing.
  // Deliberately 6 mentions across ~260 words: enough to clear the
  // `primaryCount > 5` guard so the density-vs-mention-rate distinction is
  // actually exercised. A shorter fixture with 4 mentions let the old
  // word-share logic pass this suite for the wrong reason.
  const article = [
    '# Employee Time Tracking Software: A Practical Buyer\'s Guide',
    '',
    'Employee time tracking software records the hours your team works and turns them into payroll and client invoices. This guide explains how to choose one, what it costs, and where teams get it wrong.',
    '',
    '## What employee time tracking software actually does',
    '',
    'At its core it captures start and stop times, then attributes them to a project, client or cost code. Modern tools add automatic idle detection, GPS for field crews, and approval workflows so a manager signs off before hours reach payroll.',
    '',
    '## How to choose employee time tracking software',
    '',
    'Start with how your team actually logs hours. Desk teams accept a browser timer; field crews need a phone app that works offline and syncs later. If you bill clients, per-project profitability matters more than raw totals.',
    '',
    '## Pricing',
    '',
    'Most vendors charge per user per month, between five and twelve dollars. Watch for tiers that hide approvals or overtime rules behind an enterprise plan.',
    '',
    '## Common mistakes',
    '',
    'Rounding rules cause more payroll disputes than any other setting. Decide whether you round to the nearest minute or the nearest six minutes, document it, and apply it consistently.',
    '',
    '## Frequently asked questions',
    '',
    'Several jurisdictions require you to tell employees what is recorded, especially for GPS or screenshots. Most employee time tracking software exports to the major payroll providers directly.',
    '',
    '## Conclusion',
    '',
    'The right employee time tracking software is the one your team will actually use every day. Pilot two options with a real crew before committing.',
  ].join('\n');

  const stuffed = `${KW} is the best ${KW}. Our ${KW} beats other ${KW}. Buy ${KW} now. ${KW} ${KW}.`.repeat(3);
  const offTopic = 'Managing a workforce involves many considerations. Teams need clarity about expectations. '.repeat(30);

  it('ranks a good article above off-topic filler above keyword stuffing', () => {
    const good = scoreContent({ body: article }, { primary: KW }).score;
    const filler = scoreContent({ body: offTopic }, { primary: KW }).score;
    const spam = scoreContent({ body: stuffed }, { primary: KW }).score;
    expect(good, `good ${good} must beat filler ${filler}`).toBeGreaterThan(filler);
    expect(filler, `filler ${filler} must beat spam ${spam}`).toBeGreaterThan(spam);
    // And the good one has to land somewhere usable, not just relatively higher.
    expect(good).toBeGreaterThan(60);
  });

  it('does not flag a normal multi-word phrase as over-optimised', () => {
    const s = scoreContent({ body: article }, { primary: KW });
    expect(s.over_optimized).toBe(false);
    // Word-share density is still reported, and for a four-word phrase it is
    // well above the old 3.5% trigger — which is exactly why the judgement moved
    // to the length-independent mention rate.
    expect(s.keyword_density).toBeGreaterThan(3.5);
    expect(s.mentions_per_100_words).toBeLessThan(3.5);
  });

  it('still flags genuine stuffing', () => {
    const s = scoreContent({ body: stuffed }, { primary: KW });
    expect(s.over_optimized).toBe(true);
    expect(s.mentions_per_100_words).toBeGreaterThan(3.5);
  });

  it('excludes draft fields that were never supplied, but not a real page missing them', () => {
    const draft = scoreContent({ body: article }, { primary: KW });
    const byLocation = (s: typeof draft, loc: string) => s.placements.find((pl) => pl.location === loc);
    expect(byLocation(draft, 'title')?.applicable).toBe(false);
    expect(byLocation(draft, 'url')?.applicable).toBe(false);
    expect(byLocation(draft, 'meta_description')?.applicable).toBe(false);
    // Body-derived checks are always in scope.
    expect(byLocation(draft, 'h1')?.applicable).toBe(true);

    // Supplying a title brings it back into scope, and a wrong one costs marks.
    const withBadTitle = scoreContent({ body: article, title: 'Unrelated Heading' }, { primary: KW });
    expect(byLocation(withBadTitle, 'title')?.applicable).toBe(true);
    expect(byLocation(withBadTitle, 'title')?.present).toBe(false);
    expect(withBadTitle.score).toBeLessThan(draft.score);
  });

  it('still recommends writing the missing title even though it is not scored', () => {
    const doc = { body: article };
    const actions = contentScoreToActions(scoreContent(doc, { primary: KW }), doc);
    expect(actions.some((a) => /title/i.test(a.title))).toBe(true);
  });
});

describe('scoreContent', () => {
  const target = {
    primary: 'best crm software',
    secondary: ['crm pricing'],
    required_terms: ['pipeline management', 'contact management', 'free trial'],
    target_words: 800,
  };

  it('grades a well-optimised draft highly', () => {
    const s = scoreContent(
      {
        title: 'Best CRM Software for Small Teams',
        meta_description: 'A practical guide to the best CRM software, covering pipeline management and pricing.',
        body: GOOD_DRAFT,
        url: '/blog/best-crm-software',
      },
      target,
    );
    expect(s.score).toBeGreaterThan(75);
    expect(['A', 'B']).toContain(s.grade);
    expect(s.required_terms_coverage.coverage_pct).toBe(100);
  });

  it('grades an off-target draft as failing and names every missing placement', () => {
    const s = scoreContent({ title: 'Some Thoughts', body: 'We sell things.\n\nThat is all.', url: '/x' }, target);
    expect(s.grade).toBe('F');
    const missing = s.placements.filter((p) => !p.present).map((p) => p.location);
    expect(missing).toContain('title');
    expect(missing).toContain('h1');
    expect(s.required_terms_coverage.missing).toHaveLength(3);
  });

  it('detects keyword stuffing and fails it outright', () => {
    const stuffed = `# Best CRM Software\n\n${'Best CRM software is the best CRM software. '.repeat(40)}`;
    const s = scoreContent({ title: 'Best CRM Software', body: stuffed, url: '/x' }, { primary: 'best crm software' });
    expect(s.over_optimized).toBe(true);
    expect(s.keyword_density).toBeGreaterThan(3.5);
    // Placement points alone must not carry a stuffed page to a passing grade.
    expect(s.score).toBeLessThan(40);
  });

  it('credits a term used only as a section heading', () => {
    const body = '# Title\n\n## Pipeline management\n\nSome prose that never repeats the phrase.';
    const s = scoreContent({ title: 'Title', body }, { primary: 'title', required_terms: ['pipeline management'] });
    expect(s.required_terms_coverage.covered).toContain('pipeline management');
  });

  it('reports internal vs external links from markdown', () => {
    const body = '# T\n\n[internal](/other-page) and [external](https://other.com/x)';
    const s = scoreContent({ title: 'T', body }, { primary: 't' });
    expect(s.structure.internal_links).toBe(1);
    expect(s.structure.external_links).toBe(1);
  });

  it('is deterministic', () => {
    const a = scoreContent({ title: 'T', body: GOOD_DRAFT }, target).score;
    const b = scoreContent({ title: 'T', body: GOOD_DRAFT }, target).score;
    expect(a).toBe(b);
  });

  it('handles empty input without throwing', () => {
    expect(() => scoreContent({ body: '' }, { primary: 'x' })).not.toThrow();
  });
});

describe('contentScoreToActions', () => {
  it('proposes a concrete replacement title containing the keyword', () => {
    const input = { title: 'Random Unrelated Title', body: 'nothing here', url: '/x' };
    const s = scoreContent(input, { primary: 'best crm software' });
    const titleFix = contentScoreToActions(s, input).find((a) => a.fix?.type === 'set_title');
    expect(titleFix).toBeDefined();
    expect(String(titleFix?.fix?.to).toLowerCase()).toContain('crm software');
    expect(String(titleFix?.fix?.to).length).toBeLessThanOrEqual(60);
    // Acronyms should not be title-cased into "Crm".
    expect(titleFix?.fix?.to).toContain('CRM');
  });

  it('ranks the critical title fix above the low-priority meta fix', () => {
    const input = { title: 'Nope', body: 'x', url: '/x' };
    const actions = contentScoreToActions(scoreContent(input, { primary: 'target keyword' }), input);
    const titleIdx = actions.findIndex((a) => a.fix?.type === 'set_title');
    const metaIdx = actions.findIndex((a) => a.fix?.type === 'set_meta_description');
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    if (metaIdx >= 0) expect(titleIdx).toBeLessThan(metaIdx);
  });
});

describe('markdown handling', () => {
  it('parses ATX and setext headings but ignores fenced code', () => {
    const md = '# One\n\nSetext\n======\n\n```\n# not a heading\n```\n\n## Two';
    const levels = parseMarkdownHeadings(md).map((h) => `${h.level}:${h.text}`);
    expect(levels).toContain('1:One');
    expect(levels).toContain('1:Setext');
    expect(levels).toContain('2:Two');
    expect(levels.join()).not.toContain('not a heading');
  });

  it('strips markup and code so word counts reflect prose', () => {
    const out = stripMarkdown('# H\n\n**bold** and [link](http://x) and `code`\n\n```\nsecret\n```');
    expect(out).toContain('bold');
    expect(out).toContain('link');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('](');
  });
});

describe('competitiveTerms', () => {
  it('surfaces terms most competitors share, not one-off mentions', () => {
    const docs = [
      `${'pipeline management matters. '.repeat(5)} unique alpha term here twice, unique alpha term.`,
      `${'pipeline management matters. '.repeat(5)} different beta phrase twice, different beta phrase.`,
      `${'pipeline management matters. '.repeat(5)} third gamma wording twice, third gamma wording.`,
    ];
    const terms = competitiveTerms(docs, { limit: 20 }).map((t) => t.term);
    expect(terms).toContain('pipeline management');
    expect(terms).not.toContain('unique alpha');
  });

  it('returns nothing for an empty corpus', () => {
    expect(competitiveTerms([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Programmatic SEO
// ---------------------------------------------------------------------------

describe('required section headings', () => {
  // Headings must read correctly whatever the variable slot turns out to hold.
  // Two earlier designs guessed at the entity's part of speech and both leaked:
  // keying off slot_position gave "What is Accountants?" for a suffix audience,
  // and a qualifier blocklist still allowed "What is Cheap?" and "What is Buy?".
  // The frame is now "<substituted phrase>: <aspect>", which is grammatical for
  // an audience, an adjective, a verb, a year or a proper noun alike.
  const patternFor = (kws: string[], template: string) => {
    const scored = scoreKeywords(toKeywords(kws));
    const pattern = discoverPatterns(scored, { minMatches: 4 }).find((pt) => pt.template === template);
    expect(pattern, `pattern ${template} not discovered`).toBeDefined();
    return { scored, pattern: pattern! };
  };

  const headingsFor = (kws: string[], template: string) => {
    const { scored, pattern } = patternFor(kws, template);
    return buildPseoPlan(pattern, scored, { basePath: '/p' })
      .pages.flatMap((pg) => pg.required_sections.map((sec) => sec.heading));
  };

  const SUFFIX_AUDIENCE = [
    'time tracking software for accountants', 'time tracking software for agencies',
    'time tracking software for architects', 'time tracking software for consultants',
    'time tracking software for freelancers', 'time tracking software for engineers',
  ];
  const PREFIX_QUALIFIER = [
    'cheap employee time tracking software', 'free employee time tracking software',
    'best employee time tracking software', 'simple employee time tracking software',
    'automated employee time tracking software',
  ];
  const PREFIX_VERB = [
    'buy crm software', 'download crm software', 'compare crm software',
    'review crm software', 'trial crm software',
  ];
  const PREFIX_NOUN = [
    'notion alternatives', 'airtable alternatives', 'asana alternatives',
    'trello alternatives', 'monday alternatives', 'clickup alternatives',
  ];

  it('never emits a heading that asks "What is <single word>?"', () => {
    // The exact shape of every leaked case: "What is Accountants?", "What is
    // Cheap?", "What is Buy?".
    for (const [kws, template] of [
      [SUFFIX_AUDIENCE, 'time tracking software for {x}'],
      [PREFIX_QUALIFIER, '{x} employee time tracking software'],
      [PREFIX_VERB, '{x} crm software'],
      [PREFIX_NOUN, '{x} alternatives'],
    ] as Array<[string[], string]>) {
      for (const h of headingsFor(kws, template)) {
        expect(h, `bad heading for ${template}`).not.toMatch(/^What is [A-Z][a-z]+\?$/);
      }
    }
  });

  it('names the whole substituted phrase in the opening section', () => {
    expect(headingsFor(SUFFIX_AUDIENCE, 'time tracking software for {x}'))
      .toContain('Time tracking software for accountants: overview');
    expect(headingsFor(PREFIX_QUALIFIER, '{x} employee time tracking software'))
      .toContain('Cheap employee time tracking software: overview');
    expect(headingsFor(PREFIX_VERB, '{x} crm software'))
      .toContain('Buy crm software: overview');
  });

  it('does not double a trailing noun on tool pages', () => {
    // "<phrase> tool" gave "Invoice generator cost tool" when the phrase already
    // ended in a noun of its own.
    const headings = headingsFor(
      ['invoice generator cost', 'invoice generator template', 'invoice generator pdf',
       'invoice generator excel', 'invoice generator online'],
      'invoice generator {x}',
    );
    for (const h of headings) expect(h).not.toMatch(/\btool tool\b/i);
    expect(headings.some((h) => /: the tool$/.test(h))).toBe(true);
  });
});

describe('discoverPatterns', () => {
  const kws = scoreKeywords(
    toKeywords([
      'notion alternatives', 'airtable alternatives', 'asana alternatives', 'trello alternatives',
      'monday alternatives', 'clickup alternatives', 'basecamp alternatives',
      'notion pricing', 'airtable pricing', 'asana pricing', 'trello pricing',
      'how to use notion',
    ]),
  );

  it('finds the repeating template and lists its entities', () => {
    const patterns = discoverPatterns(kws, { minMatches: 4 });
    const alt = patterns.find((p) => p.template === '{x} alternatives');
    expect(alt).toBeDefined();
    expect(alt?.entities).toContain('notion');
    expect(alt?.entities.length).toBeGreaterThanOrEqual(7);
  });

  it('ranks a pattern with more entities above one with fewer', () => {
    const patterns = discoverPatterns(kws, { minMatches: 4 });
    const alt = patterns.find((p) => p.template === '{x} alternatives');
    const pricing = patterns.find((p) => p.template === '{x} pricing');
    if (alt && pricing) expect(alt.viability).toBeGreaterThan(pricing.viability);
  });

  it('ignores templates below the entity threshold', () => {
    const patterns = discoverPatterns(kws, { minMatches: 20 });
    expect(patterns).toHaveLength(0);
  });

  it('returns nothing for keywords with no shared structure', () => {
    const random = scoreKeywords(toKeywords(['apple orange', 'quantum tunnelling', 'baroque architecture']));
    expect(discoverPatterns(random, { minMatches: 3 })).toHaveLength(0);
  });
});

describe('matchEntity', () => {
  it('extracts the variable slot only on an exact structural match', () => {
    expect(matchEntity('notion alternatives', '{x} alternatives')).toBe('notion');
    expect(matchEntity('best notion software', 'best {x} software')).toBe('notion');
    expect(matchEntity('notion pricing', '{x} alternatives')).toBeNull();
    expect(matchEntity('notion alternatives 2026', '{x} alternatives')).toBeNull();
  });
});

describe('buildPseoPlan', () => {
  const kws = scoreKeywords(
    toKeywords(['notion alternatives', 'airtable alternatives', 'asana alternatives', 'trello alternatives', 'monday alternatives']),
  );
  const pattern = discoverPatterns(kws, { minMatches: 4 })[0]!;

  it('produces one spec per entity with distinct URLs and titles', () => {
    const plan = buildPseoPlan(pattern, kws, { basePath: '/alternatives' });
    expect(plan.total_pages).toBe(5);
    expect(new Set(plan.pages.map((p) => p.url_path)).size).toBe(5);
    expect(new Set(plan.pages.map((p) => p.title)).size).toBe(5);
    expect(plan.pages.every((p) => p.url_path.startsWith('/alternatives/'))).toBe(true);
  });

  it('marks the sections that must be unique per entity', () => {
    const plan = buildPseoPlan(pattern, kws);
    const unique = plan.pages[0]?.required_sections.filter((s) => s.unique) ?? [];
    expect(unique.length).toBeGreaterThan(0);
  });

  it('builds an internal link mesh and never self-links', () => {
    const plan = buildPseoPlan(pattern, kws);
    for (const p of plan.pages) {
      expect(p.internal_links.length).toBeGreaterThan(0);
      expect(p.internal_links).not.toContain(p.url_path);
    }
  });

  it('skips entities whose URL already exists', () => {
    const plan = buildPseoPlan(pattern, kws, {
      basePath: '/alternatives',
      existingUrls: ['/alternatives/notion-alternatives'],
    });
    expect(plan.pages.map((p) => p.url_path)).not.toContain('/alternatives/notion-alternatives');
  });

  it('warns when it caps the page count', () => {
    const plan = buildPseoPlan(pattern, kws, { limit: 2 });
    expect(plan.total_pages).toBe(2);
    expect(plan.warnings.join(' ')).toMatch(/capped/i);
  });

  it('always states the uniqueness requirements', () => {
    expect(buildPseoPlan(pattern, kws).uniqueness_requirements.length).toBeGreaterThan(3);
  });
});

describe('checkIndexRisk', () => {
  const doorway = ['notion', 'airtable', 'asana', 'trello', 'monday'].map((e) => ({
    url: `/a/${e}`,
    title: `${e} Alternatives`,
    meta_description: 'Compare the best alternatives available today for your team.',
    body: `Looking for ${e} alternatives? We compare the best options. ${e} is popular but not for everyone. `.repeat(10),
  }));

  const differentiated = [
    {
      url: '/a/notion',
      title: 'Notion Alternatives',
      meta_description: 'Nine Notion alternatives compared on pricing and offline support.',
      body: 'Notion combines documents and databases in one workspace, which is why replacing it is awkward. Coda matches the database model most closely at eleven dollars per doc maker. Obsidian trades collaboration for local-first markdown files. '.repeat(8),
    },
    {
      url: '/a/airtable',
      title: 'Airtable Alternatives Compared',
      meta_description: 'Six Airtable alternatives for teams hitting record limits.',
      body: 'Airtable is a relational database wearing a spreadsheet costume, and pricing punishes growth past fifty thousand records. Baserow is open source and self-hostable. NocoDB wraps an existing Postgres database rather than storing data. '.repeat(8),
    },
    {
      url: '/a/asana',
      title: 'Asana Alternatives For Small Teams',
      meta_description: 'Five Asana alternatives that keep dependencies without the enterprise price.',
      body: 'Asana priced timeline and dependency features into Premium, which is where small teams start looking elsewhere. Height offers dependencies free. Linear is faster but assumes engineering workflows. Basecamp charges a flat rate. '.repeat(8),
    },
  ];

  it('refuses to publish a doorway-page set', () => {
    const r = checkIndexRisk({ pages: doorway });
    expect(r.verdict).toBe('do_not_publish');
    expect(r.risk_score).toBeGreaterThan(55);
    expect(r.avg_uniqueness).toBeLessThan(30);
    expect(r.duplicate_clusters.length).toBeGreaterThan(0);
    expect(r.recommendation).toMatch(/do not publish/i);
  });

  it('clears a genuinely differentiated set', () => {
    const r = checkIndexRisk({ pages: differentiated, minWords: 200 });
    expect(r.verdict).toBe('safe');
    expect(r.avg_uniqueness).toBeGreaterThan(70);
    expect(r.duplicate_clusters).toHaveLength(0);
  });

  it('catches duplicate titles and metas', () => {
    const r = checkIndexRisk({
      pages: [
        { url: '/a', title: 'Same Title', meta_description: 'Same meta', body: 'alpha beta gamma '.repeat(100) },
        { url: '/b', title: 'Same Title', meta_description: 'Same meta', body: 'delta epsilon zeta '.repeat(100) },
      ],
    });
    expect(r.duplicate_titles).toHaveLength(1);
    expect(r.duplicate_metas).toHaveLength(1);
  });

  it('flags thin pages against the configured floor', () => {
    const r = checkIndexRisk({ pages: [{ url: '/a', title: 'T', body: 'only a few words here' }], minWords: 300 });
    expect(r.thin_pages).toHaveLength(1);
  });

  it('handles an empty input safely', () => {
    const r = checkIndexRisk({ pages: [] });
    expect(r.verdict).toBe('safe');
    expect(r.pages_checked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Search Console insight extraction
// ---------------------------------------------------------------------------

const row = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({
  keys,
  clicks,
  impressions,
  ctr: impressions > 0 ? clicks / impressions : 0,
  position,
});

describe('GSC insights', () => {
  it('finds striking-distance queries and ignores those already on page one', () => {
    const rows = [
      row(['near miss', '/a'], 5, 1000, 12),
      row(['already top', '/b'], 300, 1000, 2),
      row(['too deep', '/c'], 0, 1000, 60),
      row(['no volume', '/d'], 0, 3, 12),
    ];
    const out = findStrikingDistance(rows, { minImpressions: 30 });
    const queries = out.map((r) => r.query);
    expect(queries).toContain('near miss');
    expect(queries).not.toContain('already top');
    expect(queries).not.toContain('too deep');
    expect(queries).not.toContain('no volume');
    expect(out[0]?.potential_gain).toBeGreaterThan(0);
  });

  it('finds CTR underperformers relative to their position, not absolutely', () => {
    const rows = [
      // Position 2 should earn ~15% CTR; 1% is a snippet problem.
      row(['bad snippet', '/a'], 10, 1000, 2),
      // Position 9 earning its normal rate is not a problem.
      row(['normal', '/b'], 28, 1000, 9),
    ];
    const out = findCtrOpportunities(rows, { minImpressions: 100 });
    expect(out.map((r) => r.query)).toEqual(['bad snippet']);
    expect(out[0]?.expected_ctr).toBeGreaterThan(out[0]?.actual_ctr ?? 0);
  });

  it('detects cannibalisation and picks the best-positioned page to consolidate onto', () => {
    const rows = [
      row(['shared query', '/best'], 50, 500, 4),
      row(['shared query', '/worse'], 5, 400, 11),
      row(['solo query', '/x'], 20, 300, 3),
    ];
    const out = findCannibalization(rows, { minImpressions: 50 });
    expect(out).toHaveLength(1);
    expect(out[0]?.primary_page).toBe('/best');
    expect(out[0]?.severity).toBe('high');
  });

  it('does not report a page that barely appears as cannibalising', () => {
    const rows = [
      row(['q', '/main'], 100, 1000, 3),
      row(['q', '/incidental'], 0, 5, 80),
    ];
    expect(findCannibalization(rows, { minImpressions: 50 })).toHaveLength(0);
  });

  it('detects decay and attributes the cause', () => {
    const before = [row(['/lost-rank'], 100, 1000, 3), row(['/lost-demand'], 100, 1000, 3)];
    const after = [row(['/lost-rank'], 20, 1000, 15), row(['/lost-demand'], 20, 200, 3)];
    const out = findDecay(before, after);
    expect(out.find((d) => d.page === '/lost-rank')?.likely_cause).toBe('lost_rankings');
    expect(out.find((d) => d.page === '/lost-demand')?.likely_cause).toBe('lost_impressions');
  });

  it('ignores pages that grew', () => {
    expect(findDecay([row(['/up'], 10, 100, 5)], [row(['/up'], 50, 500, 3)])).toHaveLength(0);
  });

  it('finds rising queries and marks the ones we cannot yet capitalise on', () => {
    const before = [row(['growing'], 5, 100, 30)];
    const after = [row(['growing'], 10, 900, 30)];
    const out = findRisingQueries(before, after, { minImpressionsAfter: 50 });
    expect(out).toHaveLength(1);
    expect(out[0]?.untapped).toBe(true);
    expect(out[0]?.growth_pct).toBeGreaterThan(100);
  });

  it('treats a brand-new query as growth rather than dividing by zero', () => {
    const out = findRisingQueries([], [row(['brand new'], 2, 500, 40)], { minImpressionsAfter: 50 });
    expect(out).toHaveLength(1);
    expect(Number.isFinite(out[0]?.growth_pct as number)).toBe(true);
  });
});

describe('pSEO output language', () => {
  // Titles, meta descriptions and section headings are page copy. A Spanish
  // keyword set was coming back with "Compare options for software de
  // facturacion para autonomos" and headings like "Frequently asked questions",
  // plus English Title Case, which reads as a mistake in Spanish.
  const kws = scoreKeywords(
    toKeywords([
      'software de facturacion para monotributistas', 'software de facturacion para pymes',
      'software de facturacion para comercios', 'software de facturacion para restaurantes',
      'software de facturacion para profesionales', 'software de facturacion para autonomos',
    ]),
  );
  const pattern = () => discoverPatterns(kws, { minMatches: 4 })[0]!;

  it('writes Spanish headings and meta for a Spanish plan', () => {
    const page = buildPseoPlan(pattern(), kws, { basePath: '/f', language: 'es' }).pages[0]!;
    const headings = page.required_sections.map((s) => s.heading);
    expect(headings.some((h) => h.endsWith(': qué es'))).toBe(true);
    expect(headings).toContain('Preguntas frecuentes');
    expect(headings).toContain('Aspectos clave');
    expect(headings.some((h) => /overview|Frequently asked/.test(h))).toBe(false);
    expect(page.meta_description).toMatch(/^Compara opciones de/);
  });

  it('uses sentence case for Spanish titles, not Title Case', () => {
    const es = buildPseoPlan(pattern(), kws, { basePath: '/f', language: 'es' }).pages[0]!;
    const en = buildPseoPlan(pattern(), kws, { basePath: '/f', language: 'en' }).pages[0]!;
    expect(es.h1).toContain('de facturacion para');
    expect(en.h1).toContain('De Facturacion Para');
  });

  it('leaves English plans exactly as they were', () => {
    const page = buildPseoPlan(pattern(), kws, { basePath: '/f', language: 'en' }).pages[0]!;
    const headings = page.required_sections.map((s) => s.heading);
    expect(headings.some((h) => h.endsWith(': overview'))).toBe(true);
    expect(headings).toContain('Frequently asked questions');
    expect(page.meta_description).toMatch(/^Compare options for/);
  });
});

describe('cluster and brief page copy by language', () => {
  it('suggests Spanish cluster page titles', () => {
    const kws = scoreKeywords(
      toKeywords([
        'mejor software de facturacion', 'software de facturacion opiniones',
        'comparativa software de facturacion', 'software de facturacion precios',
      ]),
    );
    const cluster = clusterByLexical(kws).clusters[0]!;
    const es = clusterPageSpec(cluster, 'es');
    const en = clusterPageSpec(cluster, 'en');
    // English Title Case reads as a mistake in Spanish.
    expect(es.h1).not.toMatch(/ De | Para /);
    expect(es.title).not.toMatch(/Compared|Complete Guide|Definition & Examples/);
    expect(en.title === es.title).toBe(false);
  });

  it('writes a Spanish brief outline, title and meta', () => {
    const es = buildBriefWithoutSerp('software de facturacion para monotributistas', [], [], [], 'es');
    const en = buildBriefWithoutSerp('software de facturacion para monotributistas', [], [], [], 'en');
    expect(es.suggested_meta_description).toMatch(/^Compara opciones de/);
    expect(en.suggested_meta_description).toMatch(/^Compare options for/);
    const esHeadings = es.suggested_outline.map((o) => o.heading).join(' | ');
    expect(esHeadings).not.toMatch(/Quick Answer|Which Option|Frequently Asked/);
    expect(esHeadings).toMatch(/respuesta rápida|conviene elegir/);
  });
});
