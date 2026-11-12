/**
 * Text that came from an email or the model is cleaned before it reaches a card, a payment link or
 * a reply: no links (so an email can't plant a phishing URL in our reply), no angle brackets (so it
 * can't act as Slack markup), no control characters, one line, and a length cap.
 */

const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;
const BARE_DOMAIN = /\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|co|app|dev|xyz|link|info|biz|me|ly|ru|cn)\b\S*/gi;
const CONTROL = /\p{Cc}/gu;

export function cleanField(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(CONTROL, ' ')
    .replace(URL_LIKE, '')
    .replace(BARE_DOMAIN, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned || null;
}

/** Lowercase with whitespace collapsed, for comparing a quote with the email it came from. */
export const normalizeForMatch = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
