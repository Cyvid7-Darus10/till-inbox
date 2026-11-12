import type { InboundEmail } from '../email/provider';
import { cleanField, normalizeForMatch } from './clean';
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

export const looksLikeInstructions = (text: string): boolean => INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));

/** Every number written in a piece of text: "1,520.00" is 1520, "950" is 950. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, '')));
}

/** Whether the email states this currency: its code as a word, or a symbol that means only it. */
export function currencyStated(currency: string, text: string): boolean {
  if (new RegExp(`\\b${currency}\\b`, 'i').test(text)) return true;
  return Object.entries(SYMBOLS).some(([symbol, code]) => code === currency && text.includes(symbol));
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
  const quote = amountQuote ? normalizeForMatch(amountQuote) : '';
  const quoted = quote.length > 0 && normalizeForMatch(emailText).includes(quote);
  const inQuote = numbersIn(quote).some((number) => Math.abs(number - amount) < AMOUNT_TOLERANCE);
  if (!quoted || !inQuote) return { amount: null, currency: null, warnings: [WARNINGS.amountNotInEmail] };
  if (!currency || !currencyStated(currency, emailText)) return { amount: null, currency: null, warnings: [WARNINGS.currencyNotStated] };
  if (amount > settings.maxAmount) return { amount: null, currency: null, warnings: [WARNINGS.amountOverLimit] };
  return { amount: Math.round(amount * 100) / 100, currency, warnings: [] };
}

const senderVerified = (email: InboundEmail): boolean =>
  email.auth.dmarc === 'pass' || (email.auth.spf === 'pass' && email.auth.dkim === 'pass');

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
