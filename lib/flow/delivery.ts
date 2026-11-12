import { COPY } from '../copy';
import type { InboundEmail } from '../email/provider';
import { log } from '../log';
import { requestIdFor } from '../requests/pending';
import { handleEmail, type InboundOutcome } from './inbound';
import type { FlowDeps } from './ports';

/**
 * What happens to an accepted webhook after the provider got its 200: fetch the email, apply the
 * per-sender limit, and run the flow. The provider does not retry, so if any of it fails the admins
 * get a short notice (the time and the email id, nothing from the email) instead of losing it
 * silently. The replay cache keeps its entry: a retry would not be a new email.
 */

export interface DeliveryIo {
  fetchEmail(emailId: string): Promise<InboundEmail>;
  /** The per-sender hourly limit. False drops the email. */
  allowSender(address: string): boolean;
  /** Gets the chat ready and returns what the flow needs. */
  ready(): Promise<FlowDeps>;
}

export type DeliveryOutcome = InboundOutcome | 'sender-limited' | 'failed-notified' | 'failed-silent';

export async function processDelivery(emailId: string, arrivedAt: Date, io: DeliveryIo): Promise<DeliveryOutcome> {
  const requestId = requestIdFor(emailId);
  try {
    const email = await io.fetchEmail(emailId);
    if (!io.allowSender(email.from.address)) {
      log.warn('inbound email rate limited for its sender', { requestId });
      return 'sender-limited';
    }
    const outcome = await handleEmail(email, await io.ready());
    log.info('inbound email handled', { requestId, outcome });
    return outcome;
  } catch (error: unknown) {
    log.error('failed to handle an inbound email', { requestId, error });
    return notifyUnread(emailId, arrivedAt, io);
  }
}

async function notifyUnread(emailId: string, arrivedAt: Date, io: DeliveryIo): Promise<DeliveryOutcome> {
  const requestId = requestIdFor(emailId);
  try {
    const deps = await io.ready();
    await deps.chat.postAlert(deps.settings.adminSlackIds, COPY.unreadEmail(arrivedAt, emailId));
    return 'failed-notified';
  } catch (error: unknown) {
    log.error('failed to tell the admins about an email that could not be read', { requestId, error });
    return 'failed-silent';
  }
}
