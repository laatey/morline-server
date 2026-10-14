import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// scrypt with 64 MiB of memory per hash (OWASP's recommended minimum configuration).
const PARAMS = { N: 65536, r: 8, p: 2 };
const MAX_MEMORY = 160 * 1024 * 1024;
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEMORY });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: MAX_MEMORY
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}
