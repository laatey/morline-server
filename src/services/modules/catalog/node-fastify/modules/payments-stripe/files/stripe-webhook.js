import { env } from '../lib/env.js';
import { verifyStripeSignature } from '../lib/stripe.js';
import { handleStripeEvent } from '../services/stripe-events.js';

// Recently handled event IDs, so Stripe's retries are not processed twice. This is per process;
// with several instances, keep processed IDs in your database or Redis instead.
const seen = new Set();

export default async function stripeWebhook(app) {
  const secret = env.required('STRIPE_WEBHOOK_SECRET');

  // This plugin is encapsulated: only /webhooks/stripe receives the raw body Stripe signed.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/stripe', { config: { public: true } }, async (req, reply) => {
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string' || !verifyStripeSignature(req.body, signature, secret)) {
      return reply.status(400).send({ code: 'invalid_signature', message: 'Invalid signature', requestId: req.id });
    }
    const event = JSON.parse(req.body.toString('utf8'));
    if (seen.has(event.id)) return { received: true, duplicate: true };

    await handleStripeEvent(event, app);
    seen.add(event.id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
    return { received: true };
  });
}
