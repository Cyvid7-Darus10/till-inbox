/**
 * Text that came from an email or the model is cleaned before it reaches a card, a payment link or
 * a reply. The rules are general rather than a list of bad domains:
 *
 * 1. Normalize: NFKC (full-width letters become plain ones), drop zero-width and direction
 *    characters, and turn look-alike dots into a plain dot.
 * 2. Remove anything that looks like a link: a URL scheme, an email address, or a hostname
 *    (label.label with any top-level domain, punycode included, in any script).
 * 3. Keep only an allowlist: letters, combining marks, digits, spaces and . , ' ’ & ( ) / : # % + -
 *    So no angle brackets, Slack formatting characters, or control characters survive.
 * 4. One line, collapsed spaces, a length cap.
 */

// Zero-width spaces and joiners, word joiner, BOM, soft hyphen, and bidirectional controls.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Dots that read as "." : ideographic, full-width, half-width, one-dot leader, middle dots, and others.
const LOOKALIKE_DOTS = /[\u00B7\u0701\u0702\u06D4\u2024\u2027\u3002\u30FB\uFE52\uFF0E\uFF61]/g;
const SCHEME = /\b[a-z][a-z0-9+.-]{1,20}:(?=\S)\S*/gi;
const EMAIL = /\S+@\S+/g;
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?';
// label(.label)+ ending in a TLD of letters (any script) or a punycode TLD, plus any path after it.
const HOSTNAME = new RegExp(`(?<![\\p{L}\\p{N}])(?:${LABEL}\\.)+(?:\\p{L}{2,63}|xn--[a-z0-9-]{1,59})(?![\\p{L}\\p{N}-])\\S*`, 'giu');
const NOT_ALLOWED = /[^\p{L}\p{M}\p{N} .,'’&()/:#%+-]/gu;

/** Step 1 alone: the form every other check compares against. */
export function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(INVISIBLE, '').replace(LOOKALIKE_DOTS, '.');
}

/** Most input read by cleanField. Fields are short; the cap keeps the patterns below cheap on any input. */
const MAX_INPUT_CHARS = 1_000;

export function cleanField(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const cleaned = normalizeText(value.slice(0, MAX_INPUT_CHARS))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(SCHEME, ' ')
    .replace(EMAIL, ' ')
    .replace(HOSTNAME, ' ')
    .replace(NOT_ALLOWED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned || null;
}

const MESSAGE_ID = /^<[\x21-\x3B\x3D\x3F-\x7E]{1,100}@[\x21-\x3B\x3D\x3F-\x7E]{1,100}>$/;

/** A Message-ID safe to put in a reply's In-Reply-To header, or null. Printable ASCII only, no line breaks. */
export function cleanMessageId(value: string | null | undefined): string | null {
  return value && value.length <= 200 && MESSAGE_ID.test(value) ? value : null;
}

/** Lowercase with whitespace collapsed, for comparing a quote with the email it came from. */
export const normalizeForMatch = (value: string): string => normalizeText(value).replace(/\s+/g, ' ').trim().toLowerCase();
