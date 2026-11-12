import { MAX_EMAIL_TEXT_CHARS } from '../email/guard';
import { normalizeText } from './clean';

/**
 * Decides whether an email states its amount plainly enough for a one-click Approve. The model's
 * quote is only a pointer. The rule, and the only rule:
 *
 *   One-click only when the email contains exactly one number that could be an amount, that number
 *   is a well-formed amount with a currency, nothing next to it makes it a rate, an estimate or a
 *   stale or negated figure, and it is what the model read. Otherwise a person types the amount.
 *
 * Details, all failing closed:
 * - Text over MAX_AMOUNT_TEXT_CHARS, or any digit that is not ASCII 0-9, means no clear amount.
 * - The text is normalized once (NFKC, invisible characters removed, every dash to "-", every space
 *   or line break to one space).
 * - Every run of digits counts as a number, with or without a currency. The only numbers left out
 *   are ones that are plainly not amounts, recognised strictly where they stand: an ISO or d/m/y
 *   date, a day with a capitalised month name, a time, and an international phone number.
 * - The amount must match one strict grammar: an optional ISO code in capitals or a symbol from a
 *   fixed list, a plain number (thousands commas in the right places, at most two decimals), an
 *   optional trailing code, standing apart from letters, digits and joining marks.
 * - Remaining edge cases are not chased: anything unclear is typed by a person.
 */

/** Longest email text read for an amount: the same limit the model gets. */
export const MAX_AMOUNT_TEXT_CHARS = MAX_EMAIL_TEXT_CHARS;
/** Most amounts listed on the card as "Amounts mentioned". */
const MAX_MENTIONED = 10;
/** How many words before the amount are read for a cue. */
const CUE_WORDS_BEFORE = 4;
/** Longest word allowed next to the amount. Longer means no clear amount. */
const MAX_WORD_CHARS = 40;
/** How many characters after the amount are read for a cue. */
const CUE_CHARS_AFTER = 200;

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
// What may not touch an amount on either side.
const JOINED = "[\\p{L}\\p{N}_'’#+\\-/%$€£.,]";
const AMOUNT = new RegExp(
  `(?<!${JOINED})(?<!- )(?<!\\d )(?:(?<prefix>${CODE}|${SYMBOL}) ?)?(?<number>${NUMBER})(?: ?(?<suffix>${CODE}))?(?!${JOINED.replace('.,', '')})(?![.,]\\d)(?! -)(?! \\d)`,
  'gu',
);
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u;
/** Every run of digits, with the separators inside it: each one is a number until shown otherwise. */
const ANY_NUMBER = /\d+(?:[.,]\d+)*/g;

const MONTH = '(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
const EDGE_BEFORE = '(?<![\\p{L}\\p{N}.,\\-/:])';
const EDGE_AFTER = '(?![\\p{L}\\p{N}\\-/:]|[.,]\\d)';
/** Numbers that are plainly not amounts, recognised strictly where they stand. */
const NOT_AMOUNTS: readonly RegExp[] = [
  // 2026-11-20
  new RegExp(`${EDGE_BEFORE}\\d{4}-\\d{2}-\\d{2}${EDGE_AFTER}`, 'gu'),
  // 20/11/2026, 20/11/26
  new RegExp(`${EDGE_BEFORE}\\d{1,2}/\\d{1,2}/(?:\\d{4}|\\d{2})${EDGE_AFTER}`, 'gu'),
  // 20 Nov, 20th November 2026, 20 May 2026 ("May" only with a year: "50 may" is a sentence)
  new RegExp(`${EDGE_BEFORE}\\d{1,2}(?:st|nd|rd|th)? (?:${MONTH}(?: \\d{4})?|May \\d{4})${EDGE_AFTER}`, 'gu'),
  // Nov 20, November 20th, 2026
  new RegExp(`${EDGE_BEFORE}(?:${MONTH}|May) \\d{1,2}(?:st|nd|rd|th)?(?:, \\d{4})?${EDGE_AFTER}`, 'gu'),
  // 9:30, 14:05:00, 9:30 am
  new RegExp(`${EDGE_BEFORE}\\d{1,2}:\\d{2}(?::\\d{2})?(?: ?[ap]\\.?m\\.?)?${EDGE_AFTER}`, 'giu'),
  // 9am, 5 pm
  new RegExp(`${EDGE_BEFORE}\\d{1,2} ?[ap]m(?![\\p{L}\\p{N}])`, 'giu'),
  // +61 2 9999 0000
  /(?<![\p{L}\p{N}])\+\d{1,3}(?: \d{1,4}){2,5}(?![\p{L}\p{N}])/gu,
];

// Cues that make the one amount a rate, an estimate, or a stale or negated figure.
const CUE_BEFORE =
  /(?:^|[^\p{L}])(?:not|no longer|instead of|about|around|approx|approximately|roughly|up to|at least|maybe|perhaps|estimated|was|were|old|previous|previously|earlier|last|per|each|every)(?![\p{L}])/iu;
const CUE_AFTER =
  /^[^\p{L}\p{N}]*(?:each|per|a|an|every|ea|apiece|hourly|daily|weekly|monthly|yearly|annually|or so|or|was|were|last|previously)(?![\p{L}])/iu;

export type AmountReading =
  | { kind: 'clear'; value: number; currency: string }
  | { kind: 'unclear'; reason: 'not-found' | 'several-numbers' | 'no-currency' | 'not-plain' };

interface Span {
  start: number;
  end: number;
}

/** Step 2 of the rule: the one form every position below refers to. */
export function normalizeForAmounts(text: string): string {
  return normalizeText(text)
    .replace(/[\p{Pd}−]/gu, '-')
    .replace(/[\p{Z}\s]+/gu, ' ')
    .trim();
}

const spansOf = (text: string, pattern: RegExp): Span[] =>
  [...text.matchAll(pattern)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));

const inside = (inner: Span, outer: Span): boolean => inner.start >= outer.start && inner.end <= outer.end;
const overlaps = (a: Span, b: Span): boolean => a.start < b.end && a.end > b.start;

/** Every number in the text that could be an amount: all of them, less the plainly-not-amounts. */
export function numbersIn(text: string): Span[] {
  const notAmounts = NOT_AMOUNTS.flatMap((pattern) => spansOf(text, pattern));
  return spansOf(text, ANY_NUMBER).filter((number) => !notAmounts.some((span) => inside(number, span)));
}

/** Every amount written as money (with a code or symbol), as written, for the card. */
export function moneyMentioned(emailText: string): string[] {
  if (emailText.length > MAX_AMOUNT_TEXT_CHARS || NON_ASCII_DIGIT.test(emailText)) return [];
  const text = normalizeForAmounts(emailText);
  const written = [...text.matchAll(AMOUNT)].filter((match) => match.groups?.prefix || match.groups?.suffix).map((match) => match[0]);
  return [...new Set(written)].slice(0, MAX_MENTIONED);
}

/** Every place the quote appears in the text, ignoring case. */
function placesOf(quote: string, text: string): Span[] {
  const lowerText = text.toLowerCase();
  const lowerQuote = quote.toLowerCase();
  // Lower-casing must not move positions; if it would, refuse rather than guess.
  if (!lowerQuote || lowerText.length !== text.length || lowerQuote.length !== quote.length) return [];
  const places: Span[] = [];
  for (let at = lowerText.indexOf(lowerQuote); at >= 0; at = lowerText.indexOf(lowerQuote, at + 1)) {
    places.push({ start: at, end: at + quote.length });
  }
  return places;
}

/** How many decimals a currency has: 0 for JPY or KRW, 2 for most. */
export const decimalsOf = (currency: string): number =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

const currencyOf = (written: string): string | null =>
  ISO_CODES.includes(written) ? written : (SYMBOLS.find(([symbol]) => symbol === written)?.[1] ?? null);

/** Reads the amount the quote points at, applying the rule above. */
export function readAmount(quote: string | null, emailText: string): AmountReading {
  const unclear = (reason: Extract<AmountReading, { kind: 'unclear' }>['reason']): AmountReading => ({ kind: 'unclear', reason });
  if (!quote || emailText.length > MAX_AMOUNT_TEXT_CHARS || NON_ASCII_DIGIT.test(emailText) || NON_ASCII_DIGIT.test(quote)) {
    return unclear('not-found');
  }
  const text = normalizeForAmounts(emailText);
  const numbers = numbersIn(text);
  if (numbers.length > 1) return unclear('several-numbers');
  const [number] = numbers;
  const places = placesOf(normalizeForAmounts(quote), text);
  if (!number || places.length === 0 || !places.every((place) => overlaps(place, number))) return unclear('not-found');
  const match = [...text.matchAll(AMOUNT)].find((candidate) =>
    overlaps({ start: candidate.index ?? 0, end: (candidate.index ?? 0) + candidate[0].length }, number),
  );
  const { prefix, number: written, suffix } = match?.groups ?? {};
  if (!match || !written || (prefix && suffix)) return unclear('not-found');
  const currency = prefix ? currencyOf(prefix) : suffix ? currencyOf(suffix) : null;
  if (!currency) return unclear('no-currency');
  const start = match.index ?? 0;
  const before = text
    .slice(0, start)
    .split(' ')
    .slice(-CUE_WORDS_BEFORE - 1)
    .join(' ');
  const after = text.slice(start + match[0].length, start + match[0].length + CUE_CHARS_AFTER);
  const nearWords = [...before.split(' '), ...after.split(' ').slice(0, CUE_WORDS_BEFORE + 1)];
  if (CUE_BEFORE.test(before) || CUE_AFTER.test(after) || nearWords.some((word) => word.length > MAX_WORD_CHARS))
    return unclear('not-plain');
  return { kind: 'clear', value: Number(written.replace(/,/g, '')), currency };
}
