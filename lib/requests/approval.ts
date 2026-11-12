import { cleanField } from './clean';
import type { CardRef, PendingRequest } from './pending';
import { WARNINGS } from './understand';

/**
 * The approval state machine. A card is open while it shows buttons. An open card is either
 * waiting for an amount (only "Set amount" and "Reject") or ready (also "Approve"). Approve and
 * Reject close every card for the request, so the first decision wins and later clicks do nothing.
 *
 *   needs-amount --set amount--> ready --approve--> approved (link created)
 *        |                         |  \--edit amount--> ready
 *        +--------reject-----------+-----reject-----> rejected
 */

export type CardState = 'needs-amount' | 'ready';
export type Action = 'approve' | 'edit-amount' | 'reject';

export const cardState = (pending: PendingRequest): CardState =>
  pending.amount !== null && pending.currency !== null ? 'ready' : 'needs-amount';

/** The buttons an open card shows. */
export function actionsFor(pending: PendingRequest): Action[] {
  return cardState(pending) === 'ready' ? ['approve', 'edit-amount', 'reject'] : ['edit-amount', 'reject'];
}

export interface Click {
  action: Action;
  clicker: string;
  clickerIsAdmin: boolean;
  /** Chat SDK thread id of the clicked message, `slack:<channel>:<thread ts>`. */
  threadId: string;
  messageId: string;
}

export type ClickCheck = { ok: true; card: CardRef } | { ok: false; reason: 'invalid' | 'unknown-card' | 'not-admin' | 'not-available' };

/** The Slack channel inside a Chat SDK thread id. */
export const channelOf = (threadId: string): string => threadId.split(':')[1] ?? '';

/**
 * Only an admin may act, only on a card posted for this request, and only with a button that card
 * state allows (an "Approve" smuggled onto a card without an amount is refused).
 */
export function checkClick(pending: PendingRequest | null, click: Click): ClickCheck {
  if (!pending) return { ok: false, reason: 'invalid' };
  const channel = channelOf(click.threadId);
  const card = pending.cards.find((ref) => ref.channel === channel && ref.messageId === click.messageId);
  if (!card) return { ok: false, reason: 'unknown-card' };
  if (!click.clickerIsAdmin) return { ok: false, reason: 'not-admin' };
  if (!actionsFor(pending).includes(click.action)) return { ok: false, reason: 'not-available' };
  return { ok: true, card };
}

const AMOUNT_WARNINGS: readonly string[] = [
  WARNINGS.amountNotStated,
  WARNINGS.amountNotInEmail,
  WARNINGS.currencyNotStated,
  WARNINGS.amountOverLimit,
  WARNINGS.severalNumbers,
  WARNINGS.amountNotPlain,
];

export type AmountEdit = { ok: true; pending: PendingRequest } | { ok: false; problem: string };

/** Reads an amount an admin typed: "950", "1,520.50". At most two decimals. */
export function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  // A comma only as a thousands separator: "1,520.50" yes, "12,50" (a decimal comma) no.
  if (!/^(?:\d{1,3}(?:,\d{3}){1,2}|\d{1,7})(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const amount = Number(trimmed.replace(/,/g, ''));
  return amount > 0 ? amount : null;
}

/** Returns a copy of the request with the amount an admin set. The original is never changed. */
export function withAmount(
  pending: PendingRequest,
  input: { amount: string; currency: string; purpose?: string },
  maxAmount: number,
): AmountEdit {
  const amount = parseAmount(input.amount);
  if (amount === null) return { ok: false, problem: 'Enter the amount as a number, like 950 or 1,520.50.' };
  if (amount > maxAmount) return { ok: false, problem: `That is above the limit of ${maxAmount.toLocaleString('en-US')}.` };
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, problem: 'Enter a three-letter currency code, like AUD.' };
  const purpose = input.purpose === undefined ? pending.purpose : cleanField(input.purpose, 160);
  if (!purpose) return { ok: false, problem: 'Describe what the payment is for.' };
  return {
    ok: true,
    pending: {
      ...pending,
      amount,
      currency,
      purpose,
      warnings: pending.warnings.filter((warning) => !AMOUNT_WARNINGS.includes(warning)),
    },
  };
}
