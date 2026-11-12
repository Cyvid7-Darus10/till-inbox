import { z } from 'zod';
import { cleanMessageId } from './clean';
import { MAX_NOTE_LENGTH, MAX_PURPOSE_LENGTH } from './extraction';
import { WARNINGS } from './understand';

/**
 * A payment request waiting for an admin. There is no database: it travels inside the Slack button
 * values and is validated again every time it comes back, so a tampered button is just ignored.
 */

/** Slack refuses a button value longer than this. */
export const MAX_BUTTON_VALUE_LENGTH = 2000;
/** One approval card per admin; config caps admins at this number too. */
export const MAX_APPROVAL_CARDS = 5;

const SLACK_CHANNEL_ID = /^[A-Z0-9]{5,20}$/;
const SLACK_MESSAGE_TS = /^\d{6,12}\.\d{1,8}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const REQUEST_ID = /^[\w.-]{1,64}$/;

export const cardRefSchema = z.object({ channel: z.string().regex(SLACK_CHANNEL_ID), messageId: z.string().regex(SLACK_MESSAGE_TS) });
export type CardRef = z.infer<typeof cardRefSchema>;

const warningSchema = z.enum(Object.values(WARNINGS) as [string, ...string[]]);

export const pendingSchema = z.object({
  /** Fixed per email. Also the payment link's merchant reference, so a repeat finds the first link. */
  requestId: z.string().regex(REQUEST_ID),
  receivedAt: z.iso.datetime({ offset: true }),
  /** For threading a reply email. */
  messageId: z
    .string()
    .max(200)
    .refine((value) => cleanMessageId(value) === value, 'not a safe Message-ID')
    .nullable(),
  subject: z.string().max(120),
  customer: z.object({ name: z.string().max(120).nullable(), company: z.string().max(120).nullable(), email: z.email() }),
  purpose: z.string().min(1).max(MAX_PURPOSE_LENGTH),
  amount: z.number().positive().max(1_000_000).nullable(),
  currency: z.string().regex(CURRENCY_CODE).nullable(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  note: z.string().max(MAX_NOTE_LENGTH),
  warnings: z.array(warningSchema).max(10),
  /** Amounts the email writes as money, shown on the card as information. */
  mentioned: z.array(z.string().regex(/^[\w$€£ ,.]{1,24}$/)).max(10),
  /** Every approval card for this request, so the first decision can close the rest. */
  cards: z.array(cardRefSchema).max(MAX_APPROVAL_CARDS),
});

export type PendingRequest = z.infer<typeof pendingSchema>;

/** Slack returns button values exactly as posted. JSON keeps them short enough. */
export const encodePending = (pending: PendingRequest): string => JSON.stringify(pending);

export function decodePending(value: string | undefined): PendingRequest | null {
  if (!value || value.length > MAX_BUTTON_VALUE_LENGTH) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Whether the request still fits in a button once a card is listed for each approver. */
export function fitsInButton(draft: PendingRequest, approvers: number): boolean {
  const longest: CardRef = { channel: 'D'.repeat(20), messageId: `${'9'.repeat(12)}.${'9'.repeat(8)}` };
  return encodePending({ ...draft, cards: Array.from({ length: approvers }, () => longest) }).length <= MAX_BUTTON_VALUE_LENGTH;
}

/** One request per email: the provider's email id, made safe for an Airwallex reference. */
export const requestIdFor = (emailId: string): string => `till-inbox-${emailId.replace(/[^\w.-]/g, '')}`.slice(0, 64);

export function formatAmount(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
