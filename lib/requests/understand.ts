import type { InboundEmail } from '../email/provider';
import { cleanField, normalizeForMatch, normalizeText } from './clean';
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

const AMOUNT_TOLERANCE = 0.005;

/** ISO 4217 codes the runtime knows. A three-letter word counts as a currency only if it is one. */
const ISO_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

// A number, with a sign only when the minus stands apart ("AUD -950", not the "-11" in "2026-11").
const NUMBER = /(?:(?<!\w)([-−])\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
const DIGIT_BEFORE = /\d[.,]?$/;
const DIGIT_AFTER = /^[.,]?\d/;

export const looksLikeInstructions = (text: string): boolean => INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));

/** Every number written in a piece of text: "1,520.00" is 1520, "950" is 950, "-950" is -950. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(NUMBER)].map((match) => (match[1] ? -1 : 1) * Number(match[2].replace(/,/g, '')));
}

/**
 * Every currency a piece of text names: an ISO code written in capitals ("AUD", not the word "all"),
 * or a symbol that means only one currency. A symbol counts only when no letter comes right before
 * it, so "US$" does not read as "S$".
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

/**
 * Whether the quote appears in the text without cutting a number short: "AUD 950" is not a quote of
 * "AUD 950.75", "AUD 9500" or "AUD 1,950". Both are already normalized.
 */
function quotedWhole(quote: string, text: string): boolean {
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const before = text.slice(Math.max(0, at - 2), at);
    const after = text.slice(at + quote.length, at + quote.length + 2);
    const cutsStart = /^\d/.test(quote) && DIGIT_BEFORE.test(before);
    const cutsEnd = /\d$/.test(quote) && DIGIT_AFTER.test(after);
    if (!cutsStart && !cutsEnd) return true;
  }
  return false;
}

/**
 * The currency of the total: the one the quote names, or, if the quote names none, the only one the
 * whole email names. Null when that is not exactly one currency.
 */
function currencyOfTotal(quote: string, emailText: string): string | null {
  const inQuote = currenciesIn(quote);
  const named = inQuote.length > 0 ? inQuote : currenciesIn(emailText);
  return named.length === 1 ? named[0] : null;
}

interface CheckedAmount {
  amount: number | null;
  currency: string | null;
  warnings: Warning[];
}

/** Keeps the amount only if the email backs it up. */
export function checkAmount(extraction: Extraction, emailText: string, settings: UnderstandSettings): CheckedAmount {
  const { amount, currency, amountQuote } = extraction;
  if (amount === null) return { amount: null, currency: null, warnings: [WARNINGS.amountNotStated] };
  // Matching is case-insensitive; the currency check below reads the quote as written.
  const quote = amountQuote ? normalizeForMatch(amountQuote) : '';
  const quoted = quote.length > 0 && quotedWhole(quote, normalizeForMatch(emailText));
  const inQuote = numbersIn(quote).some((number) => Math.abs(number - amount) < AMOUNT_TOLERANCE);
  const rounded = Math.round(amount * 100) / 100;
  if (!quoted || !inQuote || rounded <= 0) return { amount: null, currency: null, warnings: [WARNINGS.amountNotInEmail] };
  const stated = currencyOfTotal(normalizeText(amountQuote ?? ''), normalizeText(emailText));
  if (!currency || stated !== currency) return { amount: null, currency: null, warnings: [WARNINGS.currencyNotStated] };
  if (amount > settings.maxAmount) return { amount: null, currency: null, warnings: [WARNINGS.amountOverLimit] };
  return { amount: rounded, currency, warnings: [] };
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
