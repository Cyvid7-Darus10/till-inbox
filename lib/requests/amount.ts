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
 *    every Unicode dash (\p{Pd} and U+2212) to "-", every run of spaces to one space, a run with
 *    one line break to one line break, and a run with more (a blank line) to two.
 * 3. An amount token is: an optional currency (an ISO 4217 code in capitals, or a symbol from a
 *    fixed list), at most one space, a number (ASCII digits, thousands commas in the right places,
 *    at most two decimals), then optionally one space and a currency code.
 * 4. A token must stand alone: no letter, digit, underscore, apostrophe, "#", "+", "-", "/", "%", "."
 *    or "," joined to either side, no "- " or digit-and-space just before it, and no "." or ","
 *    followed by a digit, " -" or space-and-digit just after it ("1 250" is one number in some places).
 * 5. A range or a choice is not clear. Around the amount, out to the sentence's end (". ", ";" or a
 *    blank line) on each side, the words are scanned: a connecting word ("to", "or", "and",
 *    "through", "till", "until", "-", "/", "&") between the amount and the nearest other number
 *    means not clear. So does a token with a currency on both sides.
 * 6. Every place the quote appears must touch exactly one clear token, and they must all be the same
 *    amount in the same currency. That token decides the amount and the currency. A bare "$" names
 *    no currency.
 *
 * The text is attacker-controlled, so all work is bounded, and every limit fails closed: text longer
 * than MAX_AMOUNT_TEXT_CHARS, more than MAX_AMOUNT_TOKENS numbers, a sentence that runs past
 * NEIGHBOURHOOD_CHARS on either side of the amount, or a word longer than MAX_WORD_CHARS near it,
 * all mean no clear amount. Nothing is ever treated as clear because a limit cut it short.
 */

/** Longest email text read for an amount: the same limit the model gets. */
export const MAX_AMOUNT_TEXT_CHARS = MAX_EMAIL_TEXT_CHARS;
/** Most numbers an email may contain before nothing in it counts as a clear amount. */
export const MAX_AMOUNT_TOKENS = 200;
/** How far either side of an amount its sentence may run. Further means no clear amount. */
export const NEIGHBOURHOOD_CHARS = 300;
/** Longest word allowed near an amount. Longer means no clear amount. */
export const MAX_WORD_CHARS = 40;

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
const SPACE = '[ \\n]';
const TOKEN = new RegExp(
  `(?<!${JOINED})(?<!-${SPACE})(?<!\\d${SPACE})(?:(?<prefix>${CODE}|${SYMBOL})${SPACE}?)?(?<number>${NUMBER})(?:${SPACE}?(?<suffix>${CODE}))?(?!${JOINED.replace('.,', '')})(?![.,]\\d)(?!${SPACE}-)(?!${SPACE}\\d)`,
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
    .replace(/[\p{Z}\s]+/gu, (run) => {
      const breaks = run.match(/\r\n|[\n\r\u0085\u2028\u2029]/gu)?.length ?? 0;
      return breaks >= 2 ? '\n\n' : breaks === 1 ? '\n' : ' ';
    })
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

const CONNECTORS: ReadonlySet<string> = new Set(['to', 'or', 'and', 'through', 'thru', 'till', 'until', '-', '/', '&', '~']);
// A number glued to a connecting word, such as "to1,200".
const GLUED_CONNECTOR = /^(?:to|or|and|through|thru|till|until)[^\p{L}]/iu;

/**
 * Where a sentence breaks: ";", a blank line, or "." followed by a space, a line break or the end. A
 * single line break is not a break: plain-text email wraps lines in the middle of sentences.
 */
const breaksAt = (text: string, at: number): boolean =>
  text[at] === ';' ||
  (text[at] === '\n' && text[at + 1] === '\n') ||
  (text[at] === '.' && (at + 1 === text.length || text[at + 1] === ' ' || text[at + 1] === '\n'));

/** The text from the amount out to its sentence's end on one side, or null if that runs past the cap. */
function reach(text: string, from: number, step: 1 | -1): string | null {
  for (let distance = 0; distance <= NEIGHBOURHOOD_CHARS; distance += 1) {
    const at = step === 1 ? from + distance : from - 1 - distance;
    if (at < 0 || at >= text.length || breaksAt(text, at)) return step === 1 ? text.slice(from, at) : text.slice(at + 1, from);
  }
  return null;
}

const bare = (word: string): string => word.replace(/^[^\p{L}\p{N}\-/&~]+|[^\p{L}\p{N}\-/&~]+$/gu, '').toLowerCase();

/** Walks out from the amount: a connecting word before the nearest other number makes it a range or a choice. */
function joinedOnOneSide(wordsOutward: readonly string[]): boolean {
  let connector = false;
  for (const word of wordsOutward) {
    if (/[0-9]/.test(word)) return connector || GLUED_CONNECTOR.test(word);
    if (CONNECTORS.has(bare(word))) connector = true;
  }
  return false;
}

/** Whether a token is clear in its sentence. Every limit it hits makes it not clear. */
function clearInSentence(text: string, token: AmountToken): boolean {
  const before = reach(text, token.start, -1);
  const after = reach(text, token.end, 1);
  if (before === null || after === null) return false;
  const wordsBefore = before.split(/[ \n]+/).filter(Boolean);
  const wordsAfter = after.split(/[ \n]+/).filter(Boolean);
  if ([...wordsBefore, ...wordsAfter].some((word) => word.length > MAX_WORD_CHARS)) return false;
  return !joinedOnOneSide(wordsBefore.reverse()) && !joinedOnOneSide(wordsAfter);
}

/** Every amount token in already-normalized text, as the grammar reads it, before the sentence check. */
const tokensIn = (text: string): AmountToken[] => [...text.matchAll(TOKEN)].map(readToken);

const withSentenceCheck = (text: string, token: AmountToken): AmountToken =>
  token.value !== null && !clearInSentence(text, token) ? { ...token, value: null } : token;

/** Every amount token in already-normalized text, with ranges, choices and over-limit ones marked not clear. */
export function amountsIn(text: string): AmountToken[] {
  return tokensIn(text).map((token) => withSentenceCheck(text, token));
}

/** How many decimals a currency has: 0 for JPY or KRW, 2 for most. */
export const decimalsOf = (currency: string): number =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

/** Every place the quote appears in the text, ignoring case. */
function placesOf(quote: string, text: string): { start: number; end: number }[] {
  const lowerText = text.toLowerCase().replace(/\n/g, ' ');
  const lowerQuote = quote.toLowerCase().replace(/\n/g, ' ');
  // Lower-casing must not move positions; if it would, refuse rather than guess.
  if (lowerText.length !== text.length || lowerQuote.length !== quote.length) return [];
  const places: { start: number; end: number }[] = [];
  for (let at = lowerText.indexOf(lowerQuote); at >= 0; at = lowerText.indexOf(lowerQuote, at + 1)) {
    places.push({ start: at, end: at + quote.length });
  }
  return places;
}

/**
 * The one amount the quote points at in the email, or null. Every place the quote appears must touch
 * exactly one clear token, and all of them must be the same amount in the same currency.
 */
export function amountAtQuote(quote: string | null, emailText: string): AmountToken | null {
  if (!quote || emailText.length > MAX_AMOUNT_TEXT_CHARS || NON_ASCII_DIGIT.test(emailText) || NON_ASCII_DIGIT.test(quote)) return null;
  const text = normalizeForAmounts(emailText);
  const wanted = normalizeForAmounts(quote);
  if (!wanted) return null;
  const tokens = tokensIn(text);
  if (tokens.length > MAX_AMOUNT_TOKENS) return null;
  const places = placesOf(wanted, text);
  if (places.length === 0) return null;
  const found: AmountToken[] = [];
  for (const place of places) {
    const touched = tokens.filter((token) => token.start < place.end && token.end > place.start);
    if (touched.length !== 1) return null;
    const token = withSentenceCheck(text, touched[0]);
    if (token.value === null) return null;
    found.push(token);
  }
  const [first] = found;
  return found.every((token) => token.value === first.value && token.currency === first.currency) ? first : null;
}
