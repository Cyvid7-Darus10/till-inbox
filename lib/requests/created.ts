import { z } from 'zod';
import { isAirwallexUrl } from '../airwallex/payment-links';
import { cardRefSchema, decodeSigned, MAX_BUTTON_VALUE_LENGTH, pendingSchema } from './pending';
import { signValue } from './signed';

/**
 * A payment link that was created, as carried by the buttons under it ("Has it been paid?",
 * "Send reply"). Signed and validated again on every click, like a pending request.
 */

/** Longest payment page address carried; Airwallex's are under 100 characters. */
export const MAX_LINK_URL_LENGTH = 200;

export const createdLinkSchema = z.object({
  /** The approved request, with only the card it was approved on. */
  pending: pendingSchema.extend({ cards: z.array(cardRefSchema).length(1) }),
  link: z.object({
    id: z.string().min(1).max(64),
    url: z.string().max(MAX_LINK_URL_LENGTH).url().refine(isAirwallexUrl, 'not an https Airwallex page'),
    accountId: z.string().regex(/^acct_[\w-]{6,40}$/),
    createdAt: z.string().max(40),
    expiresAt: z.string().max(40),
  }),
});

export type CreatedLink = z.infer<typeof createdLinkSchema>;

export const encodeCreated = (created: CreatedLink, secret: string): string => signValue('created', JSON.stringify(created), secret);

export const decodeCreated = (value: string | undefined, secret: string): CreatedLink | null =>
  decodeSigned('created', value, secret, createdLinkSchema, MAX_BUTTON_VALUE_LENGTH);
