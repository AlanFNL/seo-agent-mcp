import { SeoAgentError, normalizeError } from './errors.js';

/**
 * HTTP layer: polite by default, honest about failure.
 *
 * A crawler that hammers a site gets the user's IP banned, and an agent has no
 * intuition about when to slow down — so politeness is enforced here rather
 * than left to callers. Per-host rate limiting, bounded concurrency, retry with
 * backoff on transient failures only, and hard caps on response size.
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (compatible; seo-agent/0.1; +https://github.com/seo-agent/seo-agent) AgentSEOBot';

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Retries on 429/5xx/network errors. Never retries 4xx (except 429). */
  retries?: number;
  /** Abort the body read past this many bytes. Protects against 500MB "HTML" pages. */
  maxBytes?: number;
  userAgent?: string;
  /** Set false to capture redirect targets instead of following them. */
  follow?: boolean;
  signal?: AbortSignal;
}

export interface FetchResult {
  url: string;
  final_url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  ms: number;
  redirect_chain: string[];
  truncated: boolean;
}

/** Minimum gap between requests to the same host, in ms. */
let hostDelayMs = 250;
const lastHit = new Map<string, number>();
const hostQueue = new Map<string, Promise<void>>();

export function setHostDelay(ms: number): void {
  hostDelayMs = Math.max(0, ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Serialise per-host so the delay actually holds under concurrency. Without the
 * queue, 20 parallel requests all read the same `lastHit` and fire at once.
 */
async function throttle(host: string): Promise<void> {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  hostQueue.set(
    host,
    prev.then(() => next),
  );
  await prev;
  const last = lastHit.get(host) ?? 0;
  const wait = hostDelayMs - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  // Release the next waiter immediately; the delay above already spaced us out.
  release();
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export async function httpFetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20_000,
    retries = 2,
    maxBytes = 5 * 1024 * 1024,
    userAgent = DEFAULT_UA,
    follow = true,
    signal,
  } = opts;

  const host = new URL(url).host;
  let lastError: SeoAgentError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with a jitter band, capped so an agent isn't stuck for minutes.
      const backoff = Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await sleep(backoff);
    }
    await throttle(host);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
          'accept-language': 'en-US,en;q=0.9',
          ...headers,
        },
        body,
        redirect: follow ? 'follow' : 'manual',
        signal: controller.signal,
      });

      const { text, bytes, truncated } = await readBounded(res, maxBytes);
      const ms = Date.now() - started;

      const hdrs: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        hdrs[k.toLowerCase()] = v;
      });

      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        // Honour Retry-After when the server tells us how long to wait.
        const retryAfter = Number(hdrs['retry-after']);
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await sleep(Math.min(30_000, retryAfter * 1000));
        }
        lastError = new SeoAgentError(
          res.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          `HTTP ${res.status} from ${url}`,
          res.status === 429
            ? 'Reduce concurrency or increase SEO_AGENT_HOST_DELAY_MS.'
            : 'Transient server error; retry later.',
          { status: res.status },
        );
        continue;
      }

      return {
        url,
        final_url: res.url || url,
        status: res.status,
        headers: hdrs,
        body: text,
        bytes,
        ms,
        redirect_chain: res.redirected && res.url !== url ? [url, res.url] : [],
        truncated,
      };
    } catch (err) {
      lastError = normalizeError(err);
      if (lastError.code === 'INTERNAL') throw lastError;
      if (attempt >= retries) break;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  throw (
    lastError ??
    new SeoAgentError('NETWORK', `Failed to fetch ${url}`, 'Check connectivity and the URL.')
  );
}

/** Read a response body but stop at `maxBytes` instead of buffering unbounded. */
async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    return { text, bytes: Buffer.byteLength(text), truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  // Respect a declared charset where we can; default to UTF-8.
  const ct = res.headers.get('content-type') ?? '';
  const m = /charset=([\w-]+)/i.exec(ct);
  const charset = (m?.[1] ?? 'utf-8').toLowerCase();
  let text: string;
  try {
    text = new TextDecoder(charset === 'utf8' ? 'utf-8' : charset).decode(buf);
  } catch {
    text = buf.toString('utf8');
  }
  return { text, bytes: Math.min(total, maxBytes), truncated };
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await httpFetch(url, {
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers ?? {}) },
  });
  if (res.status >= 400) {
    throw new SeoAgentError(
      res.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
      `HTTP ${res.status} from ${url}: ${res.body.slice(0, 300)}`,
      res.status === 401 || res.status === 403
        ? 'Check the API key for this provider is valid and has quota.'
        : 'Inspect the provider response; the request may be malformed.',
      { status: res.status },
    );
  }
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new SeoAgentError(
      'PROVIDER_ERROR',
      `Non-JSON response from ${url}: ${res.body.slice(0, 200)}`,
      'The provider returned HTML or an error page. Verify the endpoint URL.',
    );
  }
}

/**
 * Bounded-concurrency map. Used everywhere we fan out over URLs or keywords.
 * Results keep input order; a rejected task yields its error in place rather
 * than failing the whole batch — partial data beats no data for an agent.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: SeoAgentError }>> {
  const results = new Array<{ ok: true; value: R } | { ok: false; error: SeoAgentError }>(
    items.length,
  );
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i] as T, i) };
      } catch (err) {
        results[i] = { ok: false, error: normalizeError(err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Partition `mapLimit` results, refusing to call a total failure a success.
 *
 * "Partial data beats no data" only holds while there is *some* data. Filtering
 * failures out with `.filter(r => r.ok)` and reporting on what survives turns
 * "every lookup failed" into a confident negative answer: seo_rank_check said
 * "ranks for 0 of 0 keywords" and seo_competitors_discover said "found 0
 * competing domains", both with `ok: true` and no warnings, when the real cause
 * was that no SERP provider was configured. An agent cannot tell that apart from
 * genuinely ranking for nothing, and the second reading is catastrophic.
 *
 * So: nothing succeeded → rethrow the first real error, which carries its own
 * code and remedy. Some succeeded → return a warning naming the shortfall.
 */
export function partitionResults<R>(
  results: Array<{ ok: true; value: R } | { ok: false; error: SeoAgentError }>,
  what = 'lookup',
): { values: R[]; failed: number; warning: string | null } {
  const values: R[] = [];
  const errors: SeoAgentError[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }

  if (values.length === 0 && errors.length > 0) throw errors[0] as SeoAgentError;

  return {
    values,
    failed: errors.length,
    warning:
      errors.length === 0
        ? null
        : `${errors.length} of ${results.length} ${what}(s) failed and are missing from these results ` +
          `(first failure: ${(errors[0] as SeoAgentError).message}). Treat the totals as a floor, not a complete picture.`,
  };
}
