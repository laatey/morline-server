import { request } from './http.js';
import { env } from './env.js';

/**
 * Send an email.
 * @param {{ to: string | string[], subject: string, html?: string, text?: string, from?: string, replyTo?: string }} message
 * @returns {Promise<{ id: string | null }>}
 */
export async function sendEmail({ to, subject, html, text, from = env.required('EMAIL_FROM'), replyTo }) {
  if (!html && !text) throw new Error('sendEmail needs html or text');
  const data = await request('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { 'x-postmark-server-token': env.required('POSTMARK_SERVER_TOKEN'), accept: 'application/json' },
    json: {
      From: from,
      To: Array.isArray(to) ? to.join(',') : to,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      ReplyTo: replyTo,
      MessageStream: 'outbound'
    }
  });
  return { id: data?.MessageID ?? null };
}
