import { type CreatedLink, encodeCreated, MAX_LINK_URL_LENGTH } from './created';
import { encodeModalContext, MAX_MODAL_METADATA_LENGTH } from './modal-context';
import { type CardRef, encodePending, MAX_BUTTON_VALUE_LENGTH, type PendingRequest } from './pending';

/**
 * Whether a request fits everywhere it will travel, signed: the approval card's buttons (with a
 * card listed for each approver), the amount form, and the buttons under the created link. A
 * request that does not fit is refused up front, so nothing fails after a link exists.
 */

// Lengths do not depend on the secret, only on the payload.
const SIZING_SECRET = 'only used to measure lengths';
const LONGEST_CARD: CardRef = { channel: 'D'.repeat(20), messageId: `${'9'.repeat(12)}.${'9'.repeat(8)}` };
const LONGEST_LINK: CreatedLink['link'] = {
  id: 'i'.repeat(64),
  url: `https://${'p'.repeat(MAX_LINK_URL_LENGTH - 8)}`,
  accountId: `acct_${'a'.repeat(40)}`,
  createdAt: '2'.repeat(40),
  expiresAt: '2'.repeat(40),
};
const LONGEST_THREAD = `slack:${LONGEST_CARD.channel}:${LONGEST_CARD.messageId}`;

export function fitsInButtons(draft: PendingRequest, approvers: number): boolean {
  const pending = { ...draft, cards: Array.from({ length: approvers }, () => LONGEST_CARD) };
  const created: CreatedLink = { pending: { ...draft, cards: [LONGEST_CARD] }, link: LONGEST_LINK };
  const context = { pending, threadId: LONGEST_THREAD, messageId: '9'.repeat(40) };
  return (
    encodePending(pending, SIZING_SECRET).length <= MAX_BUTTON_VALUE_LENGTH &&
    encodeCreated(created, SIZING_SECRET).length <= MAX_BUTTON_VALUE_LENGTH &&
    encodeModalContext(context, SIZING_SECRET).length <= MAX_MODAL_METADATA_LENGTH
  );
}
