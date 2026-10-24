import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createAiGatewayRouter } from '../src/routes/ai-gateway.js';
import { AiGatewayPool } from '../src/services/ai-gateway-pool.js';
import { errorHandler } from '../src/middleware/error-handler.js';

async function serve(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('uses the next upstream after a rate-limited request before streaming begins', async () => {
  const seen = [];
  const pool = new AiGatewayPool([
    { id: 'busy', url: 'https://one.example/api/public/ai', key: 'one', models: null },
    { id: 'ready', url: 'https://two.example/api/public/ai', key: 'two', models: null }
  ], {
    fetchImpl: async (url, options) => {
      seen.push({ url, headers: options.headers });
      if (url.startsWith('https://one.example')) return new Response('busy', { status: 429, headers: { 'retry-after': '60' } });
      return new Response('ok', { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const app = express();
  app.use(express.json());
  app.use('/ai', createAiGatewayRouter({ clientKey: 'client-key', pool }));
  app.use(errorHandler);
  const { base, close } = await serve(app);
  try {
    const response = await fetch(`${base}/ai/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'client-key' },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', stream: true, messages: [] })
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(seen.length, 2);
    assert.equal(seen[0].url, 'https://one.example/api/public/ai/messages');
    assert.equal(seen[1].headers['x-api-key'], 'two');
  } finally { close(); }
});

test('does not expose the gateway without its separate client key', async () => {
  const app = express();
  app.use(express.json());
  app.use('/ai', createAiGatewayRouter({ clientKey: 'client-key', pool: new AiGatewayPool([]) }));
  app.use(errorHandler);
  const { base, close } = await serve(app);
  try {
    const response = await fetch(`${base}/ai/health`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'invalid_api_key');
  } finally { close(); }
});
