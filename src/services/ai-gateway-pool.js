import crypto from 'node:crypto';

const RETRYABLE = new Set([402, 403, 429, 500, 502, 503, 504]);
const DEFAULT_COOLDOWN_MS = 60_000;

function parseRetryAfter(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60 * 60_000);
  const at = Date.parse(value || '');
  return Number.isFinite(at) && at > Date.now() ? Math.min(at - Date.now(), 60 * 60_000) : DEFAULT_COOLDOWN_MS;
}

function cleanUrl(value, { allowHttp = false } = {}) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error('Gateway upstream URLs must use HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}

/** Parse the server-only pool. Keys must never be sent to the desktop app. */
export function loadGatewayUpstreams(value, { allowHttp = false } = {}) {
  if (!value) return [];
  let raw;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error('MORLINE_AI_GATEWAY_UPSTREAMS must be valid JSON');
  }
  if (!Array.isArray(raw)) throw new Error('MORLINE_AI_GATEWAY_UPSTREAMS must be a JSON array');
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string' || typeof entry.key !== 'string' || !entry.key) {
      throw new Error(`Gateway upstream ${index + 1} needs a url and key`);
    }
    return {
      id: typeof entry.id === 'string' && entry.id ? entry.id : `upstream-${index + 1}`,
      url: cleanUrl(entry.url, { allowHttp }),
      key: entry.key,
      models: Array.isArray(entry.models) ? new Set(entry.models.filter((model) => typeof model === 'string')) : null
    };
  });
}

export function isGatewayKeyValid(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function endpointFor(upstream, path) {
  // Lovable-compatible gateways expose the Anthropic protocol at /messages rather than /v1/messages.
  return `${upstream.url}${path === '/v1/messages' ? '/messages' : path}`;
}

function forwardHeaders(requestHeaders, upstream) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': upstream.key,
    authorization: `Bearer ${upstream.key}`
  };
  for (const name of ['accept', 'anthropic-version', 'anthropic-beta']) {
    const value = requestHeaders[name];
    if (typeof value === 'string' && value) headers[name] = value;
  }
  return headers;
}

/**
 * Health-aware, sequential upstream chooser. It never replays a request after an upstream has
 * begun a response body, preventing duplicate streamed answers or duplicate spend.
 */
export class AiGatewayPool {
  constructor(upstreams, { fetchImpl = fetch, now = () => Date.now(), timeoutMs = 180_000 } = {}) {
    this.upstreams = upstreams;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.unavailableUntil = new Map();
  }

  availableModels() {
    const named = this.upstreams.flatMap((upstream) => upstream.models ? [...upstream.models] : []);
    return [...new Set(named)];
  }

  async forward({ path = '/v1/messages', body, headers = {}, signal }) {
    const model = body?.model;
    const candidates = this.upstreams.filter((upstream) =>
      !upstream.models || !model || upstream.models.has(model)
    );
    if (!candidates.length) {
      const error = new Error('No configured upstream supports this model');
      error.status = 503;
      throw error;
    }

    let lastResponse = null;
    let lastError = null;
    for (const upstream of candidates) {
      if ((this.unavailableUntil.get(upstream.id) || 0) > this.now()) continue;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
      const abortRequest = () => abort.abort();
      signal?.addEventListener('abort', abortRequest, { once: true });
      try {
        const response = await this.fetch(endpointFor(upstream, path), {
          method: 'POST',
          headers: forwardHeaders(headers, upstream),
          body: JSON.stringify(body),
          signal: abort.signal
        });
        if (response.ok || !RETRYABLE.has(response.status)) return { response, upstreamId: upstream.id };

        lastResponse = response;
        this.unavailableUntil.set(upstream.id, this.now() + parseRetryAfter(response.headers.get('retry-after')));
      } catch (error) {
        lastError = error;
        this.unavailableUntil.set(upstream.id, this.now() + DEFAULT_COOLDOWN_MS);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortRequest);
      }
    }

    if (lastResponse) return { response: lastResponse, upstreamId: null };
    const error = new Error(lastError?.name === 'AbortError' ? 'All AI upstreams timed out' : 'No AI upstream is currently available');
    error.status = 503;
    throw error;
  }
}
