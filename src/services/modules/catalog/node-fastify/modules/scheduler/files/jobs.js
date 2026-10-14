// Scheduled jobs run inside the web server process, on every instance. For work that must run
// once across instances, enqueue it with the queue module instead.
//
// Example entry:
//   { name: 'cleanup', schedule: '0 3 * * *', run: async (app) => { /* ... */ } }

/** @type {{ name: string, schedule: string, run: (app: import('fastify').FastifyInstance) => Promise<void> }[]} */
export const jobs = [];
