import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fetchJson, httpFetch } from '../core/http.js';
import { cached, cacheKey, TTL } from '../core/cache.js';
import { providerNotConfigured, SeoAgentError } from '../core/errors.js';
import type { Config } from '../config.js';

/**
 * Google Search Console.
 *
 * This is the most valuable data source in the whole toolkit and it costs
 * nothing. Ahrefs and Semrush *estimate* your rankings from a sampled keyword
 * universe; Search Console reports the actual impressions, clicks, CTR and
 * average position Google recorded for your site. For the question the user
 * cares about — "how do we rank, and where's the upside" — this is ground truth
 * and everything else is inference.
 *
 * It only works for properties you own, which is exactly right: competitor
 * analysis goes through SERP providers, own-site performance goes through here.
 */

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

export type GscDimension = 'query' | 'page' | 'country' | 'device' | 'date' | 'searchAppearance';

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryOptions {
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  rowLimit?: number;
  startRow?: number;
  type?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
  /** 'all' includes the freshest (still-incomplete) data; 'final' is settled only. */
  dataState?: 'all' | 'final';
  filters?: Array<{ dimension: GscDimension; operator: 'equals' | 'contains' | 'notContains' | 'notEquals'; expression: string }>;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Mint a service-account access token via a signed JWT assertion.
 *
 * Implemented directly rather than pulling in googleapis, which is a ~50MB
 * dependency tree for what amounts to one RS256 signature and one POST. Keeping
 * the install small matters when an agent is installing this unattended.
 */
async function tokenFromServiceAccount(keyJson: ServiceAccountKey): Promise<{ token: string; expires_in: number }> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: keyJson.client_email,
      scope: SCOPE,
      aud: keyJson.token_uri ?? TOKEN_URL,
      exp: now + 3600,
      iat: now,
    }),
  );
  const signingInput = `${header}.${claims}`;
  let signature: string;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    // Escaped newlines are the norm when the key is passed through an env var.
    signature = base64url(signer.sign(keyJson.private_key.replace(/\\n/g, '\n')));
  } catch (err) {
    throw new SeoAgentError(
      'PROVIDER_ERROR',
      `Failed to sign the Search Console JWT: ${err instanceof Error ? err.message : String(err)}`,
      'Check that GSC_SERVICE_ACCOUNT_JSON contains a valid private_key (newlines may need to be \\n-escaped).',
    );
  }

  const res = await httpFetch(keyJson.token_uri ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }).toString(),
    retries: 1,
    timeoutMs: 20_000,
  });
  const json = JSON.parse(res.body) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!json.access_token) {
    throw new SeoAgentError(
      'PROVIDER_ERROR',
      `Search Console auth failed: ${json.error_description ?? json.error ?? 'no access token returned'}`,
      'Confirm the service account has been added as a user on the Search Console property.',
    );
  }
  return { token: json.access_token, expires_in: json.expires_in ?? 3600 };
}

async function tokenFromRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ token: string; expires_in: number }> {
  const res = await httpFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
    retries: 1,
    timeoutMs: 20_000,
  });
  const json = JSON.parse(res.body) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!json.access_token) {
    throw new SeoAgentError(
      'PROVIDER_ERROR',
      `Search Console token refresh failed: ${json.error_description ?? json.error ?? 'no access token returned'}`,
      'The refresh token may be revoked or expired. Re-run the OAuth consent flow to get a new one.',
    );
  }
  return { token: json.access_token, expires_in: json.expires_in ?? 3600 };
}

export class GscClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly cfg: NonNullable<Config['gsc']>) {}

  get siteUrl(): string {
    if (!this.cfg.siteUrl) {
      throw new SeoAgentError(
        'INVALID_INPUT',
        'No Search Console property configured.',
        'Set GSC_SITE_URL to the exact property string from Search Console, e.g. "https://example.com/" or "sc-domain:example.com". Call seo_gsc_sites to see what this credential can access.',
      );
    }
    return this.cfg.siteUrl;
  }

  private async accessToken(): Promise<string> {
    // Refresh 60s early so a long request can't expire mid-flight.
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;

    let result: { token: string; expires_in: number };
    if (this.cfg.serviceAccountJson) {
      result = await tokenFromServiceAccount(loadServiceAccount(this.cfg.serviceAccountJson));
    } else if (this.cfg.clientId && this.cfg.clientSecret && this.cfg.refreshToken) {
      result = await tokenFromRefreshToken(this.cfg.clientId, this.cfg.clientSecret, this.cfg.refreshToken);
    } else {
      throw providerNotConfigured('Google Search Console', [
        'GSC_SERVICE_ACCOUNT_JSON',
        'GSC_CLIENT_ID + GSC_CLIENT_SECRET + GSC_REFRESH_TOKEN',
      ]);
    }
    this.token = result.token;
    this.tokenExpiresAt = Date.now() + result.expires_in * 1000;
    return this.token;
  }

  /** Which properties this credential can read. The first call an agent should make. */
  async listSites(): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
    const token = await this.accessToken();
    const json = await fetchJson<{ siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> }>(
      `${API_BASE}/sites`,
      { headers: { authorization: `Bearer ${token}` }, retries: 1, timeoutMs: 20_000 },
    );
    return (json.siteEntry ?? [])
      .filter((s) => s.siteUrl)
      .map((s) => ({ siteUrl: s.siteUrl as string, permissionLevel: s.permissionLevel ?? 'unknown' }));
  }

  /**
   * Search Analytics query, paginated to completion.
   *
   * The API caps a page at 25,000 rows; an agent asking for "all our keywords"
   * on a real site needs more than that, and making it handle pagination itself
   * is exactly the kind of busywork this tool exists to absorb.
   */
  async searchAnalytics(opts: GscQueryOptions, siteUrl?: string): Promise<GscRow[]> {
    const token = await this.accessToken();
    const site = siteUrl ?? this.siteUrl;
    const target = `${API_BASE}/sites/${encodeURIComponent(site)}/searchAnalytics/query`;

    const wanted = opts.rowLimit ?? 1000;
    const pageSize = Math.min(wanted, 25_000);
    const rows: GscRow[] = [];
    let startRow = opts.startRow ?? 0;

    for (;;) {
      const body: Record<string, unknown> = {
        startDate: opts.startDate,
        endDate: opts.endDate,
        dimensions: opts.dimensions,
        rowLimit: Math.min(pageSize, wanted - rows.length),
        startRow,
        type: opts.type ?? 'web',
        dataState: opts.dataState ?? 'final',
      };
      if (opts.filters && opts.filters.length > 0) {
        body['dimensionFilterGroups'] = [
          {
            groupType: 'and',
            filters: opts.filters.map((f) => ({
              dimension: f.dimension,
              operator: f.operator,
              expression: f.expression,
            })),
          },
        ];
      }

      const json = await fetchJson<{ rows?: GscRow[]; error?: { message?: string; code?: number } }>(target, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        retries: 2,
        timeoutMs: 45_000,
      });
      if (json.error) {
        throw new SeoAgentError(
          'PROVIDER_ERROR',
          `Search Console: ${json.error.message ?? 'query failed'}`,
          json.error.code === 403
            ? `The credential cannot read "${site}". Call seo_gsc_sites to see accessible properties, and check the property string matches exactly.`
            : 'Check the date range is within the last 16 months and the dimensions are valid.',
        );
      }

      const page = json.rows ?? [];
      rows.push(...page);
      if (page.length < (body['rowLimit'] as number) || rows.length >= wanted) break;
      startRow += page.length;
    }

    return rows;
  }
}

function loadServiceAccount(input: string): ServiceAccountKey {
  // Accept either inline JSON or a path, since both are natural for an env var.
  let raw = input.trim();
  if (!raw.startsWith('{')) {
    if (!existsSync(raw)) {
      throw new SeoAgentError(
        'INVALID_INPUT',
        `GSC_SERVICE_ACCOUNT_JSON is neither JSON nor an existing file path: ${raw.slice(0, 80)}`,
        'Set it to the service-account JSON contents, or to a path to that file.',
      );
    }
    raw = readFileSync(raw, 'utf8');
  }
  let parsed: ServiceAccountKey;
  try {
    parsed = JSON.parse(raw) as ServiceAccountKey;
  } catch {
    throw new SeoAgentError(
      'INVALID_INPUT',
      'GSC_SERVICE_ACCOUNT_JSON is not valid JSON.',
      'Paste the full service-account key file contents, or provide a path to it.',
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new SeoAgentError(
      'INVALID_INPUT',
      'Service-account JSON is missing client_email or private_key.',
      'Download a fresh key from the Google Cloud console (IAM → Service Accounts → Keys).',
    );
  }
  return parsed;
}

export function createGscClient(cfg: Config): GscClient | null {
  if (!cfg.gsc) return null;
  const hasServiceAccount = Boolean(cfg.gsc.serviceAccountJson);
  const hasOauth = Boolean(cfg.gsc.clientId && cfg.gsc.clientSecret && cfg.gsc.refreshToken);
  if (!hasServiceAccount && !hasOauth) return null;
  return new GscClient(cfg.gsc);
}

export function requireGscClient(cfg: Config): GscClient {
  const c = createGscClient(cfg);
  if (!c) {
    throw providerNotConfigured(
      'Google Search Console (your own ranking data)',
      [
        'GSC_SERVICE_ACCOUNT_JSON + GSC_SITE_URL',
        'GSC_CLIENT_ID + GSC_CLIENT_SECRET + GSC_REFRESH_TOKEN + GSC_SITE_URL',
      ],
      'seo_rank_check via a SERP provider (costs credits, covers only keywords you specify)',
    );
  }
  return c;
}

/** Cached Search Analytics query. GSC data lags ~2 days, so caching is free accuracy-wise. */
export async function gscQuery(
  cfg: Config,
  opts: GscQueryOptions,
  extra: { siteUrl?: string; bypassCache?: boolean } = {},
): Promise<{ rows: GscRow[]; cached: boolean; site: string }> {
  const client = requireGscClient(cfg);
  const site = extra.siteUrl ?? client.siteUrl;
  const key = cacheKey('gsc', { site, ...opts });
  const result = await cached<GscRow[]>(
    key,
    TTL.gsc,
    () => client.searchAnalytics(opts, site),
    { source: 'gsc', ...(extra.bypassCache ? { bypass: true } : {}) },
  );
  return { rows: result.value, cached: result.cached, site };
}

/** YYYY-MM-DD `days` ago, in UTC. GSC expects date-only strings. */
export function daysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Search Console data is only final after ~2-3 days. Defaulting an "end date" to
 * today produces a fake decline at the end of every series, which an agent will
 * confidently report as a ranking drop.
 */
export const GSC_LAG_DAYS = 3;
