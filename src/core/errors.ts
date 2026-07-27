/**
 * Errors are part of the API surface here.
 *
 * When a tool fails, an agent should learn *what to do about it* from the error
 * itself — not retry blindly. So every error carries a machine-readable code and
 * a `remedy` string that names the concrete fix (set this env var, lower this
 * limit, configure this provider).
 */

export type ErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_ERROR'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED'
  | 'NETWORK'
  | 'ROBOTS_DISALLOWED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'INTERNAL';

export class SeoAgentError extends Error {
  readonly code: ErrorCode;
  /** What the caller should do next. Written for an agent, imperative voice. */
  readonly remedy: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    remedy: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SeoAgentError';
    this.code = code;
    this.remedy = remedy;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      remedy: this.remedy,
      details: this.details,
    };
  }
}

export function providerNotConfigured(
  capability: string,
  envVars: string[],
  fallback?: string,
): SeoAgentError {
  const remedy = fallback
    ? `Set one of ${envVars.join(' or ')} to enable ${capability}. ` +
      `Without it you can still use: ${fallback}. Call seo_capabilities to see what is available.`
    : `Set one of ${envVars.join(' or ')} to enable ${capability}. ` +
      `Call seo_capabilities to see what is available right now.`;
  return new SeoAgentError(
    'PROVIDER_NOT_CONFIGURED',
    `No provider configured for ${capability}.`,
    remedy,
    { capability, env_vars: envVars },
  );
}

export function invalidInput(message: string, remedy: string): SeoAgentError {
  return new SeoAgentError('INVALID_INPUT', message, remedy);
}

export function budgetExceeded(spent: number, cap: number): SeoAgentError {
  return new SeoAgentError(
    'BUDGET_EXCEEDED',
    `Provider budget exhausted: ${spent}/${cap} units used this session.`,
    'Raise SEO_AGENT_BUDGET or start a new session. ' +
      'Provider-free tools (crawl, audit, suggest, content scoring) still work.',
    { spent, cap },
  );
}

/** Turn anything thrown into a SeoAgentError so callers get a consistent shape. */
/**
 * Dig the OS-level error code out of a fetch rejection.
 *
 * Reading `err.cause.code` is not enough: when a host resolves to several
 * addresses undici reports an `AggregateError` whose `.errors[]` hold the real
 * codes, and `cause` can nest. Missing that meant a refused connection came back
 * as INTERNAL — telling the agent it had found a bug in seo-agent — and, worse,
 * `fetchWithRetry` throws immediately on INTERNAL, so genuinely transient
 * network failures skipped the retry loop entirely.
 */
function causeCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (e: unknown): string | undefined => {
    if (e === null || typeof e !== 'object' || seen.has(e)) return undefined;
    seen.add(e);
    const candidate = e as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    if (Array.isArray(candidate.errors)) {
      for (const sub of candidate.errors) {
        const found = walk(sub);
        if (found !== undefined) return found;
      }
    }
    return walk(candidate.cause);
  };
  return walk((err as { cause?: unknown }).cause);
}

export function normalizeError(err: unknown): SeoAgentError {
  if (err instanceof SeoAgentError) return err;
  if (err instanceof Error) {
    const msg = err.message;
    // Node's fetch buries the useful part in `cause`, sometimes several levels down.
    const code = causeCode(err);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new SeoAgentError(
        'NETWORK',
        `DNS lookup failed: ${msg}`,
        'Check the hostname is spelled correctly and reachable from this machine.',
        { cause: code },
      );
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      return new SeoAgentError('NETWORK', `Connection failed: ${msg}`, 'Retry once; if it persists the host is down or blocking us.', {
        cause: code,
      });
    }
    if (err.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
      return new SeoAgentError('TIMEOUT', `Request timed out: ${msg}`, 'Retry with a longer timeout_ms, or reduce concurrency.', {
        cause: code,
      });
    }
    if (code !== undefined && /^(E[A-Z]+|UND_ERR_|CERT_|ERR_TLS|ERR_SSL|DEPTH_ZERO)/.test(code)) {
      return new SeoAgentError('NETWORK', `Request failed (${code}): ${msg}`, 'Check the host is reachable and serving valid TLS from this machine.', {
        cause: code,
      });
    }
    // `TypeError: fetch failed` with no recoverable cause is still a network
    // failure, never a defect in this codebase. Classifying it INTERNAL both
    // misdirects the agent and disables retries.
    if (/fetch failed|network|socket hang up|premature close/i.test(msg)) {
      return new SeoAgentError('NETWORK', `Request failed: ${msg}`, 'Check the URL is reachable from this machine, then retry.', {
        ...(code !== undefined ? { cause: code } : {}),
      });
    }
    return new SeoAgentError('INTERNAL', msg, 'This is likely a bug in seo-agent. Report the message and inputs.', {
      stack: err.stack?.split('\n').slice(0, 4).join('\n'),
    });
  }
  return new SeoAgentError('INTERNAL', String(err), 'Unexpected non-Error value thrown.');
}
