import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailTemplate =
  | 'verify_email'
  | 'reset_password'
  | 'market_resolved'
  | 'winnings_available'
  | 'dispute_filed'
  | 'dispute_resolved';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = process.env.APP_NAME ?? 'BoxMeOut';
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3001';
const FROM_ADDRESS = process.env.SMTP_FROM ?? 'no-reply@boxmeout.app';

const TEMPLATES_DIR = path.resolve(__dirname, '../email/templates');

const SUBJECTS: Record<EmailTemplate, string> = {
  verify_email: `Verify your ${APP_NAME} email address`,
  reset_password: `Reset your ${APP_NAME} password`,
  market_resolved: `[${APP_NAME}] Market resolved`,
  winnings_available: `[${APP_NAME}] Your winnings are available`,
  dispute_filed: `[${APP_NAME}] Dispute filed`,
  dispute_resolved: `[${APP_NAME}] Dispute resolved`,
};

// ---------------------------------------------------------------------------
// Transporter — branches on EMAIL_PROVIDER env var (smtp | sendgrid)
// ---------------------------------------------------------------------------

function createTransporter(): nodemailer.Transporter {
  const provider = process.env.EMAIL_PROVIDER ?? 'smtp';

  if (provider === 'sendgrid') {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      logger.warn('SENDGRID_API_KEY not set; falling back to stub transport');
      return nodemailer.createTransport({ jsonTransport: true });
    }
    return nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: apiKey },
    });
  }

  // Default: SMTP
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT ?? '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }

  logger.warn('SMTP env vars not set; using stub transport (emails will not be delivered)');
  return nodemailer.createTransport({ jsonTransport: true });
}

const transporter = createTransporter();

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

function renderTemplate(template: EmailTemplate, data: Record<string, string>): string {
  const filePath = path.join(TEMPLATES_DIR, `${template}.html`);
  let html = fs.readFileSync(filePath, 'utf-8');
  for (const [key, value] of Object.entries(data)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return html;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generic transactional email sender.
 * Loads the matching HTML template, interpolates {{key}} placeholders,
 * and dispatches via the configured transport.
 * Errors are logged but never thrown — callers are not affected by delivery failures.
 */
export async function sendEmail(
  to: string,
  template: EmailTemplate,
  data: Record<string, string>,
): Promise<void> {
  const mergedData = { appName: APP_NAME, ...data };
  try {
    const html = renderTemplate(template, mergedData);
    const info = await transporter.sendMail({
      from: `"${APP_NAME}" <${FROM_ADDRESS}>`,
      to,
      subject: SUBJECTS[template],
      html,
    });
    if (process.env.NODE_ENV !== 'production') {
      logger.info({ msg: `Email sent (dev)`, template, messageId: info.messageId });
    }
  } catch (err) {
    logger.error({ msg: 'Failed to send email', template, to, error: err });
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers (preserve existing call sites)
// ---------------------------------------------------------------------------

export async function sendPasswordResetEmail(
  toEmail: string,
  resetToken: string,
): Promise<void> {
  const resetUrl = `${APP_BASE_URL}/auth/reset-password?token=${resetToken}`;
  await sendEmail(toEmail, 'reset_password', { resetUrl });
}

export async function sendDisputeResolved(
  toEmail: string,
  disputeId: string,
  marketId: string,
  resolution: string,
): Promise<void> {
  await sendEmail(toEmail, 'dispute_resolved', {
    disputeId,
    marketTitle: `Market ${marketId}`,
    resolution,
  });
}

export async function sendExportReadyEmail(
  toEmail: string,
  exportType: string,
  csvContent: string,
): Promise<void> {
  const filename = `${exportType}-export-${new Date().toISOString().slice(0, 10)}.csv`;
  try {
    await transporter.sendMail({
      from: `"${APP_NAME}" <${FROM_ADDRESS}>`,
      to: toEmail,
      subject: `[${APP_NAME}] Your ${exportType} export is ready`,
      text: `Your requested ${exportType} export is attached as ${filename}.`,
      attachments: [{ filename, content: csvContent, contentType: 'text/csv' }],
    });
  } catch (err) {
    logger.error({ msg: 'Failed to send export ready email', error: err });
  }
}
