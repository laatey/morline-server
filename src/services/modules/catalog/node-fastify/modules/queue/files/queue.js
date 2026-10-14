import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env.js';

let connection;
const shared = () => (connection ??= new IORedis(env.required('REDIS_URL'), { maxRetriesPerRequest: null }));

/** A queue you can add jobs to: `await createQueue('emails').add('welcome', { userId })`. */
export function createQueue(name, options = {}) {
  return new Queue(name, { connection: shared(), ...options });
}

/** A worker that runs `processor(job)` for each job on the queue. */
export function createWorker(name, processor, options = {}) {
  return new Worker(name, processor, { connection: shared(), concurrency: env.int('WORKER_CONCURRENCY', 5), ...options });
}
