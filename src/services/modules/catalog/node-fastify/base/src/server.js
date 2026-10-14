import { buildApp } from './app.js';
import { env } from './lib/env.js';

const app = await buildApp();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), 10_000).unref();
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  });
}

try {
  await app.listen({ port: env.int('PORT', 3000), host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
