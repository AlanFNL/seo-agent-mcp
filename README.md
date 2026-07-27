# seo-agent

[![CI](https://github.com/AlanFNL/seo-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AlanFNL/seo-agent-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](https://nodejs.org)

An Ahrefs/Semrush-class SEO platform built for **agents**, not people. No dashboard, no charts, no login — 36 MCP tools that return decisions instead of tables.

**28 of the 36 tools are free**, and free is the intended way to run this. Set `SEO_AGENT_BUDGET=0` and no metered call can be made at all.

Most SEO tools are a UI with an API bolted on. This is the inverse: every response is designed for something that will act on it immediately, and the interesting design work is in what that changes.

```
"How do we improve our SEO?"
  → seo_crawl_site → seo_next_actions
    → one ranked backlog, each item with an impact score and a machine-applicable fix

"Write a blog post that ranks"
  → seo_keyword_ideas → seo_cluster_keywords → seo_content_brief
    → write → seo_content_score → apply the returned edits

"Scale content programmatically"
  → pseo_discover_patterns → pseo_build_plan → generate drafts
    → pseo_check_index_risk  ← blocks the publish if you built doorway pages
```

---

## Install

```bash
npm install && npm run build
```

Requires Node 22.5+. **Zero native dependencies** — persistence uses Node's built-in `node:sqlite`, so nothing compiles at install time.

### Register with an MCP client

```jsonc
// Claude Desktop / Claude Code — mcpServers config
{
  "mcpServers": {
    "seo-agent": {
      "command": "node",
      "args": ["/absolute/path/to/seo-agent-cli/dist/mcp-server.js"],
      "env": {
        // Nothing here is required — 23 tools work with an empty env block.
        // This is the recommended free setup.
        "SEO_AGENT_BUDGET": "0",           // hard stop: no metered call, ever
        "GSC_SERVICE_ACCOUNT_JSON": "/path/to/service-account.json",
        "GSC_SITE_URL": "sc-domain:example.com",
        "PAGESPEED_API_KEY": "...",        // free key
        "OPENPAGERANK_API_KEY": "..."      // free tier
      }
    }
  }
}
```

Put credentials in this `env` block rather than a `.env` file. There *is* a built-in `.env` loader, but it resolves against the process working directory — and an MCP client spawns the server with a working directory of its own choosing, so a `.env` in the project folder usually won't be found. For CLI use from the project directory, `.env` works fine.

There is no daemon. The client spawns `node dist/mcp-server.js` as a child process over stdio and kills it on exit; nothing listens on a port. State survives between runs because it lives on disk in `~/.seo-agent/`, which is what makes `seo_crawl_diff` and `seo_rank_changes` work across days.

### Or use the CLI

The MCP server is the product; the CLI is the same tool registry behind a shell, for sanity checks, CI, and piping into `jq`.

```bash
node dist/cli.js list                       # all 36 tools
node dist/cli.js capabilities               # what's configured
node dist/cli.js describe seo_crawl_site    # arguments for one tool

node dist/cli.js seo_crawl_site --url https://example.com --max_pages 50 --quiet
node dist/cli.js seo_next_actions --site example.com --actions | jq '.[0]'
```

---

## What makes it agent-native

These are the decisions that actually differ from wrapping a human tool in an API.

### 1. Tools return actions, not tables

Every analysis tool emits a ranked `actions[]` alongside the raw data. Each action carries a priority, an effort estimate, an impact score, the evidence behind it, and — where one exists — a structured `fix` the agent can apply directly.

```jsonc
{
  "id": "audit.title.missing",
  "priority": "critical",
  "effort": "trivial",
  "title": "Add a title tag to 3 pages",
  "detail": "Write a 50-60 character title with the target keyword near the front...",
  "impact_score": 90,
  "evidence": { "affected_pages": 3, "examples": ["https://..."] },
  "fix": { "type": "set_title", "from": "", "to": "Best CRM Software" }
}
```

Actions are sorted by impact-per-unit-effort, so an agent working the list top-down does the valuable cheap things first. Ids are stable across runs, so fixes can be tracked.

### 2. Everything is diffable

Crawls, rankings and keyword sets are persisted locally. That makes the most useful question answerable:

```bash
seo_crawl_diff   # new issues, resolved issues, pages that became non-indexable,
                 # titles that changed, health-score delta
seo_rank_changes # position movement between any two snapshots
```

An agent that can only see today produces reports. One that can compare today against last Tuesday produces decisions. Human tools bury this behind a date-range picker; here it's a first-class call.

### 3. Honest about what it doesn't know

Search volume is never guessed. With no metrics provider, `volume` is `null` and the response says why, in the `warnings` array. Difficulty falls back to a lexical estimate explicitly labelled `method: "lexical", confidence: 0.35`.

A fabricated search volume is the single most damaging thing this tool could return — an agent will build a whole content calendar on it.

### 4. Errors teach the agent what to do

```jsonc
{
  "code": "PROVIDER_NOT_CONFIGURED",
  "message": "No provider configured for live SERP data.",
  "remedy": "Set one of SERPER_API_KEY or SERPAPI_KEY or DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD.
             Without it you can still use: seo_gsc_performance for your own rankings,
             seo_keyword_ideas for discovery, and seo_page_inspect to analyse any competitor URL."
}
```

Every error names both the fix and the free fallback, so an unconfigured agent gets redirected rather than blocked.

### 5. Context and cost are bounded

- Large result sets are capped inline and spilled to an artifact file, with a path in `meta.artifact`. A 5,000-page crawl never floods the context window.
- Every provider response is cached with a TTL tuned to how fast the data actually changes. Agents loop; without caching, one reasoning chain can fire the same paid SERP call eleven times.
- `SEO_AGENT_BUDGET` caps provider spend per session. Once hit, metered tools fail with a clear error instead of quietly running up a bill. It caps *money*, not quota — tools backed by a free key (PageSpeed, Open PageRank) cost zero units and keep working at `SEO_AGENT_BUDGET=0`, while genuinely paid ones are refused before the network call.

### 6. The programmatic-SEO gate

`pseo_check_index_risk` exists because the same mechanism that produces 500 useful pages produces 500 doorway pages if only a noun varies. It checks generated drafts for thin content, near-duplicate bodies, duplicate titles and low vocabulary uniqueness, then returns `safe` / `risky` / `do_not_publish`.

It is not an optional extra. Catching it before publishing costs nothing; catching it after Google classifies the directory costs months.

---

## Languages

English and Spanish, including Argentinian (rioplatense) Spanish. Pass `language: "es"` (or `"es-AR"`) to keyword tools so autocomplete expansion uses Spanish modifiers.

- **Text analysis** folds diacritics (`año` → `ano`) and filters Spanish function words, so `el mejor software de seguimiento del tiempo` reduces to `mejor · software · seguimiento · tiempo`.
- **Stemming** handles Spanish consonant plurals, so `gestores de proyectos` clusters with `gestor de proyectos`.
- **Intent** reads Spanish signals — `comprar`/`precio`/`en cuotas` as transactional, `mejor`/`opiniones`/`alternativas` as commercial, `iniciar sesión`/`AFIP` as navigational — and detects Spanish questions including `¿…?`, `qué`, `cómo`, `por qué`, plus rioplatense `cuánto sale`, `cómo hago`, `conviene`.
- **Expansion** uses Spanish modifiers for Spanish seeds. On a real seed this returned 184 keywords from 79 requests, against 146 from 88 with English modifiers.
- **Readability** uses Fernández Huerta for Spanish rather than Flesch, whose coefficients are fitted to English syllable counts. Scored with Flesch, ordinary Spanish prose rated 25.8 against an English equivalent's 88.7.
- **Generated page copy** is written in the target language. Pass `language: "es"` to `pseo_build_plan`, `seo_cluster_keywords` or `seo_content_brief` and titles, meta descriptions and section headings come back in Spanish, in sentence case rather than English Title Case.

Other languages are **not supported**, and the failure is silent rather than loud: a non-Latin script produces zero tokens, so pages read as empty and every page looks like a duplicate of every other. See the note on `tokenize` in `core/text.ts`.

## Data sources

### Free — 28 of 36 tools

**23 tools need nothing at all.** That's the floor, not a teaser: a full technical audit, keyword research, clustering into a content plan, a programmatic set with its safety gate, and scoring on every draft, with no account anywhere.

| Capability | Needs | Tools |
|---|---|---|
| **Crawl + 53-rule audit, internal PageRank, link opportunities, diffing** | — | 7 |
| **Keyword discovery, clustering, lexical difficulty** | — | 3 |
| **Content scoring, briefs, page optimisation** | — | 3 |
| **Programmatic SEO planning + safety gate** | — | 3 |
| **Orientation + housekeeping** (projects, usage, cache) | — | 6 |
| **Rank movement** between stored snapshots | prior runs, not credentials | 1 |

Five more unlock with credentials that cost nothing:

| Capability | Needs | Unlocks | Cost |
|---|---|---|---|
| Your real rankings | `GSC_SERVICE_ACCOUNT_JSON` + `GSC_SITE_URL` | `seo_gsc_sites`, `seo_gsc_performance`, `seo_gsc_opportunities` | free forever |
| Core Web Vitals | `PAGESPEED_API_KEY` | `seo_page_speed` | free key |
| Domain authority | `OPENPAGERANK_API_KEY` | `seo_domain_authority` | free tier |

Search Console is the one worth doing first. It is *ground truth* rather than an estimate — Ahrefs and Semrush infer your rankings from a sampled keyword universe, while this is what Google actually recorded, across every query you surface for. It's also what makes `seo_gsc_opportunities` work.

> Both free paths above have been exercised against the live APIs, not just fixture-tested: Search Console (service-account JWT → token exchange → `sites` and `searchAnalytics`) and PageSpeed Insights. The remaining paid providers' live HTTP paths are still unverified — their parsers are written to published docs and covered by fixtures.

> Open PageRank returns authority scores **only**. `seo_backlinks` and `seo_link_gap` need link-level data and stay off; `capabilities` reports this as `~ partial` rather than listing tools that would then fail.

### Paid — the remaining 8, all optional

| Capability | Needs | Free fallback |
|---|---|---|
| Live SERPs, competitors, content gap | `SERPER_API_KEY` / `SERPAPI_KEY` / DataForSEO | Search Console for your own rankings; `seo_page_inspect` on any competitor URL |
| Search volume + CPC | `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` | `volume: null` with a stated reason, plus lexical difficulty at `confidence: 0.35` |
| Backlinks + link gap | `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` | internal link equity analysis, which is usually the cheaper win anyway |
| AI assistant visibility + brand sentiment | `ANTHROPIC_API_KEY` | — |

Nothing degrades if you never configure any of it. Run `seo_capabilities` (or `node dist/cli.js capabilities`) to see exactly what's active — `✓` full, `~` partial, `✗` off.

> **Why SERPs need a paid provider.** I checked before designing around it: Bing's HTML endpoint serves a CAPTCHA to server traffic and DuckDuckGo's lite endpoint returns an empty document. There is no viable free scraping path, so rather than ship something that works on a laptop and breaks in CI, live SERP access is an explicit, pluggable, optional capability.

### Locking it free

```bash
SEO_AGENT_BUDGET=0
```

The refusal happens **before** the network call, so a stray API key elsewhere in your environment cannot spend anything:

```
BUDGET_EXCEEDED: Provider budget exhausted: 0/0 units used this session.
remedy: Raise SEO_AGENT_BUDGET or start a new session.
        Provider-free tools (crawl, audit, suggest, content scoring) still work.
```

If you later add a paid provider, set a real ceiling (`SEO_AGENT_BUDGET=500`) rather than removing the line. Agents loop, and a research chain with no cap will fire thousands of metered calls.

See `.env.example` for how to obtain each credential, including the Google Cloud org-policy trap that blocks service-account key downloads.

---

## The tools

<details>
<summary><b>Orientation</b> (2)</summary>

- `seo_capabilities` — what's configured, what unlocks the rest, what works without it
- `seo_next_actions` — **the aggregator.** Combines audit + link graph + Search Console into one ranked backlog. Ask this when the request is broad.
</details>

<details>
<summary><b>Crawl & audit</b> (7) — no keys needed</summary>

- `seo_crawl_site` — BFS crawl + 53 rules in 8 categories (indexability, canonicals, titles/meta, duplicates, links, images, schema, hreflang, performance) → health score + fixes
- `seo_audit_issues` — page through stored findings without re-crawling
- `seo_page_inspect` — full analysis of any URL, including competitors
- `seo_internal_links` — internal PageRank, orphans, starved pages, depth distribution
- `seo_link_opportunities` — pages that mention a topic but don't link to it, with the exact anchor and sentence
- `seo_crawl_diff` — what changed between two crawls
- `seo_crawl_history` — stored crawls and health trend
</details>

<details>
<summary><b>Keywords</b> (4) — 3 free</summary>

- `seo_keyword_ideas` — alphabet-soup, question, preposition and commercial-modifier expansion across Google/Bing/DuckDuckGo autocomplete
- `seo_keyword_metrics` — volume, CPC, competition, 12-month trend, difficulty
- `seo_keyword_difficulty` — SERP-derived difficulty, personalised to your domain authority
- `seo_cluster_keywords` — group into one-cluster-per-page, with suggested title/slug/H1 and page type
</details>

<details>
<summary><b>Your own performance</b> (3) — free via Search Console</summary>

- `seo_gsc_sites` — which properties the credential can read
- `seo_gsc_performance` — real impressions, clicks, CTR, position
- `seo_gsc_opportunities` — **striking distance, CTR underperformers, cannibalisation, content decay, rising queries**, all ranked
</details>

<details>
<summary><b>Competitive & SERP</b> (8) — mostly paid</summary>

- `seo_rank_changes` — **free.** Position movement between two stored snapshots; needs prior runs, not credentials
- `seo_domain_authority` — **free** with `OPENPAGERANK_API_KEY`
- `seo_serp` · `seo_rank_check` · `seo_competitors_discover` · `seo_content_gap` — need a SERP provider
- `seo_backlinks` · `seo_link_gap` — need DataForSEO; Open PageRank is not enough
</details>

<details>
<summary><b>Writing</b> (3) — free</summary>

- `seo_content_brief` — fetches and parses the actual ranking pages: word-count benchmark, shared subtopic terms, common sections, questions to answer, and a concrete H1/H2 outline
- `seo_content_score` — grade a draft or live page, return applyable edits
- `seo_page_optimize` — brief + score + fixes for one URL in a single call
</details>

<details>
<summary><b>AI visibility & speed</b> (2) — 1 free key, 1 paid</summary>

- `seo_ai_visibility` — asks an AI assistant the questions a buyer would ask, with live web search, and measures whether you get named, how prominently, whether your site is cited, and who takes share of voice. Also classifies **how** you're described: sentiment, recurring strengths and criticisms, and claims assistants state that are factually wrong. Being named in 80% of answers means something very different if the sentence is "cheap but unreliable"
- `seo_page_speed` — Core Web Vitals, distinguishing real-user field data (the ranking signal) from lab data
</details>

<details>
<summary><b>Programmatic SEO</b> (3) — no keys needed</summary>

- `pseo_discover_patterns` — find templatable query patterns like `{tool} alternatives`
- `pseo_build_plan` — one page spec per entity: URL, title, H1, meta, sections flagged for uniqueness, schema type, internal link mesh, required data fields
- `pseo_check_index_risk` — **the safety gate.** Run before publishing.
</details>

<details>
<summary><b>Housekeeping</b> (4) — free</summary>

`seo_project_set` · `seo_project_list` · `seo_usage` · `seo_cache_clear`
</details>

---

## Response shape

Every tool returns the same envelope:

```jsonc
{
  "ok": true,
  "tool": "seo_crawl_site",
  "summary": "Crawled 47 pages of example.com. Health score 62/100 (3 errors, 18 warnings, 41 notices). 9 prioritised fixes returned.",
  "data": { /* the facts */ },
  "actions": [ /* ranked, machine-applicable */ ],
  "warnings": [ "..." ],
  "meta": {
    "cached": false, "took_ms": 8420, "source": "crawler", "cost": 0,
    "truncated": false, "artifact": null,
    "next": ["seo_internal_links for link equity distribution", "..."]
  }
}
```

`summary` is a single line an agent can read without parsing `data`. `meta.next` suggests concrete follow-up calls, so agents don't guess at the workflow.

---

## Development

```bash
npm run build       # compile
npm test            # 446 tests
npm run typecheck   # strict, noUncheckedIndexedAccess
```

The test suite includes 15 end-to-end tests that spawn the real MCP server over stdio and hit live sites — those need network access and a prior `npm run build`.

### Layout

```
src/
  core/       envelope, types, errors, http, cache, budget, sqlite store, text analysis
  crawl/      crawler, robots, sitemap, HTML extraction, 53-rule audit engine
  keywords/   autocomplete mining, intent, difficulty, opportunity scoring, clustering
  analysis/   internal PageRank + link opportunities, Search Console insight extraction
  content/    competitive brief generation, content scoring
  pseo/       pattern discovery, plan building, index-risk gate
  providers/  SERP, keyword metrics, backlinks, Search Console, PageSpeed, AI visibility
  mcp/        tool definitions and registration
```

Providers sit behind interfaces, so no tool above that layer knows which one is configured — adding a new SERP vendor means one file and one registry entry.

---

## Notes on accuracy

A few numbers are estimates, and the tool says so rather than presenting them as fact:

- **Difficulty without a SERP provider** is lexical — usable to sort a keyword list, not to make a go/no-go call on one keyword. It reports `confidence: 0.35`.
- **Traffic estimates** use published organic CTR-by-position curves. The shape is stable; the absolute figures move year to year.
- **Health score** is normalised per page and smoothed, so a 5-page site isn't judged on a sample of one. Site-level issues (missing sitemap) are a flat deduction rather than being divided by page count.
- **Core Web Vitals** distinguishes field data (real users, the actual ranking signal) from lab data (one simulated load), and labels which you got.

## License

MIT
