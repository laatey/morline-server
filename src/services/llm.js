import {
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL,
  GEMINI_API_KEY, ANTHROPIC_API_KEY,
  AI_GATEWAY_URL, AI_GATEWAY_KEY, AI_GATEWAY_MODEL, AI_GATEWAY_FAST_MODEL
} from '../config.js';

const TIMEOUT_MS = 180_000;

export function llmConfigured() {
  return Boolean(AI_GATEWAY_KEY || ANTHROPIC_API_KEY || OPENAI_API_KEY || GEMINI_API_KEY);
}

/** Read a server-sent event body, calling `onData(parsedJson)` for each `data:` line. */
async function readSse(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onData(JSON.parse(payload)); } catch { /* ignore keep-alives and partial frames */ }
    }
  }
}

const isEventStream = (res) => (res.headers.get('content-type') || '').includes('text/event-stream');

// Message content is a string, or a list of parts: { type: 'text', text } and { type: 'image', mediaType, data (base64) }.
const toOpenAI = (m) => (typeof m.content === 'string' ? m : {
  ...m,
  content: m.content.map((p) => (p.type === 'image' ? { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } } : p))
});
const toAnthropic = (m) => (typeof m.content === 'string' ? m : {
  ...m,
  content: m.content.map((p) => (p.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } } : p))
});

async function chatCompletions(baseUrl, key, model, system, messages, { maxTokens, temperature, onText }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      stream: Boolean(onText),
      messages: [{ role: 'system', content: system }, ...messages.map(toOpenAI)]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);

  let text = '';
  let truncated = false;
  if (onText && isEventStream(res)) {
    await readSse(res, (o) => {
      const choice = o.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) { text += delta; onText(delta); }
      if (choice?.finish_reason === 'length') truncated = true;
    });
  } else {
    // Not streamed (or a gateway that answers in one piece).
    const data = await res.json();
    text = data.choices?.[0]?.message?.content || '';
    truncated = data.choices?.[0]?.finish_reason === 'length';
    if (text && onText) onText(text);
  }
  if (!text) throw new Error('empty response');
  return { text, truncated };
}

/** Anthropic Messages format. `target` points it at the gateway's /messages route instead of api.anthropic.com. */
async function anthropic(system, messages, { maxTokens, temperature, onText }, target = {}) {
  const key = target.key || ANTHROPIC_API_KEY;
  const res = await fetch(target.url || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      ...(target.url ? { Authorization: `Bearer ${key}` } : {}),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: target.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      system,
      messages: messages.map(toAnthropic),
      temperature,
      max_tokens: maxTokens,
      stream: Boolean(onText)
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);

  let text = '';
  let truncated = false;
  if (onText && isEventStream(res)) {
    await readSse(res, (o) => {
      if (o.type === 'content_block_delta' && o.delta?.type === 'text_delta' && o.delta.text) { text += o.delta.text; onText(o.delta.text); }
      if (o.type === 'message_delta' && o.delta?.stop_reason === 'max_tokens') truncated = true;
    });
  } else {
    const data = await res.json();
    text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    truncated = data.stop_reason === 'max_tokens';
    if (text && onText) onText(text);
  }
  if (!text) throw new Error('empty response');
  return { text, truncated };
}

/**
 * Multi-turn completion across whichever providers are configured. Providers are tried in
 * order (gateway, Anthropic, OpenAI, Gemini); the first one that answers wins.
 * `messages` is a list of `{ role: 'user' | 'assistant', content }`.
 */
export async function completeDetailed({ system, messages, maxTokens = 4096, temperature = 0.2, onText, fast = false }) {
  const opts = { maxTokens, temperature, onText };
  const providers = [];
  if (AI_GATEWAY_KEY) {
    const model = (fast && AI_GATEWAY_FAST_MODEL) || AI_GATEWAY_MODEL || 'google/gemini-2.5-flash';
    // The gateway serves Claude on /messages (Anthropic format) and everything else on /chat/completions.
    providers.push(['gateway', () => model.startsWith('anthropic/')
      ? anthropic(system, messages, opts, { url: `${AI_GATEWAY_URL}/messages`, key: AI_GATEWAY_KEY, model })
      : chatCompletions(AI_GATEWAY_URL, AI_GATEWAY_KEY, model, system, messages, opts)]);
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

/** Same as `completeDetailed` but returns just the text. */
export async function complete(options) {
  return (await completeDetailed(options)).text;
}

/**
 * For long structured output: keeps asking the model to continue while the reply was cut off
 * (the provider says so, or `isComplete(text)` says the format isn't closed). `onText(delta, soFar)`
 * receives every streamed piece with the full text so far.
 */
export async function completeLong({ system, messages, maxTokens = 16000, temperature = 0.2, onText, isComplete, maxRounds = 3 }) {
  let text = '';
  for (let round = 0; round < maxRounds; round++) {
    const convo = round === 0
      ? messages
      : [...messages, { role: 'assistant', content: text }, { role: 'user', content: 'Your reply was cut off. Continue exactly where it stopped. Do not repeat anything and do not add any preamble.' }];
    const prefix = text;
    const part = await completeDetailed({
      system, messages: convo, maxTokens, temperature: round ? 0 : temperature,
      onText: onText ? (delta) => onText(delta, prefix + delta) : undefined
    });
    text += part.text;
    if (!part.truncated) return text; // the model finished (cleanly or not); asking it to "continue" would only confuse it
  }
  return text;
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
export async function completeJson({ system, messages, maxTokens = 16000, temperature = 0.2, fast = false }) {
  const first = await complete({ system, messages, maxTokens, temperature, fast });
  try {
    return extractJson(first);
  } catch (err) {
    const retry = await complete({
      system,
      messages: [...messages, { role: 'assistant', content: first.slice(0, 4000) }, { role: 'user', content: `That was not valid JSON (${err.message}). Reply again with only the JSON object, nothing else.` }],
      maxTokens,
      temperature: 0,
      fast
    });
    return extractJson(retry);
  }
}
