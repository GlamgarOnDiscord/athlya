/**
 * HTML and text layout of the transactional e-mails (issue #761).
 *
 * The message body comes from the `notifications.*` templates; this
 * module wraps it in the studio's identity:
 *
 *   - a header band in the studio's brand color, its text in the color
 *     `evaluateBrandContrast` pairs with it (the same AA pairing the
 *     studio console validates), with the light logo when it is an
 *     https URL. Most e-mail clients block `data:` images, so a logo
 *     stored inline falls back to the studio name;
 *   - a footer "Sent by {studio} via Athlya", or without the Athlya
 *     mention when the studio hid it.
 *
 * Without branding (recipient's studio not found) the e-mail keeps the
 * Athlya identity: ink band, white wordmark.
 *
 * E-mail clients ignore `<style>` blocks and CSP does not apply, so the
 * layout uses tables and inline styles. Every interpolated value is
 * HTML-escaped; the logo URL must be https and is attribute-escaped.
 */

import { t, type Locale } from '@athlya/shared/i18n';
import { evaluateBrandContrast } from '@athlya/shared/theming';

/** Branding of the recipient's studio, as the consumer receives it. */
export interface EmailBranding {
  readonly studioName: string;
  readonly brandColor: string;
  readonly logoUrl: string | null;
  readonly hideAthlyaBranding: boolean;
  /** Verified and activated sending domain, or `null` for Athlya's. */
  readonly emailDomain: string | null;
}

interface EmailContent {
  readonly subject: string;
  readonly body: string;
}

const INK = '#0A0A0A';
const WHITE = '#FFFFFF';
const MUTED = '#5C5C5C';
const HEX_RE = /^#[0-9A-Fa-f]{6}$/u;
const HTTPS_RE = /^https:\/\/[^\s"'<>]+$/u;

function escapeHtml(input: string): string {
  return input
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function headerColors(branding: EmailBranding | null): { background: string; text: string } {
  if (branding === null || !HEX_RE.test(branding.brandColor)) {
    return { background: INK, text: WHITE };
  }
  return {
    background: branding.brandColor.toUpperCase(),
    text: evaluateBrandContrast(branding.brandColor).onPrimary.toUpperCase(),
  };
}

/** Footer line of the e-mail. */
function emailFooter(branding: EmailBranding | null, locale: Locale): string {
  if (branding === null) return t('notifications.layout.footerAthlya', locale);
  if (branding.hideAthlyaBranding) {
    return t('notifications.layout.footer', locale, { studio: branding.studioName });
  }
  return t('notifications.layout.footerVia', locale, { studio: branding.studioName });
}

export function renderEmailHtml(
  content: EmailContent,
  branding: EmailBranding | null,
  locale: Locale,
): string {
  const colors = headerColors(branding);
  const name = escapeHtml(branding?.studioName ?? 'Athlya');
  const logo =
    branding?.logoUrl !== null && branding?.logoUrl !== undefined && HTTPS_RE.test(branding.logoUrl)
      ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${name}" height="40" style="display:block;height:40px;max-width:200px;border:0">`
      : `<span style="font-size:20px;font-weight:700;color:${colors.text}">${name}</span>`;
  const paragraphs = content.body
    .split(/\n{2,}/u)
    .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`)
    .join('');
  return [
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${escapeHtml(content.subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#F4F4F4">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F4">`,
    `<tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${WHITE};border-radius:8px;overflow:hidden">`,
    `<tr><td style="background:${colors.background};padding:20px 24px">${logo}</td></tr>`,
    `<tr><td style="padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:${INK}">`,
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${INK}">${escapeHtml(content.subject)}</h1>`,
    paragraphs,
    `</td></tr>`,
    `<tr><td style="padding:16px 24px;border-top:1px solid #E5E5E5;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${MUTED}">`,
    escapeHtml(emailFooter(branding, locale)),
    `</td></tr></table></td></tr></table></body></html>`,
  ].join('');
}

export function renderEmailText(
  content: EmailContent,
  branding: EmailBranding | null,
  locale: Locale,
): string {
  return `${content.body}\n\n--\n${emailFooter(branding, locale)}`;
}
