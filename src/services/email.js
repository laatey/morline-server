import { Resend } from 'resend';
import { RESEND_API_KEY, PUBLIC_URL, FRONTEND_URL } from '../config.js';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const FROM = 'Morline <noreply@morline.space>';

/**
 * Send an email via Resend. Silently logs and returns false if Resend is not configured.
 */
async function send({ to, subject, html, text }) {
  if (!resend) {
    console.warn(`[Email] Resend not configured — skipping email to ${to}: "${subject}"`);
    return false;
  }
  try {
    const { error } = await resend.emails.send({ from: FROM, to, subject, html, ...(text ? { text } : {}) });
    if (error) {
      console.error(`[Email] Resend error for ${to}:`, error);
      return false;
    }
    console.log(`[Email] Sent "${subject}" → ${to}`);
    return true;
  } catch (err) {
    console.error(`[Email] Failed to send to ${to}:`, err.message);
    return false;
  }
}

// ─── Layout ───────────────────────────────────────────────────────────────────
// Modelled on GitHub's notification emails: logo, a large title, one bordered card holding a centred
// icon, heading and button, then a divider and a details table, and a centred footer. Tables and
// inline styles only (mail clients ignore most modern CSS). Light colours are inline; the dark theme
// is a prefers-color-scheme override, and Gmail's own inversion has explicit colours to work from.

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ASSET = (name) => `${process.env.EMAIL_ASSET_URL || FRONTEND_URL}/${name}`;
const LOGO_URL = process.env.EMAIL_LOGO_URL || ASSET('email-logo.png');
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif";
const BLUE = '#1a5cdf';

const TONES = {
  bad: { icon: 'failed', bg: '#e5484d', glyph: '&#10005;' },
  warn: { icon: 'warning', bg: '#d97706', glyph: '!' },
  good: { icon: 'success', bg: '#22a05a', glyph: '&#10003;' },
  info: { icon: 'info', bg: '#526eeb', glyph: 'i' }
};

const css = `
  body, table, td, p, a { -webkit-text-size-adjust: 100%; }
  @media (max-width: 620px) { .container { width: 100% !important; } .pad { padding-left: 20px !important; padding-right: 20px !important; } .hide-sm { display: none !important; } }
  @media (prefers-color-scheme: dark) {
    .bg { background-color: #0d0d0e !important; }
    .card { background-color: #0d0d0e !important; border-color: #2e2e32 !important; }
    .t1 { color: #f4f4f5 !important; }
    .t2 { color: #a1a1aa !important; }
    .rule { border-top-color: #2e2e32 !important; border-bottom-color: #2e2e32 !important; }
    .btn { background-color: #4b89ff !important; }
    .btn a { color: #0d0d0e !important; }
    .link { color: #7aa5ff !important; }
  }
`;

/**
 * @param {{ title: string, preheader?: string, icon?: string, heading: string, subtext?: string,
 *   cta?: { label: string, url: string }, table?: { headers: string[], rows: Array<Array<string | { tone: string, text?: string }>> },
 *   note?: string, footer?: string }} o   All text is escaped here; pass plain text.
 */
function layout({ title, preheader, icon = 'info', heading, subtext, cta, table, note, footer }) {
  const cell = (v, i) => {
    if (v && typeof v === 'object') {
      const t = TONES[v.tone] || TONES.info;
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="24" height="24" style="width:24px;height:24px;border-radius:12px;background-color:${t.bg};color:#ffffff;font-family:${FONT};font-size:13px;line-height:24px;font-weight:700;">${t.glyph}</td></tr></table>`;
    }
    return i === 1
      ? `<span class="t1" style="font-weight:600;color:#1f2328;">${esc(v)}</span>`
      : esc(v);
  };
  const tableHtml = table ? `
      <tr><td class="rule pad" style="border-top:1px solid #d1d9e0;padding:28px 32px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>${table.headers.map((h, i) => `<td class="t1" valign="bottom" style="padding:0 12px 18px ${i ? '12px' : '0'};font-family:${FONT};font-size:14px;font-weight:600;color:#1f2328;${i === 0 ? 'width:64px;' : ''}">${esc(h)}</td>`).join('')}</tr>
          ${table.rows.map((r) => `<tr>${r.map((v, i) => `<td class="t2" valign="top" style="padding:0 12px 0 ${i ? '12px' : '0'};font-family:${FONT};font-size:14px;line-height:1.5;color:#59636e;word-break:break-word;">${cell(v, i)}</td>`).join('')}</tr>`).join('')}
        </table>
      </td></tr>` : '';
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title><style>${css}</style></head>
<body class="bg" style="margin:0;padding:0;background-color:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader || heading)}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background-color:#ffffff;"><tr><td align="center" class="pad" style="padding:32px 16px 48px;">
  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">
    <tr><td style="padding:0 0 24px;"><img src="${esc(LOGO_URL)}" width="44" height="44" alt="Morline" style="display:block;border:0;border-radius:11px;"></td></tr>
    <tr><td class="t1" style="padding:0 0 24px;font-family:${FONT};font-size:28px;line-height:1.3;font-weight:500;letter-spacing:-0.3px;color:#1f2328;">${esc(title)}</td></tr>
    <tr><td class="card" style="border:1px solid #d1d9e0;border-radius:8px;background-color:#ffffff;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td class="pad" align="center" style="padding:36px 32px 36px;">
          <img src="${esc(ASSET(`email-icon-${icon}.png`))}" width="64" height="64" alt="" style="display:block;border:0;margin:0 auto 22px;">
          <div class="t1" style="font-family:${FONT};font-size:24px;line-height:1.3;font-weight:600;color:#1f2328;">${esc(heading)}</div>
          ${subtext ? `<div class="t2" style="margin:12px auto 0;max-width:420px;font-family:${FONT};font-size:14px;line-height:1.6;color:#59636e;">${esc(subtext)}</div>` : ''}
          ${cta ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto 0;"><tr><td class="btn" align="center" style="background-color:${BLUE};border-radius:8px;">
            <a href="${esc(cta.url)}" style="display:inline-block;padding:14px 32px;font-family:${FONT};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">${esc(cta.label)}</a></td></tr></table>` : ''}
          ${note ? `<div class="t2" style="margin:24px auto 0;max-width:420px;font-family:${FONT};font-size:13px;line-height:1.6;color:#59636e;">${esc(note)}</div>` : ''}
        </td></tr>${tableHtml}
      </table>
    </td></tr>
    <tr><td align="center" style="padding:36px 16px 0;font-family:${FONT};font-size:12px;line-height:1.7;color:#59636e;text-align:center;">
      <div class="t2" style="color:#59636e;">&mdash;</div>
      <div class="t2" style="color:#59636e;">${esc(footer || 'You are receiving this because of activity on your Morline account.')}</div>
      <div><a class="link" href="${esc(FRONTEND_URL)}/account" style="color:${BLUE};text-decoration:none;">Manage your Morline notifications</a></div>
      <div class="t2" style="margin-top:14px;color:#59636e;">Morline &middot; morline.space</div>
    </td></tr>
  </table>
</td></tr></table></body></html>`;

  const text = [title, '', heading, subtext, cta && `${cta.label}: ${cta.url}`, note,
    ...(table ? ['', table.headers.join(' | '), ...table.rows.map((r) => r.map((v) => (v && typeof v === 'object' ? (v.text || v.tone) : v)).join(' | '))] : []),
    '', '--', footer || 'You are receiving this because of activity on your Morline account.',
    `Manage your Morline notifications: ${FRONTEND_URL}/account`].filter((l) => l !== undefined && l !== null && l !== false).join('\n');
  return { html, text };
}

// ─── Welcome email ─────────────────────────────────────────────────────────────
export async function sendWelcomeEmail({ to, name }) {
  const mail = layout({
    title: `Welcome to Morline${name ? `, ${name}` : ''}`,
    preheader: 'Your account is ready.',
    icon: 'success',
    heading: 'Your account is ready',
    subtext: 'Deploy your first project from a GitHub repo, a Docker image or a starter template, or ask the assistant to build one for you.',
    cta: { label: 'Open Morline', url: `${FRONTEND_URL}/projects` },
    footer: 'You are receiving this because you signed up at morline.space.'
  });
  return send({ to, subject: 'Welcome to Morline', ...mail });
}

// ─── Forgot password email ─────────────────────────────────────────────────────
export async function sendPasswordResetEmail({ to, name, resetToken }) {
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
  const mail = layout({
    title: 'Reset your Morline password',
    preheader: 'Use this link within the hour to choose a new password.',
    icon: 'lock',
    heading: `Hi${name ? ` ${name}` : ''}, choose a new password`,
    subtext: 'This link expires in 1 hour.',
    cta: { label: 'Reset password', url: resetUrl },
    note: "If you didn't ask for this, ignore this email. Your password won't change.",
    footer: 'You are receiving this because a password reset was requested for your account.'
  });
  return send({ to, subject: 'Reset your Morline password', ...mail });
}

// ─── Team invite email ─────────────────────────────────────────────────────────
export async function sendTeamInviteEmail({ to, inviterName, teamName, role, token }) {
  const acceptUrl = `${FRONTEND_URL}/invite?token=${token}`;
  const mail = layout({
    title: `[${teamName}] Workspace invitation`,
    preheader: `${inviterName} invited you to ${teamName}.`,
    icon: 'mail',
    heading: `${inviterName} invited you to join ${teamName}`,
    subtext: `You were invited as ${role}.`,
    cta: { label: 'Accept invite', url: acceptUrl },
    note: "This invite expires in 7 days. If you don't have a Morline account yet, one is created when you accept.",
    footer: 'You are receiving this because someone invited you to a Morline workspace.'
  });
  return send({ to, subject: `${inviterName} invited you to ${teamName} on Morline`, ...mail });
}

// ─── Notification emails (deploy failed, crashed, domain, spend limit) ────────
const NOTICE = {
  deploy_failed: { tone: 'bad', heading: 'Deployment failed', cta: 'View deployment', headers: ['Status', 'Service', 'Reason'], note: 'Open the project and ask the assistant to fix it. It reads the build logs and proposes a change.' },
  service_crashed: { tone: 'bad', heading: 'Service crashed', cta: 'View service', headers: ['Status', 'Service', 'Details'], note: 'Open the project and ask the assistant to look at the logs.' },
  domain_failed: { tone: 'bad', heading: 'Domain could not be verified', cta: 'View domain', headers: ['Status', 'Domain', 'Details'] },
  spend_limit: { tone: 'warn', heading: 'Spend limit', cta: 'Review usage', headers: ['Status', 'Project', 'Usage'] },
  invite: { tone: 'info', heading: 'Invitation', cta: 'Open Morline' }
};

export async function sendNotificationEmail({ to, type, title, body, url, projectName, item }) {
  const n = NOTICE[type] || { tone: 'info', heading: title, cta: 'Open in Morline' };
  const tone = TONES[n.tone] || TONES.info;
  // Short on purpose: what happened, to what, and a button. The details (and the error) are in Morline.
  const mail = layout({
    title: projectName ? `[${projectName}] ${title}` : title,
    preheader: title,
    icon: tone.icon,
    heading: n.heading,
    subtext: item || (n.headers ? undefined : body),
    cta: url ? { label: n.cta, url } : undefined,
    footer: 'You are receiving this because email notifications are on.'
  });
  return send({ to, subject: title, ...mail });
}
