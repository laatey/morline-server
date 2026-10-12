import {
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL,
  GEMINI_API_KEY, ANTHROPIC_API_KEY,
  AI_GATEWAY_URL, AI_GATEWAY_KEY, AI_GATEWAY_MODEL
} from '../config.js';

const TIMEOUT_MS = 180_000;

export function llmConfigured() {
  return Boolean(AI_GATEWAY_KEY || ANTHROPIC_API_KEY || OPENAI_API_KEY || GEMINI_API_KEY);
}

async function chatCompletions(baseUrl, key, model, system, messages, { maxTokens, temperature }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty response');
  return text;
}

async function anthropic(system, messages, { maxTokens, temperature }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      system,
      messages,
      temperature,
      max_tokens: maxTokens
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text) throw new Error('empty response');
  return text;
}

/**
 * Multi-turn completion across whichever providers are configured. Providers are tried in
 * order (gateway, Anthropic, OpenAI, Gemini); the first one that answers wins.
 * `messages` is a list of `{ role: 'user' | 'assistant', content }`.
 */
export async function complete({ system, messages, maxTokens = 4096, temperature = 0.2 }) {
  const opts = { maxTokens, temperature };
  const providers = [];
  if (AI_GATEWAY_KEY) {
    providers.push(['gateway', () => chatCompletions(AI_GATEWAY_URL, AI_GATEWAY_KEY, AI_GATEWAY_MODEL || 'google/gemini-2.5-flash', system, messages, opts)]);
  }
  if (ANTHROPIC_API_KEY) providers.push(['anthropic', () => anthropic(system, messages, opts)]);
  if (OPENAI_API_KEY) {
    providers.push(['openai', () => chatCompletions(OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL || 'gpt-4o-mini', system, messages, opts)]);
  }
  if (GEMINI_API_KEY) {
    providers.push(['gemini', () => chatCompletions('https://generativelanguage.googleapis.com/v1beta/openai', GEMINI_API_KEY,
      process.env.GEMINI_MODEL || 'gemini-2.5-flash', system, messages, opts)]);
  }
  if (!providers.length) {
    throw new Error('AI is not configured on this server. Set AI_GATEWAY_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY.');
  }

  const failures = [];
  for (const [name, call] of providers) {
    try {
      return await call();
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(`No AI provider could complete the request (${failures.join('; ')})`);
}

/** Single-turn convenience wrapper. */
export function completeText({ system, user, maxTokens = 4096 }) {
  return complete({ system, messages: [{ role: 'user', content: user }], maxTokens });
}

/** Pull a JSON object out of a model reply, tolerating code fences and surrounding prose. */
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('The model returned no text');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model did not return JSON');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new Error(`The model returned malformed JSON (${err.message})`);
  }
}

/** Completion that must come back as a JSON object. Retries once, telling the model what was wrong. */
export async function completeJson({ system, messages, maxTokens = 16000, temperature = 0.2 }) {
  const first = await complete({ system, messages, maxTokens, temperature });
  try {
    return extractJson(first);
  } catch (err) {
    const retry = await complete({
      system,
      messages: [...messages, { role: 'assistant', content: first.slice(0, 4000) }, { role: 'user', content: `That was not valid JSON (${err.message}). Reply again with only the JSON object, nothing else.` }],
      maxTokens,
      temperature: 0
    });
    return extractJson(retry);
  }
}
