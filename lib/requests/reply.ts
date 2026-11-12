import { formatAmount, type PendingRequest } from './pending';

/**
 * The reply to the customer, built by code from checked fields. The model writes none of it, so an
 * email can't put words, links or a different recipient into our answer. Pure.
 */

export const LINK_PLACEHOLDER = '[payment link]';

export interface Reply {
  /** Always the sender of the original email. */
  to: string;
  subject: string;
  text: string;
}

export interface ReplySettings {
  companyName: string;
}

const firstName = (name: string | null): string | null => name?.split(' ')[0] ?? null;

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Fixed text and the configured company name only. Nothing from the inbound email reaches the
 * outbound subject, so an email can't put a link or a header line break there.
 */
export const replySubject = (companyName: string): string => `Your payment link from ${companyName}`;

/**
 * The reply text. Without a link yet (on the approval card) it shows a placeholder.
 * Throws if the request has no amount, since such a request can't have a link.
 */
export function buildReply(pending: PendingRequest, link: { url: string; expiresAt: string } | null, settings: ReplySettings): Reply {
  if (pending.amount === null || pending.currency === null) throw new Error('failed to build a reply: the request has no amount');
  const greeting = firstName(pending.customer.name);
  const lines = [
    greeting ? `Hi ${greeting},` : 'Hello,',
    '',
    `Thanks for getting in touch. You can pay ${formatAmount(pending.amount, pending.currency)} for ${pending.purpose} here:`,
    link?.url ?? LINK_PLACEHOLDER,
    '',
    link ? `The link works until ${formatDate(link.expiresAt)}. You can pay by card or another method shown on the page.` : '',
    'Reply to this email if anything looks wrong.',
    '',
    'Thanks,',
    settings.companyName,
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');
  return { to: pending.customer.email, subject: replySubject(settings.companyName), text: lines.join('\n') };
}
