// Every environment variable the app reads goes through here, so a missing or malformed value
// stops the server at startup with a clear message instead of failing later.

const read = (key) => {
  const value = process.env[key];
  return value === undefined || value === '' ? undefined : value;
};

export const env = {
  isProduction: process.env.NODE_ENV === 'production',

  required(key) {
    const value = read(key);
    if (value === undefined) throw new Error(`Missing required environment variable ${key}`);
    return value;
  },

  optional(key, fallback) {
    return read(key) ?? fallback;
  },

  int(key, fallback) {
    const value = read(key);
    if (value === undefined) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== value.trim()) throw new Error(`Environment variable ${key} must be a whole number`);
    return parsed;
  },

  bool(key, fallback) {
    const value = read(key);
    if (value === undefined) return fallback;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new Error(`Environment variable ${key} must be true or false`);
  }
};
