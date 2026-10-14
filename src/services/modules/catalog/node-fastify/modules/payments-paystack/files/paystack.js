import { createHmac, timingSafeEqual } from 'node:crypto';
import { request } from './http.js';
import { env } from './env.js';

const API = 'https://api.paystack.co';
const auth = () => ({ authorization: `Bearer ${env.required('PAYSTACK_SECRET_KEY')}` });

/**
 * Start a payment. `amount` is in the smallest currency unit (for example pesewas, kobo or cents).
 * Redirect the customer to the returned `authorization_url`.
 * @param {{ email: string, amount: number, currency?: string, reference?: string, callbackUrl?: string, metadata?: object }} input
 * @returns {Promise<{ authorization_url: string, access_code: string, reference: string }>}
 */
export async function initializeTransaction({ email, amount, currency, reference, callbackUrl, metadata }) {
  const res = await request(`${API}/transaction/initialize`, {
    method: 'POST',
    headers: auth(),
    json: { email, amount, currency, reference, callback_url: callbackUrl, metadata }
  });
  return res.data;
}

/** Look up a transaction by reference and return Paystack's record of it. */
export async function verifyTransaction(reference) {
  const res = await request(`${API}/transaction/verify/${encodeURIComponent(reference)}`, { headers: auth(), retries: 2 });
  return res.data;
}

/** Check the x-paystack-signature header against the raw request body. */
export function verifyPaystackSignature(rawBody, signature, secret) {
  const expected = createHmac('sha512', secret).update(rawBody).digest();
  const given = Buffer.from(String(signature), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
