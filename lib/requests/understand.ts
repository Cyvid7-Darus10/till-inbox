import type { InboundEmail } from '../email/provider';
import { amountAtQuote, decimalsOf } from './amount';
import { cleanField } from './clean';
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

export const looksLikeInstructions = (text: string): boolean => INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));

const AMOUNT_TOLERANCE = 0.005;

interface CheckedAmount {
  amount: number | null;
  currency: string | null;
  warnings: Warning[];
}

const unclear = (warning: Warning): CheckedAmount => ({ amount: null, currency: null, warnings: [warning] });

/**
 * Keeps the amount only if the email itself states it. The model's quote only says where to look:
 * lib/requests/amount.ts reads the one amount token there with a strict grammar, and the amount and
 * currency that go on the card are the ones the email states, and must agree with the model's.
 */
export function checkAmount(extraction: Extraction, emailText: string, settings: UnderstandSettings): CheckedAmount {
  const { amount, currency } = extraction;
  if (amount === null) return unclear(WARNINGS.amountNotStated);
  const token = amountAtQuote(extraction.amountQuote, emailText);
  if (!token || token.value === null || token.value <= 0 || Math.abs(token.value - amount) >= AMOUNT_TOLERANCE) {
    return unclear(WARNINGS.amountNotInEmail);
  }
  if (!currency || token.currency !== currency) return unclear(WARNINGS.currencyNotStated);
  const decimals = (token.value.toString().split('.')[1] ?? '').length;
  if (decimals > decimalsOf(currency)) return unclear(WARNINGS.amountNotInEmail);
  if (token.value > settings.maxAmount) return unclear(WARNINGS.amountOverLimit);
  return { amount: token.value, currency, warnings: [] };
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
  };
}
