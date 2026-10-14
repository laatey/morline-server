import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyStripeSignature } from '../src/lib/stripe.js';

const sign = (body, secret, timestamp) =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

test('accepts a valid signature and rejects tampering or stale timestamps', () => {
  const body = JSON.stringify({ id: 'evt_1' });
  const now = Date.now();
  const header = sign(body, 'whsec_test', Math.floor(now / 1000));

  assert.equal(verifyStripeSignature(Buffer.from(body), header, 'whsec_test', 300, now), true);
  assert.equal(verifyStripeSignature(Buffer.from(`${body} `), header, 'whsec_test', 300, now), false);
  assert.equal(verifyStripeSignature(Buffer.from(body), header, 'whsec_other', 300, now), false);
  assert.equal(verifyStripeSignature(Buffer.from(body), header, 'whsec_test', 300, now + 10 * 60 * 1000), false);
});
