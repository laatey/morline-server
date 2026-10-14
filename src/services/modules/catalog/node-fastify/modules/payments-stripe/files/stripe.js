import { createHmac, timingSafeEqual } from 'node:crypto';
import { request } from './http.js';
import { env } from './env.js';

/**
 * Create a Stripe Checkout session. Redirect the customer to the returned `url`.
 * @param {{ priceId: string, quantity?: number, mode?: 'payment' | 'subscription', successUrl: string, cancelUrl: string, customerEmail?: string, clientReferenceId?: string }} input
 */
export async function createCheckoutSession({ priceId, quantity = 1, mode = 'payment', successUrl, cancelUrl, customerEmail, clientReferenceId }) {
  const form = {
    mode,
    success_url: successUrl,
    cancel_url: cancelUrl,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': String(quantity)
  };
  if (customerEmail) form.customer_email = customerEmail;
  if (clientReferenceId) form.client_reference_id = clientReferenceId;
  return request('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.required('STRIPE_SECRET_KEY')}` },
    form
  });
}

/** Check the Stripe-Signature header against the raw request body. */
export function verifyStripeSignature(rawBody, header, secret, toleranceSeconds = 300, now = Date.now()) {
  const items = String(header).split(',').map((part) => part.split('='));
  const timestamp = items.find(([key]) => key === 't')?.[1];
  const signatures = items.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
