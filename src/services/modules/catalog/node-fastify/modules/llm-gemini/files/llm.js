import { request } from './http.js';
import { env } from './env.js';

/**
 * Ask the model for a reply.
 * @param {{ system?: string, messages: { role: "user" | "assistant", content: string }[], maxTokens?: number }} input
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
 */
export async function generate({ system, messages, maxTokens = 1024 }) {
  const model = env.optional('LLM_MODEL', 'gemini-2.5-flash');
  const data = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    retries: 2,
    timeoutMs: 60_000,
    headers: { 'x-goog-api-key': env.required('GEMINI_API_KEY') },
    json: {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: maxTokens }
    }
  });
  return {
    text: (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join(''),
    usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 }
  };
}
