const fs = require('fs');
const path = require('path');
const { transporter, transporterType, MAIL_FROM } = require('../config/email');

const PREVIEW_DIR = path.resolve(__dirname, '../preview-emails');

function formatMoney(cents, currency = 'usd') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function layout(title, bodyHtml) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <div style="border-bottom: 1px solid #e2e8f0; padding: 16px 24px; font-weight: 600; font-size: 18px;">TeamNest</div>
      <div style="padding: 24px;">
        <h1 style="font-size: 20px; margin: 0 0 12px;">${title}</h1>
        ${bodyHtml}
      </div>
      <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; font-size: 12px; color: #64748b;">
        You are receiving this email because of activity on your TeamNest account.
      </div>
    </div>
  `;
}

async function deliver({ to, subject, html, text }) {
  let info;
  try {
    info = await transporter.sendMail({ from: MAIL_FROM, to, subject, html, text });
  } catch (err) {
    console.error(`[email] failed to send "${subject}" to ${to}: ${err.message}`);
    throw err;
  }

  if (transporterType === 'preview') {
    const message = typeof info.message === 'string' ? JSON.parse(info.message) : info.message;
    const file = path.join(
      PREVIEW_DIR,
      `mail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    );
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(message, null, 2));
    console.log(`[email][preview] "${subject}" -> ${to} (saved ${path.basename(file)})`);
    return { preview: true, file };
  }

  return { preview: false, messageId: info.messageId };
}

async function sendInvitationEmail({ to, orgName, inviteUrl, expiresAt }) {
  return deliver({
    to,
    subject: `You're invited to join ${orgName} on TeamNest`,
    html: layout(
      'You have been invited',
      `
      <p>${orgName} has invited you to join their workspace on TeamNest.</p>
      <p style="margin: 20px 0;">
        <a href="${inviteUrl}" style="background:#4f46e5;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Accept invitation</a>
      </p>
      <p>Or copy this link into your browser:</p>
      <p style="word-break: break-all; background:#f8fafc; padding:12px; border-radius:6px; font-size:12px;">${inviteUrl}</p>
      <p>This invitation expires on ${expiresAt.toLocaleDateString()}.</p>
      `
    ),
    text: `You have been invited to join ${orgName} on TeamNest.\n\nOpen this link to accept: ${inviteUrl}\n\nThis invitation expires on ${expiresAt.toLocaleDateString()}.`,
  });
}

async function sendActivationEmail({ to, orgName, planName }) {
  return deliver({
    to,
    subject: `Welcome to TeamNest — ${orgName} is active`,
    html: layout(
      'Your organization is active',
      `
      <p>Great news — <strong>${orgName}</strong> is now live on TeamNest${
        planName ? ` with the <strong>${planName}</strong> plan` : ''
      }.</p>
      <p>You can now manage members, adjust your subscription, and review transactions from the organization dashboard.</p>
      `
    ),
    text: `Welcome to TeamNest. ${orgName}${planName ? ` (${planName})` : ''} is now active.`,
  });
}

async function sendPaymentReceipt({
  to,
  orgName,
  planName,
  amountCents,
  currency,
  invoiceNumber,
  invoiceUrl,
  periodStart,
  periodEnd,
}) {
  return deliver({
    to,
    subject: `Your ${orgName} receipt — ${invoiceNumber}`,
    html: layout(
      'Payment receipt',
      `
      <table style="width:100%; border-collapse: collapse; font-size:14px;">
        <tbody>
          <tr><td style="padding:6px 0;color:#475569;">Organization</td><td style="padding:6px 0;text-align:right;font-weight:600;">${orgName}</td></tr>
          <tr><td style="padding:6px 0;color:#475569;">Plan</td><td style="padding:6px 0;text-align:right;">${planName || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#475569;">Invoice</td><td style="padding:6px 0;text-align:right;">${invoiceNumber}</td></tr>
          <tr><td style="padding:6px 0;color:#475569;">Period</td><td style="padding:6px 0;text-align:right;">${periodStart ? periodStart.toLocaleDateString() : ''}${periodStart && periodEnd ? ' → ' : ''}${periodEnd ? periodEnd.toLocaleDateString() : '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#475569;">Amount paid</td><td style="padding:6px 0;text-align:right;font-size:16px;font-weight:700;">${formatMoney(amountCents, currency)}</td></tr>
        </tbody>
      </table>
      ${invoiceUrl ? `<p style="margin-top:16px;"><a href="${invoiceUrl}">View invoice online</a></p>` : ''}
      `
    ),
    text: `Payment receipt ${invoiceNumber} for ${orgName}: ${formatMoney(amountCents, currency)}.${invoiceUrl ? ` View online: ${invoiceUrl}` : ''}`,
  });
}

module.exports = { sendInvitationEmail, sendActivationEmail, sendPaymentReceipt };