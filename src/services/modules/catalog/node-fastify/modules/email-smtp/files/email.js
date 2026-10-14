import nodemailer from 'nodemailer';
import { env } from './env.js';

let transport;

/**
 * Send an email.
 * @param {{ to: string | string[], subject: string, html?: string, text?: string, from?: string, replyTo?: string }} message
 * @returns {Promise<{ id: string | null }>}
 */
export async function sendEmail({ to, subject, html, text, from = env.required('EMAIL_FROM'), replyTo }) {
  if (!html && !text) throw new Error('sendEmail needs html or text');
  transport ??= nodemailer.createTransport(env.required('SMTP_URL'));
  const info = await transport.sendMail({ from, to, subject, html, text, replyTo });
  return { id: info.messageId ?? null };
}
