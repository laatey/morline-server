import { env } from '../lib/env.js';
import { verifyPaystackSignature } from '../lib/paystack.js';
import { handlePaystackEvent } from '../services/paystack-events.js';

// Recently handled events, so Paystack's retries are not processed twice. This is per process;
// with several instances, keep processed IDs in your database or Redis instead.
const seen = new Set();

export default async function paystackWebhook(app) {
  const secret = env.required('PAYSTACK_SECRET_KEY');

  // This plugin is encapsulated: only /webhooks/paystack receives the raw body Paystack signed.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/paystack', { config: { public: true } }, async (req, reply) => {
    const signature = req.headers['x-paystack-signature'];
    if (typeof signature !== 'string' || !verifyPaystackSignature(req.body, signature, secret)) {
      return reply.status(400).send({ code: 'invalid_signature', message: 'Invalid signature', requestId: req.id });
    }
    const event = JSON.parse(req.body.toString('utf8'));
    const key = `${event.event}:${event.data?.id ?? event.data?.reference}`;
    if (seen.has(key)) return { received: true, duplicate: true };

    await handlePaystackEvent(event, app);
    seen.add(key);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
    return { received: true };
  });
}
