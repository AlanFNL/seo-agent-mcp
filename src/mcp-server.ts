#!/usr/bin/env node
// Must be first: installs the warning filter before node:sqlite is loaded.
import './core/quiet.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initRuntime, registerTools } from './mcp/runtime.js';
import { ALL_TOOLS } from './mcp/tools/index.js';
import { describeCapabilities } from './config.js';
import { closeDb } from './core/db.js';

/**
 * MCP server entry point (stdio transport).
 *
 * One rule that matters here: stdout carries the JSON-RPC protocol, so nothing
 * else may ever be written to it. All logging goes to stderr. A stray
 * console.log anywhere in the dependency tree corrupts the stream and the
 * client sees an unexplained disconnect.
 */

async function main(): Promise<void> {
  const runtime = initRuntime();

  const server = new McpServer(
    { name: 'seo-agent', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'Agent-native SEO platform: technical audits, keyword research, rank tracking, content briefs and ' +
        'programmatic SEO planning.\n\n' +
        'Start with seo_capabilities to see which data sources are configured — several tools need API keys and ' +
        'the rest work with none. When a tool returns PROVIDER_NOT_CONFIGURED, read the `remedy` field: it names ' +
        'both the environment variable to set and the free tool to use instead.\n\n' +
        'Typical workflows:\n' +
        '- "Improve our SEO": seo_crawl_site, then seo_next_actions.\n' +
        '- "How do we rank": seo_gsc_performance, then seo_gsc_opportunities.\n' +
        '- "Write a blog post that ranks": seo_keyword_ideas, seo_cluster_keywords, seo_content_brief, write, ' +
        'then seo_content_score with the brief\'s required_terms.\n' +
        '- "Scale content programmatically": seo_keyword_ideas, pseo_discover_patterns, pseo_build_plan, generate ' +
        'the drafts, then pseo_check_index_risk before publishing anything.\n\n' +
        'Every response uses the same envelope: `summary` (one line), `data` (the facts), `actions` (ranked, ' +
        'machine-applicable fixes with impact scores) and `meta` (cost, caching, suggested next calls). ' +
        'When a response has `actions`, work them in order — they are already sorted by impact per unit of effort.',
    },
  );

  registerTools(server, ALL_TOOLS);

  // A resource is the natural place for status an agent may want to re-read
  // without spending a tool call.
  server.registerResource(
    'capabilities',
    'seo-agent://capabilities',
    {
      title: 'Configured capabilities',
      description: 'Which data sources are active and what unlocks the rest.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: 'seo-agent://capabilities',
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              capabilities: describeCapabilities(runtime.cfg),
              tools: ALL_TOOLS.map((t) => ({ name: t.name, title: t.title })),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  const capabilities = describeCapabilities(runtime.cfg);
  const active = capabilities.filter((c) => c.available).length;
  process.stderr.write(
    `[seo-agent] ready — ${ALL_TOOLS.length} tools, ${active}/${capabilities.length} capabilities active, ` +
      `data dir ${runtime.cfg.dataDir}\n`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    try {
      closeDb();
    } catch {
      // Best effort on the way out.
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`[seo-agent] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
