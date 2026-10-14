import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/lib/password.js';

test('passwords verify only against their own hash', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});
