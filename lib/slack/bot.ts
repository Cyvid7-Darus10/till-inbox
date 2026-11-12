import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { connectSlackAdapter } from '@vercel/connect/chat';
import { type ActionEvent, Chat } from 'chat';
import { after } from 'next/server';
import { modelExtractor } from '../agent/extract';
import { airwallexPayments } from '../airwallex/payments';
import { config, isAdmin } from '../config';
import { COPY } from '../copy';
import { resendProvider } from '../email/resend';
import { approve, checkPaid, reject, sendReply, setAmount } from '../flow/decisions';
import type { ApprovalChat, FlowDeps, ThreadPost } from '../flow/ports';
import { log, userTag } from '../log';
import { channelOf } from '../requests/approval';
import { decodeCreated } from '../requests/created';
import { decodeModalContext } from '../requests/modal-context';
import { type CardRef, decodePending, type PendingRequest } from '../requests/pending';
import { hasButton, hasButtons } from './card-state';
import {
  ACTIONS,
  AMOUNT_MODAL,
  amountModal,
  approvalCard,
  type CardSettings,
  connectCard,
  createdCard,
  MODAL_FIELDS,
  noticeCard,
  resolvedCard,
} from './cards';

/** Where the Airwallex sign-in sends admins back to (app/api/airwallex/connected). */
export const CALLBACK_PATH = '/api/airwallex/connected';

// No database: memory state only covers this instance. A request travels in its button values, and
// a card's buttons show whether it is decided.
const makeChat = () =>
  new Chat({
    userName: 'Till Inbox',
    adapters: { slack: createSlackAdapter({ ...connectSlackAdapter(config().slackConnector), userName: 'Till Inbox' }) },
    state: createMemoryState(),
  }).registerSingleton();

let chat: ReturnType<typeof makeChat> | undefined;
let flowDeps: FlowDeps | undefined;

/** The Slack bot, built on first use so config is read at runtime, not at build time. */
export function bot(): ReturnType<typeof makeChat> {
  chat ??= makeChat();
  return chat;
}

const slack = () => bot().getAdapter('slack');

/** Public base URL of this deployment (Vercel system variables). */
function publicOrigin(): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (!host) throw new Error('failed to build the Airwallex callback: no deployment url');
  return `https://${host}`;
}

const cardSettings = (): CardSettings => ({
  companyName: config().companyName,
  linkExpiryDays: config().linkExpiryDays,
  stateSecret: config().stateSecret,
});

const secret = (): string => config().stateSecret;

// A card is a top-level DM message, so its own timestamp is also its thread.
const threadOf = (card: CardRef): string => `slack:${card.channel}:${card.messageId}`;

async function editAll(cards: readonly CardRef[], content: ReturnType<typeof approvalCard>): Promise<boolean> {
  const results = await Promise.allSettled(cards.map((card) => slack().editMessage(threadOf(card), card.messageId, content)));
  const failed = results.filter((result) => result.status === 'rejected');
  for (const result of failed) log.warn('failed to edit an approval card', { error: result.reason });
  return failed.length === 0;
}

async function isOpen(card: CardRef): Promise<boolean> {
  const message = await slack().fetchMessage(threadOf(card), card.messageId);
  return message !== null && hasButtons(message.raw);
}

function render(post: ThreadPost) {
  if (post.kind === 'connect') return connectCard(post.url);
  if (post.kind === 'created') return createdCard(post.created, post.reply, secret(), post.canSendEmail);
  return post.text;
}

const slackChat: ApprovalChat = {
  async postCards(draft, admins) {
    const posted = await Promise.allSettled(
      admins.map(async (adminId): Promise<CardRef> => {
        const dm = await bot().openDM(adminId);
        const sent = await dm.post(approvalCard(draft, cardSettings()));
        return { channel: channelOf(dm.id), messageId: sent.id };
      }),
    );
    const cards = posted.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    // Each card's buttons now list every card, so the first decision can close the rest.
    const pending: PendingRequest = { ...draft, cards };
    if (cards.length === admins.length && (await editAll(cards, approvalCard(pending, cardSettings())))) return pending;
    log.error('failed to send every approval card', { requestId: draft.requestId, sent: cards.length, wanted: admins.length });
    await editAll(cards, resolvedCard(pending, COPY.outcome.cancelledNotSent, cardSettings()));
    return null;
  },
  async postNotice(admins, customer, subject, note) {
    const who = customer.name ?? customer.email;
    await Promise.all(admins.map(async (adminId) => (await bot().openDM(adminId)).post(noticeCard(who, subject, note))));
  },
  refreshCards: (pending) => editAll(pending.cards, approvalCard(pending, cardSettings())),
  closeCards: (pending, outcome) => editAll(pending.cards, resolvedCard(pending, outcome, cardSettings())),
  allOpen: async (pending) => (await Promise.all(pending.cards.map(isOpen))).every(Boolean),
  async postInThread(card, post) {
    await bot().thread(threadOf(card)).post(render(post));
  },
  async canStillSend(threadId, messageId) {
    const message = await slack().fetchMessage(threadId, messageId);
    return message !== null && hasButton(message.raw, ACTIONS.sendReply);
  },
  async markSent(threadId, messageId, created, reply) {
    await slack().editMessage(threadId, messageId, createdCard(created, reply, secret(), true, true));
  },
  async displayName(slackUserId) {
    const profile = await slack().getUser(slackUserId);
    return profile?.fullName || profile?.userName || 'An admin';
  },
};

/** Everything the flow needs, built once per instance from the validated config. */
export function deps(): FlowDeps {
  if (flowDeps) return flowDeps;
  const settings = config();
  flowDeps = {
    chat: slackChat,
    payments: airwallexPayments({
      accountId: settings.airwallexAccountId,
      linkExpiryDays: settings.linkExpiryDays,
      callbackUrl: () => new URL(CALLBACK_PATH, publicOrigin()).toString(),
    }),
    extract: modelExtractor({ model: settings.model, reasoningEffort: settings.modelReasoningEffort, companyName: settings.companyName }),
    email: resendProvider(settings.resendApiKey, settings.resendWebhookSecret, settings.replyFrom),
    settings: {
      adminSlackIds: settings.adminSlackIds,
      maxAmount: settings.maxAmount,
      companyName: settings.companyName,
      sendReplyEmail: settings.sendReplyEmail,
    },
    userTag: (slackUserId) => userTag(slackUserId, settings.stateSecret),
    locks: new Set(),
    now: () => new Date(),
  };
  return flowDeps;
}

const clickOf = (event: ActionEvent) => ({
  clicker: event.user.userId,
  clickerIsAdmin: isAdmin(event.user.userId),
  threadId: event.threadId,
  messageId: event.messageId,
});

/** Runs a click's work and turns any failure into a short message in the thread. */
async function guarded(event: ActionEvent, what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    const outcome = await work();
    log.info('handled a click', { action: what, outcome: typeof outcome === 'string' ? outcome : 'done' });
  } catch (error: unknown) {
    log.error('failed to handle a click', { action: what, error });
    await event.thread?.post(COPY.somethingWrong);
  }
}

/** Wires the buttons and the amount form. Called once by the Slack webhook route. */
export function registerHandlers(): void {
  const chatBot = bot();
  chatBot.onAction(ACTIONS.approve, (event) =>
    guarded(event, 'approve', () => approve(decodePending(event.value, secret()), clickOf(event), deps())),
  );
  chatBot.onAction(ACTIONS.reject, (event) =>
    guarded(event, 'reject', () => reject(decodePending(event.value, secret()), clickOf(event), deps())),
  );
  chatBot.onAction(ACTIONS.checkPaid, (event) =>
    guarded(event, 'check paid', () => checkPaid(decodeCreated(event.value, secret()), clickOf(event), deps())),
  );
  chatBot.onAction(ACTIONS.sendReply, (event) =>
    guarded(event, 'send reply', () => sendReply(decodeCreated(event.value, secret()), clickOf(event), deps())),
  );
  chatBot.onAction(ACTIONS.editAmount, (event) =>
    guarded(event, 'edit amount', async () => {
      const pending = decodePending(event.value, secret());
      if (!pending || !isAdmin(event.user.userId)) return 'ignored';
      await event.openModal(amountModal({ pending, threadId: event.threadId, messageId: event.messageId }, secret()));
      return 'modal opened';
    }),
  );
  chatBot.onModalSubmit(AMOUNT_MODAL, (event) => {
    // A bad or missing signature is logged inside decodeModalContext; the form just closes.
    const context = decodeModalContext(event.privateMetadata, secret());
    if (!context) {
      log.warn('ignored an amount form with unreadable context', { user: userTag(event.user.userId, secret()) });
      return;
    }
    const { pending, threadId, messageId } = context;
    const click = { clicker: event.user.userId, clickerIsAdmin: isAdmin(event.user.userId), threadId, messageId };
    const input = {
      amount: event.values[MODAL_FIELDS.amount] ?? '',
      currency: event.values[MODAL_FIELDS.currency] ?? '',
      purpose: event.values[MODAL_FIELDS.purpose],
    };
    // Slack wants the form answered within three seconds; the card updates run after the response.
    after(async () => {
      try {
        log.info('handled an amount form', { outcome: await setAmount(pending, click, input, deps()) });
      } catch (error: unknown) {
        log.error('failed to handle an amount form', { requestId: pending.requestId, error });
      }
    });
  });
}
