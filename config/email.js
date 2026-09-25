const nodemailer = require('nodemailer');
const env = require('./env');

/**
 * SMTP transport when configured; otherwise a JSON "preview" transport that
 * captures every message (saved to preview-emails/ by emailService) so the
 * flows can be developed and tested without a real mail server.
 */
let transporter;
let transporterType;

if (env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
  });
  transporterType = 'smtp';
} else {
  transporter = nodemailer.createTransport({ jsonTransport: true });
  transporterType = 'preview';
}

module.exports = { transporter, transporterType, MAIL_FROM: env.MAIL_FROM };