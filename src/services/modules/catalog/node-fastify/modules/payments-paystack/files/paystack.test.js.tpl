import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyPaystackSignature } from '../src/lib/paystack.js';

test('accepts a valid signature and rejects tampering', () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 1 } }));
  const signature = createHmac('sha512', 'sk_test_secret').update(body).digest('hex');

  assert.equal(verifyPaystackSignature(body, signature, 'sk_test_secret'), true);
  assert.equal(verifyPaystackSignature(Buffer.from(`${body} `), signature, 'sk_test_secret'), false);
  assert.equal(verifyPaystackSignature(body, signature, 'sk_test_other'), false);
  assert.equal(verifyPaystackSignature(body, 'not-hex', 'sk_test_secret'), false);
});
