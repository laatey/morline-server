import { request } from './http.js';
import { env } from './env.js';

/**
 * Send an email.
 * @param {{ to: string | string[], subject: string, html?: string, text?: string, from?: string, replyTo?: string }} message
 * @returns {Promise<{ id: string | null }>}
 */
export async function sendEmail({ to, subject, html, text, from = env.optional('EMAIL_FROM', 'onboarding@resend.dev'), replyTo }) {
  if (!html && !text) throw new Error('sendEmail needs html or text');
  const data = await request('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.required('RESEND_API_KEY')}` },
    json: { from, to: Array.isArray(to) ? to : [to], subject, html, text, reply_to: replyTo }
  });
  return { id: data?.id ?? null };
}
