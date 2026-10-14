import { request } from './http.js';
import { env } from './env.js';

/**
 * Send an email.
 * @param {{ to: string | string[], subject: string, html?: string, text?: string, from?: string, replyTo?: string }} message
 * @returns {Promise<{ id: string | null }>}
 */
export async function sendEmail({ to, subject, html, text, from = env.required('EMAIL_FROM'), replyTo }) {
  if (!html && !text) throw new Error('sendEmail needs html or text');
  // SendGrid requires text/plain to come before text/html.
  const content = [text && { type: 'text/plain', value: text }, html && { type: 'text/html', value: html }].filter(Boolean);
  await request('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.required('SENDGRID_API_KEY')}` },
    json: {
      personalizations: [{ to: (Array.isArray(to) ? to : [to]).map((email) => ({ email })) }],
      from: { email: from },
      reply_to: replyTo ? { email: replyTo } : undefined,
      subject,
      content
    }
  });
  return { id: null };
}
