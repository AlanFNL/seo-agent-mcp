import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { loadConfig, type Config } from '../config.js';
import { openDb } from '../core/db.js';
import { configureBudget } from '../core/budget.js';
import { setHostDelay } from '../core/http.js';
import { cachePurgeExpired } from '../core/cache.js';
import { normalizeError } from '../core/errors.js';
import { ok, fail, toToolResult } from '../core/envelope.js';
import type { Envelope, Action, EnvelopeMeta } from '../core/types.js';

/**
 * Tool registration plumbing.
 *
 * Every tool gets the same treatment: validated input, a consistent envelope,
 * timing, and errors converted into structured, *actionable* failures rather
 * than stack traces. Doing this once here means a tool implementation is just
 * its actual logic.
 */

export interface Runtime {
  cfg: Config;
}

let runtime: Runtime | null = null;

export function initRuntime(overrides: Partial<Config> = {}): Runtime {
  const cfg = loadConfig(overrides);
  openDb(cfg.dbPath);
  configureBudget(cfg.budget);
  setHostDelay(cfg.crawl.hostDelayMs);
  try {
    cachePurgeExpired();
  } catch {
    // A cache-cleanup failure must never stop the server booting.
  }
  runtime = { cfg };
  return runtime;
}

export function getRuntime(): Runtime {
  if (!runtime) return initRuntime();
  return runtime;
}

export interface ToolResult<T> {
  data: T;
  summary: string;
  actions?: Action[];
  warnings?: string[];
  meta?: Partial<EnvelopeMeta>;
}

export interface ToolDef<S extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /** Hints for MCP clients; `readOnlyHint` lets a client auto-approve safe calls. */
  readOnly?: boolean;
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>, ctx: Runtime) => Promise<ToolResult<unknown>>;
}

export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/**
 * Tools have heterogeneous input schemas, so a registry of them can't keep the
 * per-tool generic. `defineTool` preserves full type-safety at the definition
 * site, which is where it matters; this erased type is only for the list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

export function registerTools(server: McpServer, tools: AnyToolDef[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly ?? true,
          // Nothing here mutates the user's site — the worst case is spending
          // provider credits, which the budget guard already bounds.
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        const started = Date.now();
        try {
          const result = await tool.handler(args, getRuntime());
          const envelope: Envelope<unknown> = ok(tool.name, result.data, {
            summary: result.summary,
            ...(result.actions ? { actions: result.actions } : {}),
            ...(result.warnings ? { warnings: result.warnings } : {}),
            ...(result.meta ? { meta: result.meta } : {}),
            startedAt: started,
          });
          return { content: [{ type: 'text' as const, text: toToolResult(envelope) }] };
        } catch (err) {
          const e = normalizeError(err);
          // Returned as a normal result rather than thrown: an agent reading
          // `remedy` can fix its own call, whereas a protocol-level error just
          // reads as "the tool is broken".
          return {
            content: [{ type: 'text' as const, text: toToolResult(fail(tool.name, e.toJSON(), started)) }],
            isError: true,
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
  }
}

// --- shared schema fragments ------------------------------------------------

export const locationSchema = z
  .string()
  .optional()
  .describe('Search location, e.g. "United States" or "London,England,United Kingdom". Defaults to the configured location.');

export const languageSchema = z
  .string()
  .optional()
  .describe('Two-letter language code, e.g. "en". Defaults to the configured language.');

export const deviceSchema = z
  .enum(['desktop', 'mobile'])
  .optional()
  .describe('Device to emulate for SERP results.');

export const limitSchema = (max: number, def: number) =>
  z.number().int().min(1).max(max).optional().default(def).describe(`Maximum rows to return inline (max ${max}).`);

export const projectSchema = z
  .string()
  .optional()
  .describe('Project name to scope stored data. Use seo_project_set first, or pass a site URL.');

/** Resolve a site argument to a bare hostname-ish string for storage keys. */
export function siteKey(input: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    return u.hostname;
  } catch {
    return input.toLowerCase();
  }
}
