import { MAX_EMAIL_TEXT_CHARS } from '../email/guard';
import { normalizeText } from './clean';

/**
 * Reads an amount from an email with one strict grammar. The model's quote only says where to look;
 * the amount and currency that reach a payment link are read here, by code, from the email itself.
 * Anything this grammar does not read cleanly is "no clear amount", and an admin types it in. Pure.
 *
 * The rule:
 * 1. Any digit that is not ASCII 0-9 anywhere in the email (Arabic-Indic, full-width, ...) means no
 *    clear amount at all.
 * 2. Normalize once: NFKC, zero-width and direction characters removed, look-alike dots to ".",
 *    every Unicode dash (\p{Pd} and U+2212) to "-", every space or line break to one plain space.
 * 3. An amount token is: an optional currency (an ISO 4217 code in capitals, or a symbol from a
 *    fixed list), at most one space, a number (ASCII digits, thousands commas in the right places,
 *    at most two decimals), then optionally one space and a currency code.
 * 4. A token must stand alone: no letter, digit, underscore, apostrophe, "#", "+", "-", "/", "%", "."
 *    or "," joined to either side, no "- " or digit-and-space just before it, and no "." or ","
 *    followed by a digit, " -" or space-and-digit just after it ("1 250" is one number in some places).
 * 5. Two tokens joined as a range or as alternatives ("950 to 1,200", "AUD 950 or AUD 990") are not
 *    clear. Neither is a token with a currency on both sides.
 * 6. The quote must touch exactly one token in the email, and that token decides the amount and the
 *    currency. A bare "$" names no currency.
 *
 * The text is attacker-controlled, so the work is bounded: text longer than MAX_AMOUNT_TEXT_CHARS or
 * with more than MAX_AMOUNT_TOKENS numbers has no clear amount, and the range check looks only at a
 * short window on each side of a token, with bounded patterns.
 */

/** Longest email text read for an amount: the same limit the model gets. */
export const MAX_AMOUNT_TEXT_CHARS = MAX_EMAIL_TEXT_CHARS;
/** Most numbers an email may contain before nothing in it counts as a clear amount. */
export const MAX_AMOUNT_TOKENS = 200;
/** How far either side of a token the range check looks. */
const WINDOW_CHARS = 40;

/** Symbols that name exactly one currency. "$" alone names none. Longest first, so "US$" is not "S$". */
const SYMBOLS: [string, string | null][] = [
  ['AU$', 'AUD'],
  ['US$', 'USD'],
  ['HK$', 'HKD'],
  ['NZ$', 'NZD'],
  ['A$', 'AUD'],
  ['S$', 'SGD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['$', null],
];

/** ISO 4217 codes the runtime knows. */
const ISO_CODES: readonly string[] = Intl.supportedValuesOf('currency');

const escapeDollar = (text: string): string => text.replace(/[$]/g, '\\$');
const CODE = `(?:${ISO_CODES.join('|')})`;
const SYMBOL = SYMBOLS.map(([symbol]) => escapeDollar(symbol)).join('|');
const NUMBER = '(?:[1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d*|0)(?:\\.\\d{1,2})?';
// What may not touch a token on either side.
const JOINED = "[\\p{L}\\p{N}_'’#+\\-/%$€£.,]";
const TOKEN = new RegExp(
  `(?<!${JOINED})(?<!- )(?<!\\d )(?:(?<prefix>${CODE}|${SYMBOL}) ?)?(?<number>${NUMBER})(?: ?(?<suffix>${CODE}))?(?!${JOINED.replace('.,', '')})(?![.,]\\d)(?! -)(?! \\d)`,
  'gu',
);
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u;

export interface AmountToken {
  start: number;
  end: number;
  /** The amount, or null when this token is not clear (part of a range, two currencies, ...). */
  value: number | null;
  /** The currency the token names, or null when it names none ("950", "$950"). */
  currency: string | null;
}

/** Step 2 of the rule: the one form every position below refers to. */
export function normalizeForAmounts(text: string): string {
  return normalizeText(text)
    .replace(/[\p{Pd}−]/gu, '-')
    .replace(/[\p{Z}\s]+/gu, ' ')
    .trim();
}

const symbolCurrency = (symbol: string): string | null => SYMBOLS.find(([written]) => written === symbol)?.[1] ?? null;

function readToken(match: RegExpMatchArray): AmountToken {
  const { prefix, number, suffix } = match.groups ?? {};
  const prefixCurrency = prefix === undefined ? null : ISO_CODES.includes(prefix) ? prefix : symbolCurrency(prefix);
  const start = match.index ?? 0;
  return {
    start,
    end: start + match[0].length,
    value: prefix !== undefined && suffix !== undefined ? null : Number(number.replace(/,/g, '')),
    currency: prefixCurrency ?? suffix ?? null,
  };
}

// A connecting word next to another number, even one that is not a clean token: a range or a choice.
// Applied to a short window only, with bounded runs, so it cannot backtrack far.
const JOINED_AFTER = /^ (?:to|or|and) (?:[^ ]{1,20} )?[^ ]{0,20}\d/i;
const JOINED_BEFORE = /\d[^ ]{0,20}(?: [^ ]{1,20})? (?:to|or|and) $/i;

/** Every amount token in already-normalized text, with ranges and alternatives marked not clear. */
export function amountsIn(text: string): AmountToken[] {
  return [...text.matchAll(TOKEN)].map(readToken).map((token) => {
    const after = text.slice(token.end, token.end + WINDOW_CHARS);
    const before = text.slice(Math.max(0, token.start - WINDOW_CHARS), token.start);
    return JOINED_AFTER.test(after) || JOINED_BEFORE.test(before) ? { ...token, value: null } : token;
  });
}

/** How many decimals a currency has: 0 for JPY or KRW, 2 for most. */
export const decimalsOf = (currency: string): number =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

/** Every place the quote appears in the text, ignoring case. */
function placesOf(quote: string, text: string): { start: number; end: number }[] {
  const lowerText = text.toLowerCase();
  const lowerQuote = quote.toLowerCase();
  // Lower-casing must not move positions; if it would, refuse rather than guess.
  if (lowerText.length !== text.length || lowerQuote.length !== quote.length) return [];
  const places: { start: number; end: number }[] = [];
  for (let at = lowerText.indexOf(lowerQuote); at >= 0; at = lowerText.indexOf(lowerQuote, at + 1)) {
    places.push({ start: at, end: at + quote.length });
  }
  return places;
}

/** The one amount token the quote points at in the email, or null if there is not exactly one. */
export function amountAtQuote(quote: string | null, emailText: string): AmountToken | null {
  if (!quote || emailText.length > MAX_AMOUNT_TEXT_CHARS || NON_ASCII_DIGIT.test(emailText) || NON_ASCII_DIGIT.test(quote)) return null;
  const text = normalizeForAmounts(emailText);
  const wanted = normalizeForAmounts(quote);
  if (!wanted) return null;
  const tokens = amountsIn(text);
  if (tokens.length > MAX_AMOUNT_TOKENS) return null;
  for (const place of placesOf(wanted, text)) {
    const touched = tokens.filter((token) => token.start < place.end && token.end > place.start);
    if (touched.length === 1) return touched[0].value === null ? null : touched[0];
  }
  return null;
}
