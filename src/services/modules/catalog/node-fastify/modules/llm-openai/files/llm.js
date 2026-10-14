import { request } from './http.js';
import { env } from './env.js';

/**
 * Ask the model for a reply.
 * @param {{ system?: string, messages: { role: "user" | "assistant", content: string }[], maxTokens?: number }} input
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
 */
export async function generate({ system, messages, maxTokens = 1024 }) {
  const data = await request('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    retries: 2,
    timeoutMs: 60_000,
    headers: { authorization: `Bearer ${env.required('OPENAI_API_KEY')}` },
    json: {
      model: env.optional('LLM_MODEL', 'gpt-4o-mini'),
      max_completion_tokens: maxTokens,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages
    }
  });
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 }
  };
}
