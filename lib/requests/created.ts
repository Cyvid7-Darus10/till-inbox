import { z } from 'zod';
import { isAirwallexUrl } from '../airwallex/payment-links';
import { cardRefSchema, MAX_BUTTON_VALUE_LENGTH, pendingSchema } from './pending';

/**
 * A payment link that was created, as carried by the buttons under it ("Has it been paid?",
 * "Send reply"). Validated again on every click, like a pending request.
 */

export const createdLinkSchema = z.object({
  /** The approved request, with only the card it was approved on. */
  pending: pendingSchema.extend({ cards: z.array(cardRefSchema).length(1) }),
  link: z.object({
    id: z.string().min(1).max(64),
    url: z.string().url().refine(isAirwallexUrl, 'not an https Airwallex page'),
    accountId: z.string().regex(/^acct_[\w-]{6,40}$/),
    createdAt: z.string().max(40),
    expiresAt: z.string().max(40),
  }),
});

export type CreatedLink = z.infer<typeof createdLinkSchema>;

export const encodeCreated = (created: CreatedLink): string => JSON.stringify(created);

export function decodeCreated(value: string | undefined): CreatedLink | null {
  if (!value || value.length > MAX_BUTTON_VALUE_LENGTH) return null;
  try {
    const parsed = createdLinkSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
