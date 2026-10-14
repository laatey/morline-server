// A small wrapper around fetch for calling third-party APIs: timeout, optional retries on
// network errors, 429 and 5xx, and JSON or form bodies. Retries are off by default because
// repeating a POST can repeat its side effect.

export class HttpError extends Error {
  constructor(status, body, url) {
    super(`Request to ${new URL(url).host} failed with status ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function retryDelay(res, attempt) {
  const after = Number(res?.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 5000);
  return 250 * 2 ** attempt;
}

export async function request(url, { method = 'GET', headers = {}, json, form, body, timeoutMs = 15_000, retries = 0 } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['content-type'] = 'application/json';
  } else if (form !== undefined) {
    init.body = new URLSearchParams(form).toString();
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    init.body = body;
  }

  for (let attempt = 0; ; attempt++) {
    init.signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt < retries) { await sleep(retryDelay(null, attempt)); continue; }
      throw err;
    }
    const text = await res.text();
    if (res.ok) return parse(text);
    if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(retryDelay(res, attempt)); continue; }
    throw new HttpError(res.status, parse(text), url);
  }
}
