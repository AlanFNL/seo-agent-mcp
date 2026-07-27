# Working on seo-agent

Guidance for agents (and people) editing this codebase.

## What this is

An MCP server exposing SEO capability to agents. The MCP server is the product; the CLI is a thin shell over the same tool registry for sanity checks and CI.

The whole design rests on one distinction: a human SEO tool shows you data and lets you decide. This one has to *make the decision legible* — because the caller is going to act immediately, and it has no intuition about which of 400 audit findings matters.

## Non-negotiables

**Never invent a metric.** If search volume is unknown, return `null` and say why in `warnings`. A fabricated volume will end up as a content calendar. Same for difficulty: the lexical fallback must always carry `method: "lexical"` and its low `confidence`.

**Every analysis tool returns `actions[]`.** Raw findings force the agent into a second reasoning pass to work out what matters. Actions carry priority, effort, an impact score, evidence, and a machine-applicable `fix` where one exists. Ids must be stable across runs so fixes can be tracked.

**Aggregate, don't enumerate.** 312 missing alt attributes is *one* action affecting 48 pages, not 312 actions. Emitting one issue per occurrence is what made a 25-page crawl produce 550 findings for a single bad nav link — see the comment on `links.to_redirect` in `crawl/audit.ts`.

**Errors must name the remedy and the fallback.** `PROVIDER_NOT_CONFIGURED` should tell the agent which env var to set *and* which free tool to use instead. An agent that hits a wall with no exit just retries.

**Bound the context.** Anything that can return thousands of rows goes through `spill()`, which caps inline output and writes the rest to an artifact.

**Bound the spend.** Metered calls go through `reserve()` / `record()` and are cached with a TTL matched to how fast the data actually changes. Agents loop; one reasoning chain will otherwise fire the same paid call repeatedly.

**Determinism.** Same input, same output. The diffing tools are meaningless otherwise, and they're the most valuable thing here.

## Layout

| Path | Contains |
|---|---|
| `core/` | envelope, types, errors, HTTP, cache, budget, SQLite store, text analysis |
| `crawl/` | crawler, robots, sitemap, HTML extraction, audit rule engine |
| `keywords/` | autocomplete mining, intent, difficulty, opportunity scoring, clustering |
| `analysis/` | internal PageRank + link opportunities, Search Console insights |
| `content/` | competitive brief generation, content scoring |
| `pseo/` | pattern discovery, plan building, index-risk gate |
| `providers/` | SERP, keyword metrics, backlinks, GSC, PageSpeed, AI visibility |
| `mcp/` | tool definitions and registration |

Providers sit behind interfaces. Nothing above `providers/` should know which vendor is configured.

## Adding a tool

1. Define it with `defineTool` in the right `mcp/tools/*.ts` file.
2. Register it in `mcp/tools/index.ts` (order is a workflow hint — some clients display it).
3. Write a description an agent can *select on*. It needs to say what the tool does, when to reach for it, and what it needs. Under ~60 characters is a bug; the e2e suite enforces this.
4. Return `actions[]` if the tool finds problems, and `meta.next` if there's an obvious follow-up call.
5. If it advertises a capability in `config.ts` `describeCapabilities`, it must actually exist. Don't leave a dangling claim — and that includes tool names inside free text like `degraded_to`, `unlock_with`, and error remedies. `tests/references.test.ts` greps the whole of `src/` for `seo_*`/`pseo_*` identifiers and fails on any that isn't registered, so renaming a tool without updating the prose that mentions it is caught.

## Adding an audit rule

Rules live in `crawl/audit.ts` as `{ id, severity, category, description, check(ctx) }`. Emit `Issue`s (facts); actions are derived separately in `issuesToActions` so they can be aggregated.

- Aggregate per page, not per occurrence.
- Severity maps to must-fix / should-fix / consider.
- To surface it as an action, add an entry to the `meta` map in `issuesToActions` with an imperative `title` template.
- Add a test. `tests/audit.test.ts` also asserts every rule survives an empty crawl.

## Testing

```bash
npm test            # 427 tests
npm run typecheck   # strict mode, noUncheckedIndexedAccess
```

`tests/integration.test.ts` spawns the real MCP server over stdio and hits live sites. It needs network access and a prior `npm run build`.

**Test the shipped code path.** Don't re-implement the logic inside the test or hard-code the expected value. Where a test needs a controlled input, build the input and let the real function produce the answer — see the link-opportunity test, which constructs a page graph with exactly one genuine gap and asserts the finder locates it.

**When a test disagrees with the code, work out which is wrong before changing either.** Twenty-five defects were found this way. Every one passed review, and most passed unit tests too. They surfaced only when the code met something real: a live site, a real keyword expansion, a real command line, a packaged install driven over stdio by a client that had never seen the source tree (9 and 10), the documented workflow executed in order with each tool fed the previous one output (11 and 12), or a census that called all 36 tools and bucketed the results by error code (13). Number 14 surfaced because grep kept returning nothing for a file that plainly contained the string. Number 25 surfaced from asking which tools a *specific* free provider actually covers, rather than which capability it switches on. Reviewing the repo will not find these.

1. `parseUrl` prepended `https://` to anything lacking it, turning `mailto:x@y.com` into the plausible-looking `https://mailto:x@y.com/` — which would then be crawled or stored as a canonical target.
2. The simhash prefilter was set to ≤8 bits when real near-duplicates measure 18–25, so it silently discarded every duplicate it existed to catch. Measured, then set to 28.
3. The duplicate-detection length floor counted *unique* tokens. Templated doorway pages repeat one sentence, so a 250-word page has ~15 distinct terms and was skipped by the exact check designed for it. Now gates on document length.
4. Trailing-slash stripping in `normalizeUrl` made the crawler request `/docs` instead of `/docs/`, then reported the server's own 308 correction as a redirect defect — 550 phantom findings on one real 25-page crawl, which buried every genuine one.
5. Lexical clustering over-merged catastrophically on seed-expanded keyword sets, where every entry shares the seed's words: 68 of 76 keywords in one cluster. IDF weighting alone was insufficient — when seed tokens appear in almost-but-not-quite every keyword their IDF is small yet non-zero, and a ratio test still passes trivially (37 of 45 still merged). The working version needs two gates, distinctive-token matching *and* a topical-overlap floor, because each fixes a failure the other introduces. See `shouldJoin`.
6. AI-visibility brand matching wrapped the brand in `\b...\b`. That assertion cannot hold after a non-word character, so any brand ending in punctuation — C++, Yahoo!, AT&T — was reported as never mentioned. See `brandPattern`.
7. The CLI rejected a single value for an array argument (`--competitors a.com`), because the repeat-key parser only builds an array on a second occurrence. Array fields required either two flags or hand-written JSON. The MCP path never hits this, since arguments arrive as typed JSON — which is exactly why it went unnoticed. See `coerceArrayArgs`.
8. `seo_capabilities` advertised three tools that did not exist, left behind when they were consolidated into others. An agent reading the capability list would hunt for something absent. Now enforced by a test.
9. That enforcing test walked `capabilities[].tools` only, so a fourth dangling name survived in *prose*: `degraded_to` for the backlinks capability recommended `seo_mentions_find`, which has never existed. `degraded_to` is the one field an agent reads when it is already blocked, so a bad name there converts one dead end into two.
10. Two error remedies in `providers/gsc.ts` said `seo_gsc_list_sites`; the tool is `seo_gsc_sites`. Both lines only execute when Search Console credentials are configured, which no test can reach — see the static scan below.
11. `requiredSections` interpolated the bare entity into every section heading, which is only correct when the variable slot *leads* the pattern. `{x} alternatives` gives "What is Notion?" — right. `time tracking software for {x}` gives **"What is Accountants?"** and "How Accountants works" on all 24 pages, because there the entity is an audience, not the subject. The headings now key off `slot_position`.
12. `pseo_build_plan` emits page specs keyed on `url_path`; `pseo_check_index_risk` required `url`. Handing the plan's own pages to the gate — the exact handoff the plan's `critical` action instructs — failed schema validation. The gate now accepts either spelling. Friction on a safety path is the worst place to have it: the cheapest way out of a validation error is to skip the check, and that check is the only thing standing between this tool and a doorway-page generator.

13. Two handlers raised input problems with `throw new Error(...)`, which the runtime maps to `INTERNAL` — a code whose remedy reads *"This is likely a bug in seo-agent. Report the message and inputs."* Calling `seo_cluster_keywords` with neither `keywords` nor `project`, and `seo_crawl_diff` with a stale id, both told the agent it had found a bug in the tool rather than that it could fix the call itself. An agent that believes it hit an internal fault stops; one told to pass an argument retries. Both now raise `invalidInput` with a remedy naming the fix. `INTERNAL` must mean *only* "this codebase is broken".
14. `store/diff.ts` used a literal NUL byte as the issue-key delimiter. The code was correct and the tests passed, but `grep`, `ripgrep` and anything else honouring binary detection classify such a file as binary and **skip it silently** — so every text search across the repo missed that file, including the searches used to audit it. Written as the escape `\u0000` it is the identical runtime value in plain-text source. `tests/references.test.ts` now rejects C0 control bytes anywhere in `src/`.

15. `seo_rank_check` and `seo_competitors_discover` fanned out with `mapLimit`, then kept only the successes — `filter(r => r.ok)` and `if (!s.ok) continue`. With no SERP provider **every** lookup failed, so both returned `ok: true`, no warnings, and data saying "ranks for 0 of 0 keyword(s)" and "found 0 competing domains". An agent cannot distinguish that from genuinely ranking for nothing and having no competitors, and it is a confident false negative on the two questions this tool exists to answer. Both now go through `partitionResults`, which rethrows the underlying error when nothing succeeded and warns when only some did. "Partial data beats no data" holds only while there *is* some data.

16. `normalizeError` read only `err.cause.code`, so fetch failures whose code sits elsewhere fell through to `INTERNAL`. Measured shapes: an abrupt socket close gives `cause.code = 'UND_ERR_SOCKET'` (not in the old list), and a refused connection to a local port gives a cause with **no code at all**. Both became "INTERNAL: fetch failed" with the report-a-bug remedy. The second consequence is worse than the label: `fetchWithRetry` does `if (lastError.code === 'INTERNAL') throw lastError`, so every network failure it could not classify **skipped the retry loop entirely** — retries were dead for the most common transient failure there is. Now `causeCode` walks `cause`, nested `cause`, and `AggregateError.errors[]`, unrecognised `E*`/`UND_ERR_*` codes map to NETWORK, and a bare `fetch failed` message is NETWORK rather than a defect claim. Verified end to end: a server that destroys the first connection and answers the second is now retried and recovered.
17. `seo_crawl_site` reported `ok: true`, "Crawled 1 pages" and **"Health score 80.9/100"** for a domain that does not resolve. The failed URL still counted as a page, and the audit dutifully scored the single `status.fetch_failed` issue it produced. `data` was honest — `pages_ok: 0`, the NETWORK error in `data.errors` — but the summary is what an agent reads, and a healthy score for a site that does not exist is a confident wrong answer. A crawl that fetched nothing now throws, carrying the crawler's own diagnosis and distinguishing robots-blocked from unreachable.

18. `seo_ai_visibility` called `record()` after spending but never `reserve()` before, so the most expensive tool here sat entirely outside `SEO_AGENT_BUDGET` — an agent looping over prompt sets could spend without limit while `seo_usage` faithfully reported the overspend afterwards. `seo_page_speed` had the same gap. Both now reserve the worst case first, gated on the key being present so a missing key still reports `PROVIDER_NOT_CONFIGURED` rather than a budget error for spend that could never have happened.
19. `configureBudget` read `maxUnits && maxUnits > 0 ? maxUnits : Infinity`, so `SEO_AGENT_BUDGET=0` — the obvious way to freeze every paid call — was falsy and granted **unlimited** spend. A negative or malformed value did the same. A safety flag that inverts its own meaning is worse than no flag: anything that is not a usable positive number now blocks. This was found by trying to *use* the documented cap rather than by reading its unit tests, which passed throughout because they only ever set positive caps.

20. `scoreContent` counted page-level fields the caller never supplied as failures, so a body-only draft could not exceed ~62 and lost 35% of the score for a title, URL and meta description it had not been given. Placements now carry `applicable`; unsupplied draft fields are excluded from the score while still producing the action that says to write them. A crawled page missing a title stays applicable, because there it is a real defect.
21. Over-optimisation was judged on word-share density, which scales with phrase length. "employee time tracking software" used a perfectly normal 6 times in 248 words reads as 9.68% density and was flagged as keyword stuffing; the same *rate* for a one-word term reads 2.42%. Multi-word phrases are the ordinary case in SEO, so the check penalised correct writing. Conventional density is still reported, but the judgement now uses `mentions_per_100_words`. Together with 20 this was a headline failure: a well-structured article scored **26.5** while 600 words of filler that never mentioned the keyword scored **27.0** — the scorer ranked irrelevant content above good content. Now 80 vs 27, with keyword-stuffed spam at 0.
22. `index.orphan` asserts "nothing on this site links here", but was computed on truncated crawls too, so every sitemap URL the page budget never reached was reported as orphaned. stripe.com with `max_pages=4` produced **1,930 orphan warnings** and a health score of 0, burying all 6 genuine errors. Restricting it to fetched pages is not sufficient either, because the crawl seeds from the sitemap and a seeded page has no inbound link within the crawled subset. It now returns nothing unless link discovery completed, and the tool says the check was skipped. Real orphans are still caught on a complete crawl.

23. The stemmer handled plurals but not gerunds, so `invoice`/`invoicing`, `track`/`tracking`, `bill`/`billing` and `price`/`pricing` all stemmed differently. Gerunds are pervasive in search queries, and the effect was to split one intent across several clusters: "invoice software for freelancers", "freelance invoicing software" and "best invoicing software freelancers" came back as three singleton clusters — three pages competing for one query, which is the cannibalisation this tool's own audit reports. This one was a deliberate trade-off rather than an oversight: the original comment cited "rating" vs "rate" as the reason for avoiding Porter, and that concern is real. The fix keeps it by construction — stripping `-ing` requires a base of at least 4 characters, so "rating" → "rat" is rejected and stays distinct from "rate", while "king", "thing" and "during" are untouched for the same reason. Orthographic 'e' deletion is restricted to c/g/s/v/z, the letters where English actually drops it, so "plane"/"plan" and "care"/"car" cannot collide. De-doubling was tried and abandoned: nothing short of a dictionary distinguishes "running" → "runn" from "billing" → "bill", and guessing turned "billing" into "bil", which matched nothing at all. Losing the run/running merge is much cheaper than a wrong stem.

24. The fix for 11 was itself incomplete, twice. Keying the page subject off `slot_position` handles "time tracking software for {x}", but "{x} employee time tracking software" is *prefix*-slot with x=cheap, so it produced **"What is Cheap?"** — identical nonsense reached from the other direction. Adding a qualifier blocklist then let through **"What is Buy?"** for "{x} crm software", and separately "invoice generator {x}" produced "Invoice generator cost tool" by appending "tool" to a phrase that already ended in a noun.

    The lesson is the shape of the bug, not any individual case: the set of entities that cannot head a sentence is open-ended — adjectives, verbs, audiences, years, prepositional objects — so no heuristic over the entity will hold. Headings are now framed as `<substituted phrase>: <aspect>` ("Buy crm software: overview", "Time tracking software for accountants: how it works"), which is grammatical for every one of those and reads better as an SEO heading than "What is …?" did. Both heuristics were deleted rather than extended. **When a second special case appears for the same bug, stop patching and remove the dependency instead.**

25. `Capability.tools` is documented as *"tools that work at full fidelity with the current configuration"*, but the `backlinks` entry listed `seo_backlinks`, `seo_domain_authority` and `seo_link_gap` unconditionally. `OpenPageRankProvider` implements `authority()` only, so with the free `OPENPAGERANK_API_KEY` set — the configuration a cost-conscious user is most likely to run — `seo_capabilities` advertised two tools that then threw `INVALID_INPUT`. The handler's guard was correct and its message was good; the problem was that capabilities sent the agent there in the first place, and orientation output is trusted precisely because it is read before anything is tried. A capability now reports the tools its *specific* provider covers, and `unlock_with`/`degraded_to` are populated for available-but-partial capabilities rather than only for absent ones. The CLI renders a third state, `~`, since it previously showed the unlock line only when `!available` and would have hidden the limitation entirely. Note the general shape: two providers behind one interface where one implements a subset means "configured" and "fully capable" are different questions, and any capability report that conflates them will lie for the cheaper provider.

Three further corrections were judgement calls that measurement settled, not outright bugs, and they are worth knowing because the reasoning generalises:

- **Cannibalisation severity** gated "high" on the top page holding under 50% of impressions — unreachable with two competing pages, where the floor is 50%. An even 56/44 split is Google flip-flopping and deserves the same urgency, so the bar is 0.65.
- **Health score** let notices accumulate without bound (657 notices scored a site 0/100) and divided site-wide issues like a missing sitemap by page count, so a 1-page site scored 7.5 for seven trivial problems. Notices are now capped and site-level issues are a flat deduction.
- **`seo_keyword_ideas`** returned a wall of nulls with no explanation when no metrics provider was configured, inviting an agent to read "unknown" as "zero demand". It now always says why.

**Run the thing on real input before believing it works.**

## Provider parsers

Every provider's response→domain-object mapping is an exported pure function (`normalize*`, `shape*`, `toMetrics`, …) with fixture tests in `tests/providers.test.ts`. Keep it that way when adding a provider.

The reason is the failure mode, not tidiness: these parsers only run when someone has a paid key, and when a field is misread they return an **empty result rather than an error**. A broken `normalizeRankedKeywords` reports "you have no content gaps"; a broken `normalizeLinkGap` silently drops the which-competitors signal. Neither looks like a bug from the outside.

Two conversions are load-bearing and cross-checked against each other in the tests: Open PageRank reports authority 0-10 and DataForSEO reports 0-1000, and both must land on the shared 0-100 scale or difficulty personalisation quietly rates every keyword trivial or hopeless.

## Mutation testing

Before trusting this suite, break things and check it notices. Comment out a behaviour, run the tests, confirm they go red, revert. It is the only way to tell a real test from one that passes by coincidence.

That exercise found **six features with no effective coverage at all**, every one of them something the suite appeared to test:

- `rankActions` — the sort could be deleted outright and nothing failed, despite impact-per-effort ordering being the central agent-native premise.
- The clustering topical-overlap gate — this file previously *claimed* the regression was covered. It was not.
- `issues.new` in `diffCrawls` — hardcoding it to `[]` passed, even though regression detection is the point of diffing.
- `spill` truncation — the "never floods the context window" guarantee could be removed silently.
- `computePageRank` nofollow handling and `findLinkOpportunities` — both had been checked with throwaway scripts and reported as verified. The scripts were deleted; the verification went with them. **A check that isn't a test isn't verification.**

**Call every tool once with synthesised arguments.** A census that walks `tools/list`, builds arguments from each `inputSchema`, calls the tool and buckets the result by error code takes a minute and is how defect 13 surfaced. It also keeps the documented figures honest — the audit rule count is 53 where the README said 40.

Read a census carefully, though: the first run measured **10** credential-gated tools and this file was "corrected" from 13 to 10 on that basis. The figure was wrong because two of the gated tools were the ones with defect 15 — they reported cheerful empty success instead of `PROVIDER_NOT_CONFIGURED`, so the census counted them as working. A measurement taken through a bug measures the bug. After the fix it reads 13, which is what the file said originally. Current split: 13 gated, 21 immediately usable with no keys, 2 more that need a prior crawl or stored snapshots first.

**Run the documented workflow, not just the units.** Defects 11 and 12 both sat in the pSEO chain — the feature this tool exists for — and both survived a green unit suite. They surfaced only when the chain was executed in order against real autocomplete data: discover → plan → gate, with each tool's actual output fed to the next. Defect 11 in particular is invisible unless you *read* the generated headings; nothing about it throws.

**Re-run the workflow after fixing it, on different data.** Defect 24 is defect 11's fix failing on a pattern of another shape, and it was caught by repeating the same end-to-end run with a different seed keyword. One passing example does not establish that a class of bug is closed; vary the input shape and look at the output again.

**When you change a shared primitive, re-validate what was measured against it.** `simhash`, near-duplicate detection and the 0.85/0.75 similarity thresholds are all built on `stem`, and those numbers were measured against the old stemmer. Changing it could have silently invalidated them, so the templated-vs-distinct pair was re-measured (hamming 15 vs 36, Jaccard 0.939 vs 0.014 — separation intact) and that check is now a test.

**Delete a test that cannot fail.** A cluster-level test for gerund grouping was written, and mutation testing showed removing gerund stemming did not break it: the keywords also shared their other tokens and cleared the overlap floor on their own. A clean isolating test is impossible there by design, so the test was removed and the reason recorded in `tests/keywords.test.ts`, with the mechanism pinned in `tests/text.test.ts` instead. Coverage that cannot fail is worse than none, because it reads as proof.

**Point it at sites whose quality you already know.** Defect 22 was invisible on `example.com` and on a 12-page registry site. Crawling stripe.com and vercel.com — sites with excellent technical SEO — returned health **0/100** with ~1,930 warnings each, which is prima facie absurd and led straight to the cause. Any scoring tool should be run against a few known-good and known-bad references before its numbers are trusted; a score is only meaningful relative to a corpus. After the fix: stripe 18.2, vercel 42, iana.org 19.3, example.com 71.

**Check that a score can actually rank things.** Defects 20 and 21 were found by scoring three drafts — a good article, keyword-stuffed spam, and on-length off-topic filler — and checking the *ordering* rather than any single number. The ordering was wrong, which no individual score could have revealed.

**Use the documented switches, don't just read their tests.** Defects 18 and 19 were invisible from the unit suite, which passed the whole time because it only ever set positive caps. Exporting `SEO_AGENT_BUDGET=0` and watching a metered tool proceed anyway took one command.

**Point the tools at things that are broken.** Defects 15, 16 and 17 all hid behind the happy path: every one of them appears only when a provider is missing or a host is unreachable, which is precisely the state a real agent hits most often and a demo never does. Crawl a domain that does not resolve, call a metered tool with no key, fetch a closed port — then read the *summary*, not the data, because that is what the agent acts on.

**Some strings cannot be reached at runtime.** The two `seo_gsc_list_sites` typos lived on a credential-gated path, and the 13 credential-gated tools' live HTTP paths are unexercised because there are no keys to exercise them with. `tests/references.test.ts` covers that gap the only way available: a static grep over `src/` asserting every tool name mentioned anywhere resolves. It needs no credentials and no network. When a check cannot be a runtime test, make it a static one rather than leaving it unmade.

It also exposed a test passing for the wrong reason: `prefers the higher-impact action` used ids `weak`/`strong`, and the alphabetical tiebreak happened to produce the right order even with `impact_score` removed from the comparator. When asserting an ordering, choose fixture names whose alphabetical order contradicts the expected result.

## Verified correct, and how

Not everything examined turned out to be broken. These were checked properly and hold, which is worth recording so the next person doesn't redo it — or assume it was never done.

- **PageRank is numerically correct.** Cross-checked against an independent power iteration written from the definition `r'[j] = (1-d)/n + d·Σ r[i]/outdeg(i) + d·dangling/n`, on four graph shapes (symmetric cycle, hub with dangling leaves, asymmetric popular page, linear chain). Agreement within 0.005, reference vector summing to exactly 1.0.
- **But its tests were ordering-only.** Every existing assertion would have passed for a monotonic stand-in like inbound-link counting. Four mutations were tried; three died and one survived — removing the division by outdegree, so a page passed its *full* rank down every link. Every graph in the suite had outdegree 1, which makes that mutation invisible. Fixed with a graph where two equal-rank sources have outdegree 1 and 5. **If a numeric routine is only asserted through inequalities, at least one wrong implementation still passes.**
- **Dangling-mass redistribution cannot affect the output**, and that is provable rather than incidental: both fixed points have the form `r = a·(I − dMᵀ)⁻¹·1`, differing only in the scalar `a`, and proportional vectors normalise identically. Measured across four shapes, maximum difference 0.000, while the raw sum moves from 1.0 to as low as 0.15. The code keeps it so the raw vector stays a probability distribution. Don't write a test asserting it changes a score, and don't delete it for lack of coverage — there is a comment at the call site saying so.
- **The CTR curve is monotonic and matches published data** (position 1 at 28%, position 10 at 2.5%), with a guard below position 1.
- **The Search Console insight arithmetic is right.** Verified by hand: striking-distance potential is impressions × CTR@5, `potential_gain` is that minus current clicks, CTR-gap gain is impressions × gap, decay percentage and rising growth both check out. CTR is expressed in percent consistently across every field (`ctr`, `actual_ctr`, `expected_ctr`, `ctr_gap`). `findDecay` expects page-dimension rows and the caller passes page-dimension rows.

## Languages: English and Spanish only

Scope decision, not an accident. Both are Latin-script and fold to ASCII, so `tokenize` stays a simple class.

What Spanish needed, none of which was there and all of which was found by actually running Spanish through the pipeline:

- **Function words.** `el/de/del/para/las/en/la` counted as content, so over half the terms in a typical phrase were noise. That inflates Jaccard between unrelated pages, skews the IDF background-share that clustering depends on, and pads word counts. `SPANISH_STOPWORDS` deliberately excludes `son`, `sea`, `sin`, `solo`, `van`, `era` and `tan` — each is also a real English word and the set is shared.
- **Consonant plurals.** The `-s` rule left `ciudades` as `ciudade` against a singular of `ciudad`, so `gestores de proyectos` never clustered with `gestor de proyectos`. The trailing-`e` strip now has a second threshold at 6+ characters, which fixes Spanish while leaving 4-5 letter English words like rate, plane, site and care untouched.
- **Questions.** `\b` does not fire after an accented letter, so `qué` and `por qué` were not questions while `cómo` happened to pass. And the question-form intent boost used a *second*, English-only regex rather than calling `isQuestion`, so Spanish questions never earned it: `cómo funciona el software de fichaje` scored commercial off the word "software" alone while its English twin came out informational. One duplicated list, two bugs.
- **Accents in phrase signals.** Multi-word signals are stored unaccented but matched against the raw keyword, so `iniciar sesion` never matched `iniciar sesión`. Phrases now also match a folded copy.
- **Expansion modifiers.** English modifiers on a Spanish seed generate "best software de facturacion", which autocomplete cannot answer. Spanish sets returned 184 keywords from 79 requests against 146 from 88.
- **Sentence splitting.** The boundary lookahead was `[A-Z"'(]`, so a Spanish paragraph whose sentences begin with accented capitals collapsed into one: "Él trabaja mucho. Ámbito laboral complejo. Éxito asegurado." counted as **1 sentence, not 3**, and "Es un sistema. ¿Conviene usarlo?" did not split because `¿` was not in the set either. Sentence count drives words-per-sentence, which drives readability and the long-sentence warnings, so this alone made Spanish look far denser than it is — compounding the Flesch problem below. Now `[\p{Lu}\p{Lt}"'(¿¡«"]` with a lookbehind that tolerates a closing quote, which also fixed the English case `He said. "Then it worked." Fine.` merging its last two sentences.
- **Readability.** Flesch's coefficients are fitted to English syllable statistics, so scoring Spanish with them was savage: ordinary prose rated 25.8 against an English equivalent's 88.7, and a routine administrative sentence scored **-68.1**. Spanish now uses Fernández Huerta, and `grade_level` is null rather than a Flesch-Kincaid number pretending to mean a US school grade. The syllable counter also stopped applying the English silent-e rule, which had been costing "clase" a syllable. The field was renamed from `flesch_reading_ease` to `reading_ease` with an explicit `formula`, because a field named after one formula holding another's output is the mislabelling this file keeps warning about.
- **Generated page copy, in three separate places.** Titles, meta descriptions and section headings are page content, so English templates on a Spanish set are simply wrong output. `pseo/index.ts` returned "Compare options for software de facturacion para autonomos"; `keywords/cluster.ts` suggested "Software De Facturacion: Compared & Reviewed (2026)"; `content/brief.ts` produced an outline with "Quick Answer", "Which Option Should You Choose?" and "Frequently Asked Questions". Each was its own template literal in its own switch, and each was found separately.

    A *fourth* instance then turned up that the phrase guard could not have caught, because it was a casing bug rather than a wrong phrase: `buildTitle` and the `set_h1` fix in `content/optimize.ts` proposed literal replacement titles via `titleCase`, so `seo_page_optimize` told a Spanish page to use "Software De Facturacion Para Monotributistas". `ContentScore` now carries the language, and a second guard asserts no module that emits page copy calls `titleCase` directly — casing must route through `headline()`.

    After fixing the same thing twice, the third one prompted the structural fix instead of a third patch: all page copy now lives in `core/copy.ts`, keyed by language, with `headline()` handling the casing so no caller chooses between `titleCase` and sentence case. `tests/references.test.ts` greps the three generating modules for page-copy phrases and fails if one reappears, and separately asserts every English key has a Spanish counterpart that actually differs — a missing key would silently fall back to English. The agent-facing `note` and `rationale` fields stay English on purpose: those are instructions, not copy.
- **And one regression the Spanish work caused.** `findNearDuplicates` gated eligibility on *content* tokens, so adding Spanish function words took a 61-word Spanish page from 58 countable tokens to 38 and pushed it under the floor of 50 — silently excluding Spanish doorway pages from duplicate detection, which is the whole point of the check for pSEO. The floor is now counted in raw words, which is what its own comment always claimed and is language-neutral. Worth generalising: **a threshold expressed in post-filter units moves whenever you improve the filter.**

**Argentinian (rioplatense) too.** Voseo (`vos`, `tenés`, `podés`), `acá`/`allá`, and the vocabulary that carries intent locally: `cuánto sale` is the ordinary way to ask a price, instalment pricing (`en cuotas`, `sin interés`) is a purchase signal, and `AFIP`/`monotributo`/`Mercado Pago` drive real search for business software. Adding voseo alone introduced an asymmetry — `vos tenés` dropped both words while `tú tienes` kept `tienes` — so the peninsular twins are listed alongside. `sos` is excluded because SOS is an English term.

**Everything else is out of scope, and fails silently rather than loudly.** A non-Latin script yields zero tokens: `word_count` is 0, so `content.empty` fires at *error* severity claiming the page renders no text, and every page hashes to simhash 0, so two unrelated Japanese articles score a token similarity of 1.0 and are reported as duplicates. Measured on Japanese, Chinese, Korean, Russian, Arabic, Greek and Hindi. Supporting one would take Unicode classes plus per-character segmentation for the unsegmented scripts. There is a note on `tokenize` saying so, because the silence is the dangerous part.

## Doc claims are checkable, so check them

Every number in this file and the README was measured, and three of them had already drifted before anyone noticed — the test count, the credential-gated tool count (13, "corrected" to 10 on a census taken through a bug, then back to 13), and the audit rule count (53, documented as 40). Re-measure after a change that could move them.

Verified at the time of writing: 427 tests, 53 rules in 8 categories, 36 tools, 13 credential-gated, and the reference health scores — stripe.com 18.2, vercel.com 42, iana.org 19.3, example.com 71 at `max_pages: 8`. Those four were re-measured after the duplicate-eligibility floor changed, since that could have shifted them; they held exactly.

**Derive anything dated.** `'2026'` sat in the commercial keyword modifiers as a literal. It would have gone stale on 1 January — still spending a request on last year's query while missing the one people are typing — and nothing would have failed. The title generators already computed the year from the clock; the modifier list did not. It now does, and a test rejects year literals in the modifier lists. The only hardcoded dates left in `src/` are the Anthropic API version identifiers, which are version strings and must not be derived.

## Gotchas

- **`node:sqlite` is loaded via `createRequire`**, not a static import. Node emits its ExperimentalWarning during ESM *linking*, before any module body runs, so a static import fires it before `core/quiet.ts` can install the filter. Don't "tidy" this back into an import.
- **stdout is the MCP protocol channel.** Never write to it outside the transport. Logging goes to stderr; one stray `console.log` in the dependency tree corrupts the stream and the client just disconnects.
- **`normalizeUrl` preserves trailing slashes.** Dedupe with `slashInsensitiveKey` instead.
- **node:sqlite returns null-prototype objects.** Rehydrate with `rows()` at the boundary or spread and `in` silently misbehave.
- **Clustering needs both of its gates.** Removing either the distinctive-token check or the topical-overlap floor in `shouldJoin` reintroduces a failure the other one fixes — over-merging in one direction, blurring unrelated topics in the other. Deleting either one now fails `tests/keywords.test.ts` (verified by mutation, not assumed).
- **A cap of 0 must mean zero, never "unset".** `configureBudget` distinguishes `undefined` (no cap) from `0` (spend nothing) explicitly, and treats negatives and NaN as 0. The `x && x > 0 ? x : default` idiom silently turns an intentional 0 into "no limit"; for anything safety-related, branch on `undefined` instead.
- **Reserve before you spend, after you resolve the provider.** `reserve()` only checks and `record()` only increments, so the order is: confirm a provider/key exists, `reserve()` the worst-case cost, make the call, `record()` what was actually spent. Reserving before the provider check reports a budget error for spend that could never have happened; reserving after the call means the cap cannot stop anything.
- **Duplicate thresholds differ by context on purpose.** The site audit uses 0.85 (a false positive on editorial content is costly); the pSEO gate uses 0.75 (templated pages have small shared vocabularies, so one swapped noun moves similarity less). Both are documented at the call site.

## Style

Match the surrounding code. Comments explain *why* — especially where a threshold was chosen against measured data, or where the obvious implementation is wrong. Don't comment what the next line does.

## Dependency overrides

`package.json` pins `@hono/node-server` to `^2.0.12` via `overrides`. It arrives transitively through `@modelcontextprotocol/sdk`, which resolves it to a 1.x release carrying a path-traversal advisory in `serve-static`.

That code path is unreachable here — this server uses `StdioServerTransport` only and never starts an HTTP listener — but the override costs nothing, keeps `npm audit` clean for anyone installing the package, and protects the case where someone later adds the HTTP transport. npm's own suggested fix was to *downgrade* the MCP SDK, which would have been worse. Re-check the override when bumping the SDK.
