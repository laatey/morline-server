import crypto from 'node:crypto';

/** Verify GitHub's `X-Hub-Signature-256` header against the raw request body. */
export function verifyWebhookSignature(secret, rawBody, header) {
  if (!secret || !rawBody || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
