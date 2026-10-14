import { request } from './http.js';
import { env } from './env.js';

/**
 * Ask the model for a reply.
 * @param {{ system?: string, messages: { role: "user" | "assistant", content: string }[], maxTokens?: number }} input
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
 */
export async function generate({ system, messages, maxTokens = 1024 }) {
  const data = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    retries: 2,
    timeoutMs: 60_000,
    headers: { 'x-api-key': env.required('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    json: { model: env.optional('LLM_MODEL', 'claude-sonnet-5-5'), max_tokens: maxTokens, system, messages }
  });
  return {
    text: data.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }
  };
}
