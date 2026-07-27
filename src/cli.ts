#!/usr/bin/env node
// Must be first: installs the warning filter before node:sqlite is loaded.
import './core/quiet.js';
import { initRuntime } from './mcp/runtime.js';
import { ALL_TOOLS } from './mcp/tools/index.js';
import { describeCapabilities } from './config.js';
import { normalizeError } from './core/errors.js';
import { ok, fail, toToolResult } from './core/envelope.js';
import { closeDb } from './core/db.js';
import type { Envelope } from './core/types.js';

/**
 * CLI.
 *
 * The MCP server is the product; this is a thin shell over the same tool
 * registry so you can sanity-check a tool without wiring up an MCP client, run
 * one in CI, or pipe results into jq. Every tool is reachable, arguments map
 * one-to-one onto the MCP schema, and the output is the identical envelope —
 * so anything you verify here behaves the same way when an agent calls it.
 */

const USAGE = `seo-agent — agent-native SEO toolkit

USAGE
  seo-agent <tool> [--arg value ...]
  seo-agent list                     List all tools
  seo-agent describe <tool>          Show a tool's arguments
  seo-agent capabilities             Show configured data sources
  seo-agent mcp                      Run the MCP server on stdio

ARGUMENTS
  --key value        String argument
  --key=value        Also accepted
  --flag             Boolean true
  --no-flag          Boolean false
  --key a --key b    Repeat for array arguments
  --key '["a","b"]'  JSON is parsed when it looks like JSON

OUTPUT
  Prints the same JSON envelope an MCP client receives:
  { ok, summary, data, actions, meta }

  --quiet            Print only the summary line
  --data             Print only the data object
  --actions          Print only the actions array

EXAMPLES
  seo-agent seo_capabilities
  seo-agent seo_crawl_site --url https://example.com --max_pages 50
  seo-agent seo_keyword_ideas --seed "project management software" --limit 30
  seo-agent seo_content_score --primary_keyword "best crm" --url https://example.com
  seo-agent seo_next_actions --site example.com
  seo-agent seo_crawl_site --url https://example.com --quiet
`;

interface ParsedArgs {
  tool: string;
  args: Record<string, unknown>;
  quiet: boolean;
  dataOnly: boolean;
  actionsOnly: boolean;
}

function parseArgv(argv: string[]): ParsedArgs {
  const tool = argv[0] ?? '';
  const args: Record<string, unknown> = {};
  let quiet = false;
  let dataOnly = false;
  let actionsOnly = false;

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) continue;

    if (token === '--quiet') {
      quiet = true;
      continue;
    }
    if (token === '--data') {
      dataOnly = true;
      continue;
    }
    if (token === '--actions') {
      actionsOnly = true;
      continue;
    }

    let key: string;
    let raw: string | undefined;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      key = token.slice(2, eq);
      raw = token.slice(eq + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        raw = next;
        i++;
      }
    }

    // A bare `--flag` is true; `--no-flag` is false.
    if (raw === undefined) {
      if (key.startsWith('no-')) args[key.slice(3)] = false;
      else args[key] = true;
      continue;
    }

    const value = coerce(raw);
    // Repeating a key builds an array, so `--keywords a --keywords b` works.
    const existing = args[key];
    if (existing !== undefined) {
      args[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      args[key] = value;
    }
  }

  return { tool, args, quiet, dataOnly, actionsOnly };
}

function coerce(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  // Only parse as a number when the round-trip is exact, so "007" and phone-like
  // strings survive intact.
  if (/^-?\d+(\.\d+)?$/.test(trimmed) && String(Number(trimmed)) === trimmed) {
    return Number(trimmed);
  }
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

function listTools(): void {
  const byCategory = new Map<string, typeof ALL_TOOLS>();
  for (const t of ALL_TOOLS) {
    const cat = t.name.startsWith('pseo_') ? 'programmatic-seo' : t.name.split('_')[1] ?? 'other';
    const list = byCategory.get(cat) ?? [];
    list.push(t);
    byCategory.set(cat, list);
  }
  process.stdout.write(`${ALL_TOOLS.length} tools:\n\n`);
  for (const t of ALL_TOOLS) {
    process.stdout.write(`  ${t.name.padEnd(28)} ${t.title}\n`);
  }
  process.stdout.write('\nRun `seo-agent describe <tool>` for arguments.\n');
}

function describeTool(name: string): number {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) {
    process.stderr.write(`Unknown tool: ${name}\nRun \`seo-agent list\` to see all tools.\n`);
    return 1;
  }
  process.stdout.write(`${tool.name} — ${tool.title}\n\n${tool.description}\n\nARGUMENTS\n`);
  const shape = tool.inputSchema as Record<string, { description?: string; isOptional?: () => boolean; _def?: unknown }>;
  const entries = Object.entries(shape);
  if (entries.length === 0) {
    process.stdout.write('  (none)\n');
    return 0;
  }
  for (const [key, schema] of entries) {
    let optional = false;
    try {
      optional = typeof schema.isOptional === 'function' ? schema.isOptional() : false;
    } catch {
      optional = false;
    }
    const desc =
      (schema as { description?: string }).description ??
      ((schema as { _def?: { description?: string } })._def?.description ?? '');
    process.stdout.write(`  --${key}${optional ? '' : ' (required)'}\n`);
    if (desc) process.stdout.write(`      ${desc}\n`);
  }
  return 0;
}

/** True when a zod schema accepts an array, looking through optional/default wrappers. */
function expectsArray(schema: unknown): boolean {
  let current = schema as { _def?: { typeName?: string; innerType?: unknown; schema?: unknown } } | undefined;
  for (let depth = 0; current?._def && depth < 10; depth++) {
    const typeName = current._def.typeName;
    if (typeName === 'ZodArray') return true;
    // Unwrap ZodOptional / ZodDefault / ZodNullable / ZodEffects.
    const inner = current._def.innerType ?? current._def.schema;
    if (!inner) return false;
    current = inner as typeof current;
  }
  return false;
}

/** Promote scalars to single-element arrays for fields whose schema wants an array. */
function coerceArrayArgs(
  args: Record<string, unknown>,
  shape: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined || Array.isArray(value)) continue;
    if (expectsArray(shape[key])) out[key] = [value];
  }
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = argv[0] as string;

  if (command === 'list') {
    listTools();
    return 0;
  }
  if (command === 'describe') {
    const target = argv[1];
    if (!target) {
      process.stderr.write('Usage: seo-agent describe <tool>\n');
      return 1;
    }
    return describeTool(target);
  }
  if (command === 'mcp') {
    // Hand off to the server entry point; it owns stdio from here.
    await import('./mcp-server.js');
    return 0;
  }
  if (command === 'capabilities') {
    const rt = initRuntime();
    const caps = describeCapabilities(rt.cfg);
    for (const c of caps) {
      // A capability can be available but partial (Open PageRank covers
      // authority scores only), so render the unlock line whenever it is
      // present rather than only when the capability is entirely off.
      const mark = c.available ? (c.unlock_with ? '~' : '✓') : '✗';
      process.stdout.write(`${mark} ${c.name.padEnd(26)} ${c.provider}\n`);
      if (c.unlock_with) {
        process.stdout.write(`    unlock: ${c.unlock_with.join(' | ')}\n`);
      }
    }
    return 0;
  }

  const parsed = parseArgv(argv);
  const tool = ALL_TOOLS.find((t) => t.name === parsed.tool);
  if (!tool) {
    process.stderr.write(
      `Unknown tool: ${parsed.tool}\nRun \`seo-agent list\` to see all tools, or \`seo-agent --help\`.\n`,
    );
    return 1;
  }

  // Reject unknown flags before running anything.
  //
  // zod objects strip unknown keys, so `--dimension date` (the field is
  // `dimensions`) was silently dropped and the tool ran with its default of
  // ["query"] — returning a confident, plausible answer to a different question
  // than the one asked. A near-miss flag name is the easiest mistake to make and
  // was the only one that failed invisibly.
  const known = Object.keys(tool.inputSchema);
  const unknown = Object.keys(parsed.args).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    const lines = unknown.map((u) => {
      const near = known.filter((k) => k.startsWith(u) || u.startsWith(k) || k.replace(/s$/, '') === u.replace(/s$/, ''));
      return `  --${u}${near.length > 0 ? `  (did you mean --${near.join(' or --')}?)` : ''}`;
    });
    process.stderr.write(
      `Unknown argument${unknown.length > 1 ? 's' : ''} for ${tool.name}:\n${lines.join('\n')}\n\n` +
        `Valid arguments: ${known.map((k) => `--${k}`).join(', ')}\n` +
        `Run \`seo-agent describe ${tool.name}\`.\n`,
    );
    return 1;
  }

  const runtime = initRuntime();
  const started = Date.now();

  // Apply zod defaults and surface validation errors the same way the MCP layer
  // does, so behaviour matches exactly between the two entry points.
  let validated: Record<string, unknown>;
  try {
    const { z } = await import('zod');
    // Wrap single values destined for array fields.
    //
    // On the command line `--competitors a.com` is the natural way to pass one
    // item, but the repeat-key parser only builds an array when a flag appears
    // twice — so a single occurrence reached zod as a string and every array
    // argument failed unless you passed it twice or hand-wrote JSON. The MCP
    // path never hits this (arguments arrive as typed JSON), which is exactly
    // why it went unnoticed.
    const coerced = coerceArrayArgs(parsed.args, tool.inputSchema);
    validated = z.object(tool.inputSchema).parse(coerced) as Record<string, unknown>;
  } catch (err) {
    const issues =
      err && typeof err === 'object' && 'issues' in err
        ? (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues
            .map((i) => `  --${i.path.join('.')}: ${i.message}`)
            .join('\n')
        : String(err);
    process.stderr.write(`Invalid arguments for ${tool.name}:\n${issues}\n\nRun \`seo-agent describe ${tool.name}\`.\n`);
    return 1;
  }

  try {
    const result = await tool.handler(validated, runtime);
    const envelope: Envelope<unknown> = ok(tool.name, result.data, {
      summary: result.summary,
      ...(result.actions ? { actions: result.actions } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.meta ? { meta: result.meta } : {}),
      startedAt: started,
    });

    if (parsed.quiet) {
      process.stdout.write(`${envelope.summary}\n`);
      for (const w of envelope.warnings ?? []) process.stderr.write(`warning: ${w}\n`);
    } else if (parsed.dataOnly) {
      process.stdout.write(`${JSON.stringify(envelope.data, null, 2)}\n`);
    } else if (parsed.actionsOnly) {
      process.stdout.write(`${JSON.stringify(envelope.actions ?? [], null, 2)}\n`);
    } else {
      process.stdout.write(`${toToolResult(envelope)}\n`);
    }
    return 0;
  } catch (err) {
    const e = normalizeError(err);
    process.stderr.write(`${toToolResult(fail(tool.name, e.toJSON(), started))}\n`);
    return 1;
  } finally {
    try {
      closeDb();
    } catch {
      // Nothing useful to do if the handle is already gone.
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
