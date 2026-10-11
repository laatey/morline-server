import assert from 'node:assert/strict';
import test from 'node:test';
import { signOAuthState, verifyOAuthState } from '../src/services/oauth-state.js';
import { verifyWebhookSignature } from '../src/services/github-webhook.js';
import crypto from 'node:crypto';

const secret = 'unit-test-secret';

test('signed state round-trips to the team id', () => {
  assert.equal(verifyOAuthState(signOAuthState('team_abc', { secret }), { secret }), 'team_abc');
});

test('a bare team id, a tampered team, a wrong secret and an expired state are all rejected', () => {
  assert.equal(verifyOAuthState('team_abc', { secret }), null);
  const good = signOAuthState('team_abc', { secret });
  assert.equal(verifyOAuthState(good.replace('team_abc', 'team_xyz'), { secret }), null);
  assert.equal(verifyOAuthState(good, { secret: 'other' }), null);
  const old = signOAuthState('team_abc', { secret, now: Date.now() - 60 * 60 * 1000 });
  assert.equal(verifyOAuthState(old, { secret }), null);
  assert.equal(verifyOAuthState(undefined, { secret }), null);
});

test('webhook signatures are verified against the raw body', () => {
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const sig = `sha256=${crypto.createHmac('sha256', 'whsec').update(body).digest('hex')}`;
  assert.equal(verifyWebhookSignature('whsec', body, sig), true);
  assert.equal(verifyWebhookSignature('whsec', Buffer.from('{"ref":"x"}'), sig), false);
  assert.equal(verifyWebhookSignature('whsec', body, 'sha256=deadbeef'), false);
  assert.equal(verifyWebhookSignature('whsec', body, undefined), false);
  assert.equal(verifyWebhookSignature('', body, sig), false);
});
