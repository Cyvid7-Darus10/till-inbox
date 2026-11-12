import { MAX_EMAIL_TEXT_CHARS } from '../email/guard';
import { normalizeText } from './clean';

/**
 * Decides whether an email states one amount clearly enough for a one-click Approve. The model's
 * quote is only a pointer to where the amount is; the amount and currency that reach a payment link
 * are read here, by code, from the email. The rule is an allowlist: an amount is clear only when the
 * email gives a positive reason to believe it is the single amount to charge. Anything else is "no
 * clear amount", and an admin types it in. Pure.
 *
 * 1. Limits fail closed: text over MAX_AMOUNT_TEXT_CHARS, more than MAX_AMOUNT_TOKENS numbers, or any
 *    digit that is not ASCII 0-9 means no clear amount.
 * 2. The text is normalized once (NFKC, invisible characters removed, every dash to "-", every space
 *    or line break to one space) and read with one strict grammar: an optional currency code or
 *    symbol, a plain number (thousands commas in the right places, at most two decimals), an optional
 *    trailing code, standing apart from letters, digits and joining marks.
 * 3. Every place the quote appears must touch exactly one token, all the same amount and currency.
 * 4. Every mention of money (a code or symbol next to a digit) must be a token the grammar read.
 *    The amount is clear only if no other number or part of another amount sits within
 *    ADJACENT_WORDS words of it on either side (punctuation ignored), it is not a rate ("each", "per", "a month"), and either
 *    a. it is the only distinct money amount in the email, or
 *    b. it is marked as the total ("total", "in total", "amount due", "comes to", "=" ...), every
 *       money amount is in its currency and none is larger, and every unit price in the email ("at AUD 38 a kilo") has a quantity
 *       before it, with the quantities times the prices adding up to it.
 */

/** Longest email text read for an amount: the same limit the model gets. */
export const MAX_AMOUNT_TEXT_CHARS = MAX_EMAIL_TEXT_CHARS;
/** Most numbers an email may contain before nothing in it counts as a clear amount. */
export const MAX_AMOUNT_TOKENS = 200;
/** How many words either side of the amount must hold no other number. */
export const ADJACENT_WORDS = 4;
/** Longest word allowed next to the amount. Longer means no clear amount. */
export const MAX_WORD_CHARS = 40;
/** How many words before "at" a unit price's quantity may be ("25 kg of the Lane House Blend at"). */
const QUANTITY_WORDS = 10;
/** How much of the text either side of the amount the total and rate cues are read from. */
const CUE_CHARS = 30;
const AMOUNT_TOLERANCE = 0.005;

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
// Any mention of money, read loosely: a code or symbol next to a digit, with a sign or space between.
// Each one must be a token the strict grammar read, or the email has an amount it could not read.
const LOOSE_MONEY = new RegExp(`(?:${CODE}|${SYMBOL})[ ]?-?[ ]?\\d|\\d[ ]?${CODE}(?![\\p{L}])`, 'gu');

// Cues read from a short window right next to the amount. Bounded input, no nested quantifiers.
const TOTAL_BEFORE =
  /(?:^|[^\p{L}])(?:total|in total|total due|total amount|amount due|amount to pay|to pay|comes to|all in|grand total)(?: is| of| will be)?[ :]*$|=[ ]*$/iu;
const TOTAL_AFTER = /^[ ,]*(?:in total|total|all in|all-in)(?![\p{L}])/iu;
const RATE_AFTER = /^[ ,]*(?:each|per|a|an|every|ea|apiece|hourly|daily|weekly|monthly|yearly|annually)(?![\p{L}])/iu;
const AT_BEFORE = /(?:^|[^\p{L}])(?:at|@)[ ]*$/iu;
const PLAIN_QUANTITY = /^\d{1,6}(?:\.\d{1,3})?$/;

export interface AmountToken {
  start: number;
  end: number;
  /** The amount, or null when the token is not clear (a currency on both sides). */
  value: number | null;
  /** The currency the token names, or null when it names none ("950", "$950"). */
  currency: string | null;
  /** True when the token is written as money: with a code or a symbol, "$" included. */
  money: boolean;
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
    money: prefix !== undefined || suffix !== undefined,
  };
}

/** Every token the strict grammar reads in already-normalized text. */
export const amountsIn = (text: string): AmountToken[] => [...text.matchAll(TOKEN)].map(readToken);

/** How many decimals a currency has: 0 for JPY or KRW, 2 for most. */
export const decimalsOf = (currency: string): number =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

interface Word {
  start: number;
  end: number;
  text: string;
}

const wordsIn = (text: string): Word[] =>
  [...text.matchAll(/[^ ]+/g)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, text: m[0] }));

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

/** The one token every place the quote appears points at, or null. */
function pointedAt(quote: string, text: string, tokens: readonly AmountToken[]): AmountToken | null {
  const places = placesOf(quote, text);
  let found: AmountToken | null = null;
  for (const place of places) {
    const touched = tokens.filter((token) => token.start < place.end && token.end > place.start);
    if (touched.length !== 1) return null;
    const [token] = touched;
    if (found && (token.value !== found.value || token.currency !== found.currency)) return null;
    found ??= token;
  }
  return found;
}

/** No other number or part of another amount, and no overlong word, within ADJACENT_WORDS words either side. */
function standsAlone(token: AmountToken, words: readonly Word[], tokens: readonly AmountToken[]): boolean {
  const first = words.findIndex((word) => word.end > token.start);
  const last = words.findLastIndex((word) => word.start < token.end);
  const near = [...words.slice(Math.max(0, first - ADJACENT_WORDS), first), ...words.slice(last + 1, last + 1 + ADJACENT_WORDS)];
  const inAnotherToken = (word: Word) => tokens.some((other) => other !== token && other.start < word.end && other.end > word.start);
  return near.every((word) => !/[0-9]/.test(word.text) && !inAnotherToken(word) && word.text.length <= MAX_WORD_CHARS);
}

/** True when every loose mention of money is a money token the strict grammar read. */
const allMoneyRead = (text: string, money: readonly AmountToken[]): boolean =>
  [...text.matchAll(LOOSE_MONEY)].every((mention) => {
    const start = mention.index ?? 0;
    return money.some((token) => token.start < start + mention[0].length && token.end > start);
  });

const before = (text: string, token: AmountToken): string => text.slice(Math.max(0, token.start - CUE_CHARS), token.start);
const after = (text: string, token: AmountToken): string => text.slice(token.end, token.end + CUE_CHARS);

const markedAsTotal = (text: string, token: AmountToken): boolean =>
  TOTAL_BEFORE.test(before(text, token)) || TOTAL_AFTER.test(after(text, token));

/** The quantity before a unit price ("25" in "25 kg of the Lane House Blend at AUD 38 a kilo"), or null. */
function quantityFor(price: AmountToken, words: readonly Word[]): number | null {
  const first = words.findIndex((word) => word.end > price.start);
  for (const word of words.slice(Math.max(0, first - QUANTITY_WORDS), first).reverse()) {
    const bare = word.text.replace(/^[^0-9]+|[^0-9]+$/g, '');
    if (/[0-9]/.test(word.text)) return PLAIN_QUANTITY.test(bare) ? Number(bare) : null;
  }
  return null;
}

/** Rule 4b: a total, the largest amount, and consistent with every unit price in the email. */
function isTheTotal(text: string, total: AmountToken, money: readonly AmountToken[], words: readonly Word[]): boolean {
  const value = total.value ?? 0;
  if (!markedAsTotal(text, total)) return false;
  if (money.some((token) => token.currency !== total.currency || (token.value ?? 0) > value)) return false;
  const prices = money.filter((token) => token !== total && AT_BEFORE.test(before(text, token)) && RATE_AFTER.test(after(text, token)));
  if (prices.length === 0) return true;
  let sum = 0;
  for (const price of prices) {
    const quantity = quantityFor(price, words);
    if (quantity === null) return false;
    sum += quantity * (price.value ?? 0);
  }
  return Math.abs(sum - value) < AMOUNT_TOLERANCE;
}

/**
 * The amount the quote points at, if the email states it clearly enough for a one-click Approve.
 * A token without a currency is returned as is, so the caller can say the currency is unclear.
 */
export function amountAtQuote(quote: string | null, emailText: string): AmountToken | null {
  if (!quote || emailText.length > MAX_AMOUNT_TEXT_CHARS || NON_ASCII_DIGIT.test(emailText) || NON_ASCII_DIGIT.test(quote)) return null;
  const text = normalizeForAmounts(emailText);
  const wanted = normalizeForAmounts(quote);
  if (!wanted) return null;
  const tokens = amountsIn(text);
  if (tokens.length > MAX_AMOUNT_TOKENS || tokens.some((token) => token.value === null)) return null;
  const token = pointedAt(wanted, text, tokens);
  if (!token || token.currency === null) return token;
  const words = wordsIn(text);
  const money = tokens.filter((candidate) => candidate.money);
  if (!allMoneyRead(text, money) || !standsAlone(token, words, tokens) || RATE_AFTER.test(after(text, token))) return null;
  const distinct = new Set(money.map((candidate) => `${candidate.currency} ${candidate.value}`));
  if (distinct.size === 1) return token;
  return isTheTotal(text, token, money, words) ? token : null;
}
