import type { InboundEmail } from '../email/provider';
import { type AmountReading, decimalsOf, moneyMentioned, readAmount } from './amount';
import { cleanField } from './clean';
import { type Extraction, MAX_NOTE_LENGTH, MAX_PURPOSE_LENGTH } from './extraction';

/**
 * Turns the model's reading of an email into a request a person can approve, and checks the model
 * instead of trusting it. The model's quote only points at the amount; lib/requests/amount.ts decides
 * whether the email states it plainly enough for a one-click Approve. Otherwise the amount is dropped
 * and an admin types it. Pure.
 */

export const WARNINGS = {
  amountNotStated: 'amount-not-stated',
  amountNotInEmail: 'amount-not-in-email',
  currencyNotStated: 'currency-not-stated',
  amountOverLimit: 'amount-over-limit',
  severalNumbers: 'several-numbers',
  amountNotPlain: 'amount-not-plain',
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
      /** Amounts the email writes as money, for the card. Information only. */
      mentioned: string[];
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

export const looksLikeInstructions = (text: string): boolean => INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));

const AMOUNT_TOLERANCE = 0.005;

interface CheckedAmount {
  amount: number | null;
  currency: string | null;
  warnings: Warning[];
}

const unclear = (warning: Warning): CheckedAmount => ({ amount: null, currency: null, warnings: [warning] });

const UNCLEAR_WARNING: Record<Extract<AmountReading, { kind: 'unclear' }>['reason'], Warning> = {
  'not-found': WARNINGS.amountNotInEmail,
  'several-numbers': WARNINGS.severalNumbers,
  'no-currency': WARNINGS.currencyNotStated,
  'not-plain': WARNINGS.amountNotPlain,
};

/** Keeps the amount only if the email states it plainly and it is what the model read. */
export function checkAmount(extraction: Extraction, emailText: string, settings: UnderstandSettings): CheckedAmount {
  const { amount, currency } = extraction;
  if (amount === null) return unclear(WARNINGS.amountNotStated);
  const reading = readAmount(extraction.amountQuote, emailText);
  if (reading.kind === 'unclear') return unclear(UNCLEAR_WARNING[reading.reason]);
  if (reading.value <= 0 || Math.abs(reading.value - amount) >= AMOUNT_TOLERANCE) return unclear(WARNINGS.amountNotInEmail);
  if (currency !== reading.currency) return unclear(WARNINGS.currencyNotStated);
  const decimals = (reading.value.toString().split('.')[1] ?? '').length;
  if (decimals > decimalsOf(reading.currency)) return unclear(WARNINGS.amountNotInEmail);
  if (reading.value > settings.maxAmount) return unclear(WARNINGS.amountOverLimit);
  return { amount: reading.value, currency: reading.currency, warnings: [] };
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
  // A cut email may hold the real total in the part nobody read, so it gets no one-click Approve either.
  const checked =
    injected || email.clipped ? { amount: null, currency: null, warnings: [] } : checkAmount(extraction, email.text, settings);
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
    mentioned: moneyMentioned(email.text),
  };
}
