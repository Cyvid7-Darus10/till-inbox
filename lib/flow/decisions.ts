import { COPY } from '../copy';
import { log } from '../log';
import { type Action, type Click, checkClick, withAmount } from '../requests/approval';
import type { CreatedLink } from '../requests/created';
import { formatAmount, type PendingRequest } from '../requests/pending';
import { buildReply } from '../requests/reply';
import type { FlowDeps } from './ports';

/**
 * What happens when an admin presses a button. Each function checks the click, takes the
 * in-instance lock for the request, and reads the cards back from Slack: a card without buttons
 * means someone already decided, so the click does nothing.
 */

export type DecisionOutcome =
  | 'ignored'
  | 'busy'
  | 'decided'
  | 'needs-login'
  | 'created'
  | 'reused'
  | 'failed'
  | 'rejected'
  | 'amount-set'
  | 'amount-refused';

async function withLock(deps: FlowDeps, key: string, work: () => Promise<DecisionOutcome>): Promise<DecisionOutcome> {
  if (deps.locks.has(key)) return 'busy';
  deps.locks.add(key);
  try {
    return await work();
  } finally {
    deps.locks.delete(key);
  }
}

function accepted(pending: PendingRequest | null, click: Click): { pending: PendingRequest; card: PendingRequest['cards'][number] } | null {
  const check = checkClick(pending, click);
  if (!pending || !check.ok) {
    log.warn('ignored a click', { reason: check.ok ? 'invalid' : check.reason, action: click.action, userId: click.clicker });
    return null;
  }
  return { pending, card: check.card };
}

const clickFor = (action: Action, click: Omit<Click, 'action'>): Click => ({ ...click, action });

/** Approve: close the cards, then create the link with the approver's own Airwallex login. */
export async function approve(value: PendingRequest | null, click: Omit<Click, 'action'>, deps: FlowDeps): Promise<DecisionOutcome> {
  const ok = accepted(value, clickFor('approve', click));
  if (!ok) return 'ignored';
  const { pending, card } = ok;
  return withLock(deps, pending.requestId, async () => {
    if (!(await deps.chat.allOpen(pending))) return 'decided';
    if (!(await deps.payments.isConnected(click.clicker))) {
      // The cards keep their buttons, so this admin (or another) can approve after signing in.
      await deps.chat.postInThread(card, { kind: 'connect', url: await deps.payments.connectUrl(click.clicker) });
      return 'needs-login';
    }
    const admin = await deps.chat.displayName(click.clicker);
    // Closing first means a second click, here or on another admin's card, finds the request decided.
    if (!(await deps.chat.closeCards(pending, COPY.outcome.approving(admin)))) throw new Error('failed to close every approval card');
    const result = await deps.payments.create(click.clicker, pending, deps.now()).catch((error: unknown) => {
      log.error('failed to create a payment link', { requestId: pending.requestId, error });
      return { ok: false as const, problem: 'Airwallex did not answer as expected. Try Approve again in a moment.' };
    });
    if (!result.ok || !result.accountId || !result.expiresAt) {
      log.warn('payment link not created', { requestId: pending.requestId });
      // Reopen the cards so an admin can try again. A retry reuses any link this request already got.
      await deps.chat.refreshCards(pending);
      await deps.chat.postInThread(card, {
        kind: 'text',
        text: COPY.thread.notCreated(result.ok ? 'Airwallex gave no account.' : result.problem),
      });
      return 'failed';
    }
    const created: CreatedLink = {
      pending: { ...pending, cards: [card] },
      link: {
        id: result.link.id,
        url: result.link.url,
        accountId: result.accountId,
        createdAt: result.link.created_at,
        expiresAt: result.link.expires_at ?? result.expiresAt,
      },
    };
    const reply = buildReply(pending, { url: created.link.url, expiresAt: created.link.expiresAt }, deps.settings).text;
    const amount = formatAmount(pending.amount ?? 0, pending.currency ?? '');
    await deps.chat.postInThread(card, { kind: 'text', text: COPY.thread.created(amount, result.reused) });
    await deps.chat.postInThread(card, { kind: 'created', created, reply, canSendEmail: deps.settings.sendReplyEmail });
    log.info('payment link ready', { requestId: pending.requestId, reused: result.reused });
    return result.reused ? 'reused' : 'created';
  });
}

export async function reject(value: PendingRequest | null, click: Omit<Click, 'action'>, deps: FlowDeps): Promise<DecisionOutcome> {
  const ok = accepted(value, clickFor('reject', click));
  if (!ok) return 'ignored';
  const { pending } = ok;
  return withLock(deps, pending.requestId, async () => {
    if (!(await deps.chat.allOpen(pending))) return 'decided';
    await deps.chat.closeCards(pending, COPY.outcome.rejected(await deps.chat.displayName(click.clicker)));
    log.info('payment request rejected', { requestId: pending.requestId });
    return 'rejected';
  });
}

/** Set or edit the amount: every card is redrawn with the new amount and an Approve button. */
export async function setAmount(
  value: PendingRequest | null,
  click: Omit<Click, 'action'>,
  input: { amount: string; currency: string; purpose?: string },
  deps: FlowDeps,
): Promise<DecisionOutcome> {
  const ok = accepted(value, clickFor('edit-amount', click));
  if (!ok) return 'ignored';
  const { pending, card } = ok;
  return withLock(deps, pending.requestId, async () => {
    if (!(await deps.chat.allOpen(pending))) return 'decided';
    const edit = withAmount(pending, input, deps.settings.maxAmount);
    if (!edit.ok) {
      await deps.chat.postInThread(card, { kind: 'text', text: COPY.thread.amountProblem(edit.problem) });
      return 'amount-refused';
    }
    if (!(await deps.chat.refreshCards(edit.pending))) throw new Error('failed to update every approval card');
    const admin = await deps.chat.displayName(click.clicker);
    await deps.chat.postInThread(card, {
      kind: 'text',
      text: COPY.thread.amountUpdated(admin, formatAmount(edit.pending.amount ?? 0, edit.pending.currency ?? '')),
    });
    log.info('amount set by an admin', { requestId: pending.requestId });
    return 'amount-set';
  });
}

export interface LinkClick {
  clicker: string;
  clickerIsAdmin: boolean;
  threadId: string;
  messageId: string;
}

/** "Has it been paid?": reads the link's status from Airwallex with the clicker's own login. */
export async function checkPaid(
  created: CreatedLink | null,
  click: LinkClick,
  deps: FlowDeps,
): Promise<'answered' | 'ignored' | 'needs-login'> {
  if (!created || !click.clickerIsAdmin) {
    log.warn('ignored a status click', { userId: click.clicker });
    return 'ignored';
  }
  const card = created.pending.cards[0];
  if (!(await deps.payments.isConnected(click.clicker))) {
    await deps.chat.postInThread(card, { kind: 'connect', url: await deps.payments.connectUrl(click.clicker) });
    return 'needs-login';
  }
  const status = await deps.payments.status(click.clicker, created);
  const text = status ? COPY.thread.status(status.status, status.active, status.expiresAt) : COPY.thread.statusNotFound;
  await deps.chat.postInThread(card, { kind: 'text', text });
  return 'answered';
}

/** "Send reply", only when TILL_SEND_REPLY_EMAIL is true: emails the reply to the original sender, once. */
export async function sendReply(created: CreatedLink | null, click: LinkClick, deps: FlowDeps): Promise<'sent' | 'ignored' | 'failed'> {
  if (!created || !click.clickerIsAdmin || !deps.settings.sendReplyEmail) {
    log.warn('ignored a send click', { userId: click.clicker });
    return 'ignored';
  }
  const { pending, link } = created;
  const key = `${pending.requestId}:send`;
  if (deps.locks.has(key)) return 'ignored';
  deps.locks.add(key);
  try {
    if (!(await deps.chat.canStillSend(click.threadId, click.messageId))) return 'ignored';
    const reply = buildReply(pending, { url: link.url, expiresAt: link.expiresAt }, deps.settings);
    // Remove the button before sending: a second click then finds nothing to press.
    await deps.chat.markSent(click.threadId, click.messageId, created, reply.text);
    try {
      await deps.email.sendEmail({ to: reply.to, subject: reply.subject, text: reply.text, inReplyTo: pending.messageId });
    } catch (error: unknown) {
      log.error('failed to send a reply email', { requestId: pending.requestId, error });
      await deps.chat.postInThread(pending.cards[0], { kind: 'text', text: COPY.thread.sendFailed });
      return 'failed';
    }
    const admin = await deps.chat.displayName(click.clicker);
    await deps.chat.postInThread(pending.cards[0], { kind: 'text', text: COPY.thread.sent(reply.to, admin) });
    log.info('reply email sent', { requestId: pending.requestId });
    return 'sent';
  } finally {
    deps.locks.delete(key);
  }
}
