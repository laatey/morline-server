import { Resend } from 'resend';
import { RESEND_API_KEY, PUBLIC_URL, FRONTEND_URL } from '../config.js';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const FROM = 'Morline <noreply@morline.space>';

/**
 * Send an email via Resend. Silently logs and returns false if Resend is not configured.
 */
async function send({ to, subject, html }) {
  if (!resend) {
    console.warn(`[Email] Resend not configured — skipping email to ${to}: "${subject}"`);
    return false;
  }
  try {
    const { error } = await resend.emails.send({ from: FROM, to, subject, html });
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

// ─── Shared styles ────────────────────────────────────────────────────────────
const baseStyle = `
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; color: #f5f5f5; font-family: system-ui, -apple-system, sans-serif; padding: 40px 20px; }
    .card { max-width: 480px; margin: 0 auto; width: 100%; }
    .logo { font-size: 17px; font-weight: 700; letter-spacing: -0.5px; color: #f5f5f5; margin-bottom: 28px; }
    h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; margin-bottom: 10px; }
    p { font-size: 14px; color: #a3a3a3; line-height: 1.6; margin-bottom: 16px; }
    a.btn {
      display: inline-block;
      background: #f5f5f5;
      color: #0a0a0a;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      padding: 10px 20px;
      border-radius: 7px;
      margin-top: 4px;
      margin-bottom: 20px;
    }
    .divider { border: none; border-top: 1px solid #262626; margin: 24px 0; }
    .footer { font-size: 11px; color: #525252; margin-top: 0; }
    .url { word-break: break-all; font-size: 12px; color: #737373; margin-top: -10px; }
  </style>
`;

// ─── Welcome email ─────────────────────────────────────────────────────────────
export async function sendWelcomeEmail({ to, name }) {
  return send({
    to,
    subject: 'Welcome to Morline',
    html: `<!DOCTYPE html><html><head><meta charset="utf-8">${baseStyle}</head><body>
      <div class="card">
        <div class="logo">Morline</div>
        <h1>Welcome, ${name}</h1>
        <p>Your account is ready. Deploy your first project directly from a GitHub repo, a Docker image, or a starter template.</p>
        <a class="btn" href="${FRONTEND_URL}/projects">Open Morline</a>
        <hr class="divider">
        <p class="footer">You're receiving this because you signed up at morline.space.</p>
      </div>
    </body></html>`
  });
}

// ─── Forgot password email ─────────────────────────────────────────────────────
export async function sendPasswordResetEmail({ to, name, resetToken }) {
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
  return send({
    to,
    subject: 'Reset your Morline password',
    html: `<!DOCTYPE html><html><head><meta charset="utf-8">${baseStyle}</head><body>
      <div class="card">
        <div class="logo">Morline</div>
        <h1>Reset your password</h1>
        <p>Hi${name ? ` ${name}` : ''},</p>
        <p>Click the button below to set a new password. This link expires in 1 hour.</p>
        <a class="btn" href="${resetUrl}">Reset password</a>
        <p class="url">${resetUrl}</p>
        <hr class="divider">
        <p class="footer">If you didn't request this, you can safely ignore it. Your password won't change.</p>
      </div>
    </body></html>`
  });
}

// ─── Team invite email ─────────────────────────────────────────────────────────
export async function sendTeamInviteEmail({ to, inviterName, teamName, role, token }) {
  const acceptUrl = `${FRONTEND_URL}/invite?token=${token}`;
  return send({
    to,
    subject: `${inviterName} invited you to ${teamName} on Morline`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8">${baseStyle}</head><body>
      <div class="card">
        <div class="logo">Morline</div>
        <h1>You're invited</h1>
        <p><strong style="color:#f5f5f5">${inviterName}</strong> invited you to join <strong style="color:#f5f5f5">${teamName}</strong> as a <strong style="color:#f5f5f5">${role}</strong>.</p>
        <a class="btn" href="${acceptUrl}">Accept invite</a>
        <p class="url">${acceptUrl}</p>
        <hr class="divider">
        <p class="footer">This invite expires in 7 days. If you don't have a Morline account, one will be created when you accept.</p>
      </div>
    </body></html>`
  });
}

// ─── Generic notification email ────────────────────────────
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function sendNotificationEmail({ to, name, title, body, url }) {
  return send({
    to,
    subject: title,
    html: `<!doctype html><html><head>${baseStyle}</head><body><div class="card"><div class="logo">Morline</div>
      <h1>${esc(title)}</h1><p>Hi ${esc(name || 'there')},</p><p>${esc(body)}</p>
      ${url ? `<a class="btn" href="${esc(url)}">Open in Morline</a>` : ''}
      <hr class="divider"><p class="footer">You get these emails because email notifications are on. Turn them off in your settings.</p></div></body></html>`
  });
}
