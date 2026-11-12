import type { Extractor } from '../agent/extract';
import type { LinkResult, LinkStatus } from '../airwallex/payment-links';
import type { EmailProvider } from '../email/provider';
import type { CreatedLink } from '../requests/created';
import type { CardRef, PendingRequest } from '../requests/pending';
import type { Customer } from '../requests/understand';

/**
 * What the flow needs from the outside world. The server wires these to Slack, Airwallex, the
 * model and Resend (lib/slack/bot.ts); the local simulation wires them to fakes (scripts/simulate.ts).
 */

export type ThreadPost =
  | { kind: 'text'; text: string }
  /** An Airwallex sign-in button for an admin who hasn't connected yet. */
  | { kind: 'connect'; url: string }
  /** The link, the final reply, and the follow-up buttons. */
  | { kind: 'created'; created: CreatedLink; reply: string; canSendEmail: boolean };

export interface ApprovalChat {
  /** Posts one approval card per admin, all or nothing. Returns the request with its cards, or null. */
  postCards(draft: PendingRequest, admins: readonly string[]): Promise<PendingRequest | null>;
  /** Tells admins about an email that is not a payment request. No buttons. */
  postNotice(admins: readonly string[], customer: Customer, subject: string, note: string): Promise<void>;
  /** Sends admins a short plain message, such as an email that could not be read. No buttons. */
  postAlert(admins: readonly string[], text: string): Promise<void>;
  /** Re-renders every card with new content and buttons. False if any edit failed. */
  refreshCards(pending: PendingRequest): Promise<boolean>;
  /** Replaces every card with a decided version without buttons. False if any edit failed. */
  closeCards(pending: PendingRequest, outcome: string): Promise<boolean>;
  /** True while every card still shows its buttons, meaning nobody has decided. */
  allOpen(pending: PendingRequest): Promise<boolean>;
  /** Posts in the thread under a card. */
  postInThread(card: CardRef, post: ThreadPost): Promise<void>;
  /** True while a message still shows its "Send reply" button. */
  canStillSend(threadId: string, messageId: string): Promise<boolean>;
  /** Removes the "Send reply" button once the email has gone. */
  markSent(threadId: string, messageId: string, created: CreatedLink, reply: string): Promise<void>;
  /** A person's display name, for "Approved by …". */
  displayName(slackUserId: string): Promise<string>;
}

export interface Payments {
  isConnected(slackUserId: string): Promise<boolean>;
  connectUrl(slackUserId: string): Promise<string>;
  /** Creates the approved link with this admin's own login, or reuses the one made for this request. */
  create(slackUserId: string, pending: PendingRequest, now: Date): Promise<LinkResult & { accountId?: string; expiresAt?: string }>;
  status(slackUserId: string, created: CreatedLink): Promise<LinkStatus | null>;
}

export interface FlowSettings {
  adminSlackIds: readonly string[];
  maxAmount: number;
  companyName: string;
  sendReplyEmail: boolean;
}

export interface FlowDeps {
  chat: ApprovalChat;
  payments: Payments;
  extract: Extractor;
  email: Pick<EmailProvider, 'sendEmail'>;
  settings: FlowSettings;
  /** A short, non-reversible tag for a Slack user id, for logs (lib/log.ts userTag). */
  userTag: (slackUserId: string) => string;
  /** Request ids being worked on in this instance, so a double click waits for the first. */
  locks: Set<string>;
  now: () => Date;
}
