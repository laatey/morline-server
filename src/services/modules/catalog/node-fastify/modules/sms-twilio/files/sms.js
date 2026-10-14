import { request } from './http.js';
import { env } from './env.js';

/**
 * Send a text message. `to` must be in E.164 format, for example +14155550123.
 * @param {{ to: string, body: string, from?: string }} message
 * @returns {Promise<{ id: string }>}
 */
export async function sendSms({ to, body, from = env.required('TWILIO_FROM') }) {
  const sid = env.required('TWILIO_ACCOUNT_SID');
  const credentials = Buffer.from(`${sid}:${env.required('TWILIO_AUTH_TOKEN')}`).toString('base64');
  const data = await request(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${credentials}` },
    form: { To: to, Body: body, ...(from.startsWith('MG') ? { MessagingServiceSid: from } : { From: from }) }
  });
  return { id: data.sid };
}
