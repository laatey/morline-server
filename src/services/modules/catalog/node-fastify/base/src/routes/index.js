import { readdir } from 'node:fs/promises';

// Loads every other file in this folder as a route plugin. A file can export `prefix`;
// otherwise its name is used (orders.js is served under /orders).
export default async function routes(app) {
  const dir = new URL('./', import.meta.url);
  for (const file of (await readdir(dir)).sort()) {
    if (file === 'index.js' || !file.endsWith('.js')) continue;
    const mod = await import(new URL(file, dir));
    await app.register(mod.default, { prefix: mod.prefix ?? `/${file.slice(0, -3)}` });
  }
}
