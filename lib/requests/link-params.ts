import type { PendingRequest } from './pending';

/**
 * The exact arguments for Airwallex's create_payment_link tool, built by code from the approved
 * request. A fixed amount, single use, an expiry, and the request id as the merchant reference.
 * No shopper_email: that field makes Airwallex email the customer, and Till Inbox never contacts
 * the customer on its own. Pure.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 100;

export interface PaymentLinkArgs {
  account_id: string;
  title: string;
  amount: number;
  currency: string;
  description: string;
  reference: string;
  reusable: false;
  expires_at: string;
  metadata: Record<string, string>;
}

/** Airwallex wants ISO 8601 with a Z suffix. */
export const expiryFrom = (now: Date, days: number): string =>
  new Date(now.getTime() + days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function linkArgs(pending: PendingRequest, accountId: string, expiresAt: string): PaymentLinkArgs {
  if (pending.amount === null || pending.currency === null) throw new Error('failed to build a payment link: no amount approved');
  const payer = pending.customer.company ?? pending.customer.name;
  return {
    account_id: accountId,
    title: capitalize(pending.purpose).slice(0, MAX_TITLE_LENGTH),
    amount: pending.amount,
    currency: pending.currency,
    description: payer ? `For ${payer}` : 'Payment',
    reference: pending.requestId,
    reusable: false,
    expires_at: expiresAt,
    metadata: { source: 'till-inbox', request_id: pending.requestId },
  };
}
