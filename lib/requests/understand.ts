import type { InboundEmail } from '../email/provider';
import { cleanField, normalizeText } from './clean';
import { type Extraction, MAX_NOTE_LENGTH, MAX_PURPOSE_LENGTH } from './extraction';

/**
 * Turns the model's reading of an email into a request a person can approve, and checks the model
 * instead of trusting it. The amount survives only if the email itself states it: the model must
 * quote the words, the quote must appear in the email, and the number must be in the quote.
 * Otherwise the amount is dropped and an admin is asked for it. Pure.
 */

export const WARNINGS = {
  amountNotStated: 'amount-not-stated',
  amountNotInEmail: 'amount-not-in-email',
  currencyNotStated: 'currency-not-stated',
  amountOverLimit: 'amount-over-limit',
  instructionsInEmail: 'instructions-in-email',
  senderNotVerified: 'sender-not-verified',
  emailClipped: 'email-clipped',
  lowConfidence: 'low-confidence',
} as const;

export type Warning = (typeof WARNINGS)[keyof typeof WARNINGS];

export interface Customer {
  name: string | null;
  company: string | null;
  /** From the provider's verified webhook data, never from the model. */
  email: string;
}

export type Understood =
  | {
      kind: 'payment';
      customer: Customer;
      purpose: string;
      amount: number | null;
      currency: string | null;
      dueDate: string | null;
      confidence: Extraction['confidence'];
      note: string;
      warnings: Warning[];
    }
  | { kind: 'not-payment'; customer: Customer; note: string };

export interface UnderstandSettings {
  maxAmount: number;
}

// Phrases an honest customer has no reason to write. Flagged for the admin even if the model missed them.
const INSTRUCTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|messages|rules)/i,
  /\b(system|developer) (prompt|message|instructions?)\b/i,
  /\byou are (now )?(an?|the) (ai|assistant|agent|model|bot)\b/i,
  /\b(assistant|ai|agent|model|bot)[,:]? (please )?(set|change|use|send|approve|create|forward)\b/i,
  /\bnew instructions?\b/i,
  /\b(approve|create) (this|the) (payment|link|request) (automatically|without)\b/i,
];

/** Currency symbols that name exactly one currency. A bare "$" does not. */
const SYMBOLS: Record<string, string> = { A$: 'AUD', AU$: 'AUD', S$: 'SGD', US$: 'USD', HK$: 'HKD', NZ$: 'NZD', '€': 'EUR', '£': 'GBP' };

export const looksLikeInstructions = (text: string): boolean => INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));

const AMOUNT_TOLERANCE = 0.005;

/** ISO 4217 codes the runtime knows. A three-letter word counts as a currency only if it is one. */
const ISO_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

// One written number: ASCII digits joined by separators, dashes, or a space before another digit, so
// a date, a range or a phone number stays one piece ("2026-11-20", "950-1,200", "+61 2 9999 0950").
const NUMBER = /\d(?:[\d.,\-−–—]|\s(?=[\d\-−–—]))*\d|\d/g;
// The only shapes read as an amount: 950, 950.5, 950.75, 1,250 and 1,250.00.
const PLAIN_AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;
// A minus or dash just before a number (a credit or the end of a range), or a # (an id).
const NOT_AN_AMOUNT_BEFORE = /(?:[-−–—]\s?|#)$/;

export interface WrittenNumber {
  start: number;
  end: number;
  /** The amount it states, or null when it is not one clear positive amount. */
  value: number | null;
}

/** Every number written in a piece of text, where it sits, and the amount it clearly states, if any. */
export function numbersIn(text: string): WrittenNumber[] {
  return [...text.matchAll(NUMBER)].map((match) => {
    const start = match.index;
    const written = match[0];
    const clear = PLAIN_AMOUNT.test(written) && !NOT_AN_AMOUNT_BEFORE.test(text.slice(Math.max(0, start - 2), start));
    const value = clear ? Number(written.replace(/,/g, '')) : null;
    return { start, end: start + written.length, value: value !== null && value > 0 ? value : null };
  });
}

/**
 * Every currency a piece of text names: an ISO code written in capitals as a whole word ("AUD", not
 * the word "all"), or a symbol that means only one currency. A symbol counts only when no letter
 * comes right before it, so "US$" does not read as "S$".
 */
export function currenciesIn(text: string): string[] {
  const codes = [...text.matchAll(/(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])/g)].map((match) => match[0]).filter((code) => ISO_CODES.has(code));
  const escapeDollar = (symbol: string) => symbol.replace(/[$]/g, '\\$');
  const symbols = Object.entries(SYMBOLS)
    .filter(([symbol]) => new RegExp(`(?<![A-Za-z])${escapeDollar(symbol)}`).test(text))
    .map(([, code]) => code);
  return [...new Set([...codes, ...symbols])];
}

/** Whether the text states this currency. */
export const currencyStated = (currency: string, text: string): boolean => currenciesIn(text).includes(currency);

/** A currency code in any case ("aud"): named, but not clearly enough to act on. */
const hasLooseCode = (text: string): boolean =>
  [...text.matchAll(/(?<![A-Za-z])[A-Za-z]{3}(?![A-Za-z])/g)].some((match) => ISO_CODES.has(match[0].toUpperCase()));

/** One line, normalized, case kept: positions in it are what the checks below compare. */
const asOneLine = (text: string): string => normalizeText(text).replace(/\s+/g, ' ').trim();

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where the quote appears in the email, ignoring case. */
function placesOf(quote: string, text: string): { start: number; end: number }[] {
  const pattern = new RegExp(escapeRegExp(quote), 'gi');
  const places: { start: number; end: number }[] = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    places.push({ start: match.index, end: match.index + match[0].length });
    pattern.lastIndex = match.index + 1;
  }
  return places;
}

/**
 * The currency of the total, read from the email itself: the one written at the quote, or, if none
 * is written there, the only one the whole email names. Null when that is not exactly one currency.
 */
function currencyAt(place: string, emailText: string): string | null {
  const here = currenciesIn(place);
  if (here.length > 0) return here.length === 1 ? here[0] : null;
  if (hasLooseCode(place)) return null;
  const anywhere = currenciesIn(emailText);
  return anywhere.length === 1 ? anywhere[0] : null;
}

interface CheckedAmount {
  amount: number | null;
  currency: string | null;
  warnings: Warning[];
}

/**
 * Keeps the amount only if the email backs it up. The model's quote only says where to look: code
 * finds it in the email, reads every whole number it touches, and keeps the amount only if one of
 * them states it. The currency is read from the email at the same place.
 */
export function checkAmount(extraction: Extraction, emailText: string, settings: UnderstandSettings): CheckedAmount {
  const { amount, currency, amountQuote } = extraction;
  if (amount === null) return { amount: null, currency: null, warnings: [WARNINGS.amountNotStated] };
  const text = asOneLine(emailText);
  const quote = asOneLine(amountQuote ?? '');
  const numbers = numbersIn(text);
  const states = (place: { start: number; end: number }) => (number: WrittenNumber) =>
    number.start < place.end && number.end > place.start && number.value !== null && Math.abs(number.value - amount) < AMOUNT_TOLERANCE;
  const place = quote ? placesOf(quote, text).find((candidate) => numbers.some(states(candidate))) : undefined;
  const written = place ? numbers.find(states(place))?.value : null;
  if (!place || !written) return { amount: null, currency: null, warnings: [WARNINGS.amountNotInEmail] };
  if (!currency || currencyAt(text.slice(place.start, place.end), text) !== currency) {
    return { amount: null, currency: null, warnings: [WARNINGS.currencyNotStated] };
  }
  if (written > settings.maxAmount) return { amount: null, currency: null, warnings: [WARNINGS.amountOverLimit] };
  return { amount: written, currency, warnings: [] };
}

// Only DMARC proves the visible From address: SPF and DKIM can pass for another domain. Without a
// DMARC result the sender counts as unverified.
export const senderVerified = (email: Pick<InboundEmail, 'auth'>): boolean => email.auth.dmarc === 'pass';

export function understand(email: InboundEmail, extraction: Extraction, settings: UnderstandSettings): Understood {
  const customer: Customer = {
    name: cleanField(extraction.customerName, 120) ?? cleanField(email.from.name, 120),
    company: cleanField(extraction.company, 120),
    email: email.from.address,
  };
  const note = cleanField(extraction.note, MAX_NOTE_LENGTH) ?? '';
  const purpose = cleanField(extraction.purpose, MAX_PURPOSE_LENGTH);
  if (!extraction.isPaymentRequest || !purpose) return { kind: 'not-payment', customer, note };
  const injected = extraction.containsInstructions || looksLikeInstructions(`${email.subject}\n${email.text}`);
  // An email that tries to instruct the assistant never gets a one-click Approve: the injected text
  // may itself contain a plausible amount, so an admin must type the amount in by hand.
  const checked = injected ? { amount: null, currency: null, warnings: [] } : checkAmount(extraction, email.text, settings);
  const flags: Warning[] = [
    ...(injected ? [WARNINGS.instructionsInEmail] : []),
    ...(senderVerified(email) ? [] : [WARNINGS.senderNotVerified]),
    ...(email.clipped ? [WARNINGS.emailClipped] : []),
    ...(extraction.confidence === 'low' ? [WARNINGS.lowConfidence] : []),
  ];
  return {
    kind: 'payment',
    customer,
    purpose,
    amount: checked.amount,
    currency: checked.currency,
    dueDate: extraction.dueDate,
    confidence: extraction.confidence,
    note,
    warnings: [...checked.warnings, ...flags],
  };
}
