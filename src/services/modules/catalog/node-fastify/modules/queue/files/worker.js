import { readdir } from 'node:fs/promises';
import { createWorker } from './lib/queue.js';

// Run this file as its own process: `node src/worker.js`.
// Every file in src/workers exports the `queue` it listens to and a `process(job)` function.
const dir = new URL('./workers/', import.meta.url);
let files = [];
try {
  files = (await readdir(dir)).filter((file) => file.endsWith('.js')).sort();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const log = (level, message, extra = {}) => console.log(JSON.stringify({ level, message, ...extra }));
if (!files.length) log('warn', 'No workers found in src/workers, nothing to run');

const workers = [];
for (const file of files) {
  const mod = await import(new URL(file, dir));
  const worker = createWorker(mod.queue, mod.process);
  worker.on('failed', (job, err) => log('error', 'job failed', { queue: mod.queue, jobId: job?.id, error: err.message }));
  workers.push(worker);
  log('info', 'worker started', { queue: mod.queue });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    process.exit(0);
  });
}
