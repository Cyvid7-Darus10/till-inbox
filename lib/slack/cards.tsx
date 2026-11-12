/** @jsxImportSource chat */
import { Actions, Button, Card, type CardElement, CardText, Field, Fields, LinkButton, Modal, TextInput, toCardElement } from 'chat';
import { COPY, WARNING_TEXT } from '../copy';
import { actionsFor } from '../requests/approval';
import { type CreatedLink, encodeCreated } from '../requests/created';
import { type CardRef, encodePending, formatAmount, type PendingRequest } from '../requests/pending';
import { buildReply, type ReplySettings } from '../requests/reply';
import { WARNINGS } from '../requests/understand';
import { plainText, safeLink } from './text';

/** Slack action ids. */
export const ACTIONS = {
  approve: 'till_inbox_approve',
  editAmount: 'till_inbox_edit_amount',
  reject: 'till_inbox_reject',
  checkPaid: 'till_inbox_check_paid',
  sendReply: 'till_inbox_send_reply',
} as const;

export const AMOUNT_MODAL = 'till_inbox_amount';
export const MODAL_FIELDS = { amount: 'amount', currency: 'currency', purpose: 'purpose' } as const;

export interface CardSettings extends ReplySettings {
  linkExpiryDays: number;
}

const asElement = (card: ReturnType<typeof Card>, what: string): CardElement => {
  const element = toCardElement(card);
  if (!element) throw new Error(`failed to build the ${what} card`);
  return element;
};

const payerName = (pending: PendingRequest): string => pending.customer.company ?? pending.customer.name ?? pending.customer.email;

const fromLine = (pending: PendingRequest): string => {
  const { name, company, email } = pending.customer;
  return [name, company, email].filter(Boolean).join(', ');
};

const quoted = (text: string): string =>
  text
    .split('\n')
    .map((line) => `> ${plainText(line)}`)
    .join('\n');

function RequestFields({ pending, settings }: { pending: PendingRequest; settings: CardSettings }) {
  const amount =
    pending.amount !== null && pending.currency !== null ? formatAmount(pending.amount, pending.currency) : COPY.card.amountMissing;
  return (
    <Fields>
      <Field label={COPY.card.from} value={plainText(fromLine(pending))} />
      <Field label={COPY.card.senderCheck} value={COPY.card.senderCheckValue(!pending.warnings.includes(WARNINGS.senderNotVerified))} />
      <Field label={COPY.card.request} value={plainText(pending.purpose)} />
      <Field label={COPY.card.amount} value={amount} />
      <Field label={COPY.card.expiry} value={COPY.card.expiryValue(settings.linkExpiryDays)} />
      {pending.dueDate ? <Field label={COPY.card.due} value={pending.dueDate} /> : null}
    </Fields>
  );
}

const warningLines = (pending: PendingRequest): string =>
  pending.warnings.map((warning) => `• ${WARNING_TEXT[warning as keyof typeof WARNING_TEXT]}`).join('\n');

/** Sent to each admin's DM. The buttons carry the whole request; bot.ts checks every click. */
export function approvalCard(pending: PendingRequest, settings: CardSettings): CardElement {
  const value = encodePending(pending);
  const actions = actionsFor(pending);
  const ready = pending.amount !== null && pending.currency !== null;
  return asElement(
    <Card title={COPY.card.title(payerName(pending))}>
      {RequestFields({ pending, settings })}
      {pending.warnings.length > 0 ? <CardText>{warningLines(pending)}</CardText> : null}
      {pending.note ? <CardText style="muted">{COPY.card.note(pending.note)}</CardText> : null}
      {ready ? <CardText>{`${COPY.card.draftReply}\n${quoted(buildReply(pending, null, settings).text)}`}</CardText> : null}
      <CardText style="muted">{COPY.card.footer}</CardText>
      <Actions>
        {actions.includes('approve') ? (
          <Button id={ACTIONS.approve} style="primary" value={value}>
            {COPY.card.approve}
          </Button>
        ) : null}
        <Button id={ACTIONS.editAmount} value={value}>
          {ready ? COPY.card.editAmount : COPY.card.setAmount}
        </Button>
        <Button id={ACTIONS.reject} style="danger" value={value}>
          {COPY.card.reject}
        </Button>
      </Actions>
    </Card>,
    'approval',
  );
}

/** A card after a decision: same details, no buttons, so it can't be pressed twice. */
export function resolvedCard(pending: PendingRequest, outcome: string, settings: CardSettings): CardElement {
  return asElement(
    <Card title={COPY.card.title(payerName(pending))}>
      {RequestFields({ pending, settings })}
      <CardText style="muted">{outcome}</CardText>
    </Card>,
    'resolved',
  );
}

export function noticeCard(who: string, subject: string, note: string): CardElement {
  return asElement(
    <Card title={COPY.notice.title}>
      <CardText>{COPY.notice.body(who, subject, note)}</CardText>
    </Card>,
    'notice',
  );
}

export function connectCard(consentUrl: string): CardElement {
  return asElement(
    <Card title={COPY.thread.connect.title}>
      <CardText>{COPY.thread.connect.body}</CardText>
      <Actions>
        <LinkButton url={consentUrl} style="primary">
          {COPY.thread.connect.title}
        </LinkButton>
      </Actions>
    </Card>,
    'connect',
  );
}

/** The created link, the reply to copy, and the follow-up buttons. */
export function createdCard(created: CreatedLink, reply: string, canSendEmail: boolean, sent = false): CardElement {
  const value = encodeCreated(created);
  const url = safeLink(created.link.url);
  return asElement(
    <Card title={formatAmount(created.pending.amount ?? 0, created.pending.currency ?? '')}>
      <CardText>{`${canSendEmail && !sent ? COPY.thread.replyHeading : COPY.thread.replyHeadingCopyOnly}\n${quoted(reply)}`}</CardText>
      <Actions>
        {url ? <LinkButton url={url}>Open payment link</LinkButton> : null}
        <Button id={ACTIONS.checkPaid} value={value}>
          {COPY.thread.checkPaid}
        </Button>
        {canSendEmail && !sent ? (
          <Button id={ACTIONS.sendReply} style="primary" value={value}>
            {COPY.thread.sendReply}
          </Button>
        ) : null}
      </Actions>
    </Card>,
    'created',
  );
}

/** What the amount modal carries between opening and submitting. */
export interface ModalContext {
  pending: PendingRequest;
  threadId: string;
  messageId: string;
}

export function amountModal(context: ModalContext) {
  const { pending } = context;
  return (
    <Modal callbackId={AMOUNT_MODAL} title={COPY.modal.title} submitLabel={COPY.modal.submit} privateMetadata={JSON.stringify(context)}>
      <TextInput id={MODAL_FIELDS.amount} label={COPY.modal.amount} initialValue={pending.amount?.toString() ?? ''} maxLength={12} />
      <TextInput id={MODAL_FIELDS.currency} label={COPY.modal.currency} initialValue={pending.currency ?? ''} maxLength={3} />
      <TextInput id={MODAL_FIELDS.purpose} label={COPY.modal.purpose} initialValue={pending.purpose} maxLength={160} />
    </Modal>
  );
}

export type { CardRef };
