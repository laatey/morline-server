import fp from 'fastify-plugin';
import cron from 'node-cron';
import { jobs } from '../jobs/index.js';

export default fp(async function scheduler(app) {
  const tasks = jobs.map((job) => {
    if (!cron.validate(job.schedule)) throw new Error(`Job "${job.name}" has an invalid cron schedule: ${job.schedule}`);
    return cron.schedule(job.schedule, async () => {
      try {
        await job.run(app);
        app.log.info({ job: job.name }, 'job finished');
      } catch (err) {
        app.log.error({ err, job: job.name }, 'job failed');
      }
    });
  });
  app.addHook('onClose', async () => {
    for (const task of tasks) task.stop();
  });
}, { name: 'scheduler' });
