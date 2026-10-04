import {
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL,
  GEMINI_API_KEY, ANTHROPIC_API_KEY,
  AI_GATEWAY_URL, AI_GATEWAY_KEY, AI_GATEWAY_MODEL
} from '../config.js';

const TIMEOUT_MS = 120_000;

export function llmConfigured() {
  return Boolean(AI_GATEWAY_KEY || ANTHROPIC_API_KEY || OPENAI_API_KEY || GEMINI_API_KEY);
}

async function chatCompletions(baseUrl, key, model, system, user, maxTokens) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty response');
  return text;
}

async function anthropic(system, user, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      system,
      messages: [{ role: 'user', content: user }],
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
 * Plain completion across whichever providers are configured. Providers are tried in
 * order (gateway, Anthropic, OpenAI, Gemini); the first one that answers wins.
 */
export async function completeText({ system, user, maxTokens = 4096 }) {
  const providers = [];
  if (AI_GATEWAY_KEY) {
    providers.push(['gateway', () => chatCompletions(AI_GATEWAY_URL, AI_GATEWAY_KEY, AI_GATEWAY_MODEL || 'google/gemini-2.5-flash', system, user, maxTokens)]);
  }
  if (ANTHROPIC_API_KEY) providers.push(['anthropic', () => anthropic(system, user, maxTokens)]);
  if (OPENAI_API_KEY) {
    providers.push(['openai', () => chatCompletions(OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL || 'gpt-4o-mini', system, user, maxTokens)]);
  }
  if (GEMINI_API_KEY) {
    providers.push(['gemini', () => chatCompletions('https://generativelanguage.googleapis.com/v1beta/openai', GEMINI_API_KEY,
      process.env.GEMINI_MODEL || 'gemini-2.5-flash', system, user, maxTokens)]);
  }
  if (!providers.length) {
    throw new Error('AI analysis is not configured on this server. Set AI_GATEWAY_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY.');
  }

  const failures = [];
  for (const [name, call] of providers) {
    try {
      return await call();
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(`No AI provider could complete the analysis (${failures.join('; ')})`);
}
