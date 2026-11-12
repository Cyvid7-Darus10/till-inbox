import type { InboundEmail } from '../email/provider';
import { log } from '../log';
import { fitsInButton, type PendingRequest, requestIdFor } from '../requests/pending';
import { understand } from '../requests/understand';
import type { FlowDeps } from './ports';

/**
 * Email in: the model reads it, code checks the reading, and every admin gets an approval card.
 * Nothing is created in Airwallex and nothing goes to the customer here.
 */

export type InboundOutcome = 'carded' | 'noticed' | 'too-long' | 'not-sent';

export async function handleEmail(email: InboundEmail, deps: FlowDeps): Promise<InboundOutcome> {
  const requestId = requestIdFor(email.id);
  const extraction = await deps.extract(email);
  const understood = understand(email, extraction, { maxAmount: deps.settings.maxAmount });
  if (understood.kind === 'not-payment') {
    log.info('email is not a payment request', { requestId });
    await deps.chat.postNotice(deps.settings.adminSlackIds, understood.customer, email.subject, understood.note);
    return 'noticed';
  }
  const draft: PendingRequest = {
    requestId,
    receivedAt: email.receivedAt,
    messageId: email.messageId && email.messageId.length <= 200 ? email.messageId : null,
    subject: email.subject.slice(0, 120),
    customer: understood.customer,
    purpose: understood.purpose,
    amount: understood.amount,
    currency: understood.currency,
    dueDate: understood.dueDate,
    confidence: understood.confidence,
    note: understood.note,
    warnings: understood.warnings,
    cards: [],
  };
  // Warnings are fixed codes, safe to log; they say why a card asks for an amount.
  log.info('payment request read', { requestId, readyToApprove: draft.amount !== null, warnings: draft.warnings });
  if (!fitsInButton(draft, deps.settings.adminSlackIds.length)) {
    log.warn('payment request too long for an approval card', { requestId });
    await deps.chat.postNotice(
      deps.settings.adminSlackIds,
      draft.customer,
      email.subject,
      'The request was too long to put on an approval card.',
    );
    return 'too-long';
  }
  const pending = await deps.chat.postCards(draft, deps.settings.adminSlackIds);
  if (!pending) return 'not-sent';
  log.info('approval cards posted', { requestId, cards: pending.cards.length });
  return 'carded';
}
