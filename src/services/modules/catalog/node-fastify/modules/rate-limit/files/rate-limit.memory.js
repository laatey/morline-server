import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';

// Counters live in this process, so each instance counts on its own.
// Use the redis store option to share limits between instances.
export default fp(async function rateLimiting(app) {
  await app.register(rateLimit, {
    global: true,
    max: {{max}},
    timeWindow: {{window|json}},
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: 'rate_limited',
      message: `Too many requests. Try again in ${context.after}.`
    })
  });
}, { name: 'rate-limiting' });
