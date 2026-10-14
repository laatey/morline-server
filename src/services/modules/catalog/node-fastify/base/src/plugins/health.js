// /health says the process is up. /ready says its dependencies (database, cache) are reachable;
// modules add their own checks to app.readinessChecks.
export default async function health(app) {
  const open = { public: true, rateLimit: false };

  app.get('/health', { config: open }, async () => ({ status: 'ok' }));

  app.get('/ready', { config: open }, async (req, reply) => {
    const results = await Promise.allSettled(app.readinessChecks.map((check) => check()));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      req.log.warn({ failed: failed.map((f) => String(f.reason?.message ?? f.reason)) }, 'not ready');
      return reply.status(503).send({ status: 'unavailable' });
    }
    return { status: 'ready' };
  });
}
