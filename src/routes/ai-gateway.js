import { Router } from 'express';
import { Readable } from 'node:stream';
import { AppError, unauthorized, validationError } from '../middleware/error-handler.js';
import { isGatewayKeyValid } from '../services/ai-gateway-pool.js';

function clientKey(req) {
  const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  return req.get('x-api-key') || bearer || '';
}

function copyResponseHeaders(source, target) {
  for (const name of ['content-type', 'cache-control', 'retry-after', 'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining']) {
    const value = source.headers.get(name);
    if (value) target.setHeader(name, value);
  }
}

function proxyResponse(response, res) {
  res.status(response.status);
  copyResponseHeaders(response, res);
  if (!response.body) return res.end();
  const stream = Readable.fromWeb(response.body);
  stream.on('error', () => { if (!res.destroyed) res.destroy(); });
  stream.pipe(res);
}

/** Public only to callers holding MORLINE_AI_GATEWAY_CLIENT_KEY (for example MoreCode). */
export function createAiGatewayRouter({ clientKey: expectedKey, pool }) {
  const router = Router();
  router.use((req, _res, next) => {
    if (!expectedKey) return next(new AppError('AI gateway is not configured', 503, 'gateway_unavailable'));
    if (!isGatewayKeyValid(clientKey(req), expectedKey)) return next(unauthorized('A valid AI gateway key is required', 'invalid_api_key'));
    next();
  });

  router.get('/health', (_req, res) => res.json({ status: 'healthy', upstreams: pool.upstreams.length }));
  router.get('/v1/models', (_req, res) => res.json({ object: 'list', data: pool.availableModels().map((id) => ({ id, object: 'model' })) }));

  router.post('/v1/messages', async (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || typeof req.body.model !== 'string') {
      return next(validationError('model is required'));
    }
    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const { response } = await pool.forward({ body: req.body, headers: req.headers, signal: abort.signal });
      proxyResponse(response, res);
    } catch (error) {
      next(error instanceof AppError ? error : new AppError(error.message || 'AI gateway request failed', error.status || 503, 'gateway_unavailable'));
    }
  });
  return router;
}
