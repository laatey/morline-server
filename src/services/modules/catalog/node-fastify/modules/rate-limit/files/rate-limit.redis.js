import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';

// Counters live in Redis, so every instance shares them. If Redis is unreachable the limiter
// lets requests through (skipOnError) rather than taking the API down with it.
export default fp(async function rateLimiting(app) {
  await app.register(rateLimit, {
    global: true,
    max: {{max}},
    timeWindow: {{window|json}},
    redis: app.redis,
    nameSpace: 'rate-limit:',
    skipOnError: true,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: 'rate_limited',
      message: `Too many requests. Try again in ${context.after}.`
    })
  });
}, { name: 'rate-limiting' });
