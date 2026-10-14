import fp from 'fastify-plugin';
import client from 'prom-client';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../lib/env.js';

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default fp(async function metrics(app) {
  const token = env.optional('METRICS_TOKEN', undefined);
  client.collectDefaultMetrics();
  const duration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5]
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url;
    if (route) duration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });

  if (env.isProduction && !token) {
    app.log.warn('METRICS_TOKEN is not set, so /metrics is not exposed');
    return;
  }

  app.get('/metrics', { config: { public: true, rateLimit: false } }, async (req, reply) => {
    if (token && !same(req.headers.authorization ?? '', `Bearer ${token}`)) {
      return reply.status(401).send({ code: 'unauthorized', message: 'Invalid metrics token', requestId: req.id });
    }
    return reply.type(client.register.contentType).send(await client.register.metrics());
  });
}, { name: 'metrics' });
