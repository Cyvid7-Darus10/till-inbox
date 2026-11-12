import type { Extractor } from '../agent/extract';
import type { PaymentLink } from '../airwallex/payment-links';
import { COPY, WARNING_TEXT } from '../copy';
import type { OutboundEmail } from '../email/provider';
import { actionsFor } from '../requests/approval';
import type { CreatedLink } from '../requests/created';
import type { Extraction } from '../requests/extraction';
import { expiryFrom, linkArgs, type PaymentLinkArgs } from '../requests/link-params';
import { type CardRef, formatAmount, type PendingRequest } from '../requests/pending';
import { buildReply } from '../requests/reply';
import type { ApprovalChat, FlowDeps, FlowSettings, Payments, ThreadPost } from './ports';

/**
 * In-memory stand-ins for Slack, Airwallex, the model and the email provider. The tests and
 * `npm run simulate` use them, so the whole flow runs with no accounts. Each one records what
 * happened and can print it.
 */

export type Printer = (line: string) => void;

const silent: Printer = () => {};

/** Plain-text view of an approval card, the way an admin would read it. */
export function describeCard(pending: PendingRequest, settings: { companyName: string }): string[] {
  const amount = pending.amount !== null && pending.currency !== null ? formatAmount(pending.amount, pending.currency) : 'Not stated';
  const lines = [
    `From:     ${[pending.customer.name, pending.customer.company, pending.customer.email].filter(Boolean).join(', ')}`,
    `Sender:   ${COPY.card.senderCheckValue(!pending.warnings.includes('sender-not-verified'))}`,
    `For:      ${pending.purpose}`,
    `Amount:   ${amount}`,
    ...(pending.dueDate ? [`Pay by:   ${pending.dueDate}`] : []),
    ...pending.warnings.map((warning) => `Warning:  ${WARNING_TEXT[warning as keyof typeof WARNING_TEXT]}`),
    ...(pending.note ? [`Note:     ${pending.note}`] : []),
  ];
  if (pending.amount !== null) {
    lines.push(
      'Draft reply:',
      ...buildReply(pending, null, settings)
        .text.split('\n')
        .map((line) => `  | ${line}`),
    );
  }
  lines.push(`Buttons:  ${actionsFor(pending).join(', ')}`);
  return lines;
}

interface FakeCard {
  ref: CardRef;
  admin: string;
  open: boolean;
  pending: PendingRequest;
  outcome?: string;
}

export class FakeChat implements ApprovalChat {
  readonly cards: FakeCard[] = [];
  readonly threadPosts: { card: CardRef; post: ThreadPost }[] = [];
  readonly notices: string[] = [];
  readonly sentButtons = new Map<string, boolean>();
  private nextTs = 1_700_000_000;

  constructor(
    private readonly settings: { companyName: string },
    private readonly print: Printer = silent,
    private readonly names: Record<string, string> = {},
  ) {}

  async postCards(draft: PendingRequest, admins: readonly string[]): Promise<PendingRequest | null> {
    const refs = admins.map((admin) => {
      this.nextTs += 1;
      return { admin, ref: { channel: `D${admin.slice(1)}`, messageId: `${this.nextTs}.000100` } };
    });
    const pending = { ...draft, cards: refs.map(({ ref }) => ref) };
    for (const { admin, ref } of refs) this.cards.push({ ref, admin, open: true, pending });
    this.print(`[slack] approval card sent to ${admins.map((id) => this.names[id] ?? id).join(', ')}:`);
    for (const line of describeCard(pending, this.settings)) this.print(`        ${line}`);
    return pending;
  }

  async postNotice(
    admins: readonly string[],
    customer: { name: string | null; email: string },
    subject: string,
    note: string,
  ): Promise<void> {
    const text = COPY.notice.body(customer.name ?? customer.email, subject, note);
    this.notices.push(text);
    this.print(`[slack] notice to ${admins.length} admin(s): ${text}`);
  }

  private find(ref: CardRef): FakeCard | undefined {
    return this.cards.find((card) => card.ref.channel === ref.channel && card.ref.messageId === ref.messageId);
  }

  async refreshCards(pending: PendingRequest): Promise<boolean> {
    for (const ref of pending.cards) {
      const card = this.find(ref);
      if (card) Object.assign(card, { open: true, pending, outcome: undefined });
    }
    this.print('[slack] cards updated:');
    for (const line of describeCard(pending, this.settings)) this.print(`        ${line}`);
    return true;
  }

  async closeCards(pending: PendingRequest, outcome: string): Promise<boolean> {
    for (const ref of pending.cards) {
      const card = this.find(ref);
      if (card) Object.assign(card, { open: false, outcome });
    }
    this.print(`[slack] cards closed: ${outcome}`);
    return true;
  }

  async allOpen(pending: PendingRequest): Promise<boolean> {
    return pending.cards.every((ref) => this.find(ref)?.open === true);
  }

  async postInThread(card: CardRef, post: ThreadPost): Promise<void> {
    this.threadPosts.push({ card, post });
    if (post.kind === 'text') this.print(`[slack] in thread: ${post.text}`);
    if (post.kind === 'connect') this.print(`[slack] in thread: sign-in button for Airwallex (${post.url})`);
    if (post.kind === 'created') {
      this.sentButtons.set(post.created.link.id, post.canSendEmail);
      this.print(`[slack] in thread: payment link ${post.created.link.url}`);
      this.print(`        ${post.canSendEmail ? COPY.thread.replyHeading : COPY.thread.replyHeadingCopyOnly}`);
      for (const line of post.reply.split('\n')) this.print(`  | ${line}`);
      this.print(
        `        Buttons: ${['Open payment link', COPY.thread.checkPaid, ...(post.canSendEmail ? [COPY.thread.sendReply] : [])].join(', ')}`,
      );
    }
  }

  async canStillSend(_threadId: string, messageId: string): Promise<boolean> {
    return this.sentButtons.get(messageId) === true;
  }

  async markSent(_threadId: string, messageId: string): Promise<void> {
    this.sentButtons.set(messageId, false);
  }

  async displayName(slackUserId: string): Promise<string> {
    return this.names[slackUserId] ?? slackUserId;
  }
}

/** An Airwallex sandbox in memory. Created links get a made-up https address. */
export class FakePayments implements Payments {
  readonly links: (PaymentLink & { args: PaymentLinkArgs })[] = [];
  readonly connected = new Set<string>();
  createCalls = 0;

  constructor(
    private readonly accountId = 'acct_fakeaccount01',
    private readonly expiryDays = 7,
    private readonly print: Printer = silent,
  ) {}

  async isConnected(slackUserId: string): Promise<boolean> {
    return this.connected.has(slackUserId);
  }

  async connectUrl(slackUserId: string): Promise<string> {
    return `https://connect.example/authorize/${slackUserId}`;
  }

  async create(slackUserId: string, pending: PendingRequest, now: Date) {
    const expiresAt = expiryFrom(now, this.expiryDays);
    const args = linkArgs(pending, this.accountId, expiresAt);
    const existing = this.links.find((link) => link.reference === args.reference);
    if (existing) {
      this.print(`[airwallex] link for ${args.reference} already exists, reusing it`);
      return { ok: true as const, link: existing, reused: true, accountId: this.accountId, expiresAt };
    }
    this.createCalls += 1;
    const id = `fake-link-${this.links.length + 1}`;
    const link = {
      id,
      url: `https://pay.sandbox.example/${id}`,
      status: 'UNPAID',
      active: true,
      amount: args.amount,
      currency: args.currency,
      reference: args.reference,
      expires_at: expiresAt,
      created_at: now.toISOString(),
      args,
    };
    this.links.push(link);
    this.print(
      `[airwallex] create_payment_link as ${slackUserId}: ${formatAmount(args.amount, args.currency)}, "${args.title}", single use, expires ${args.expires_at}, reference ${args.reference}`,
    );
    return { ok: true as const, link, reused: false, accountId: this.accountId, expiresAt };
  }

  async status(_slackUserId: string, created: CreatedLink) {
    const link = this.links.find((item) => item.id === created.link.id);
    return link ? { status: link.status, active: link.active ?? null, expiresAt: link.expires_at ?? null } : null;
  }

  markPaid(linkId: string): void {
    const link = this.links.find((item) => item.id === linkId);
    if (link) link.status = 'PAID';
  }
}

export class FakeMailer {
  readonly sent: OutboundEmail[] = [];
  async sendEmail(email: OutboundEmail): Promise<{ id: string }> {
    this.sent.push(email);
    return { id: `fake-email-${this.sent.length}` };
  }
}

/** A model stand-in that always returns the same reading. */
export const fixedExtractor =
  (reading: Extraction): Extractor =>
  async () =>
    reading;

export interface FakeWorld {
  deps: FlowDeps;
  chat: FakeChat;
  payments: FakePayments;
  mailer: FakeMailer;
}

export function fakeWorld(options: {
  reading: Extraction;
  settings?: Partial<FlowSettings>;
  print?: Printer;
  names?: Record<string, string>;
  now?: () => Date;
}): FakeWorld {
  const settings: FlowSettings = {
    adminSlackIds: ['UADMIN0001'],
    maxAmount: 10_000,
    companyName: 'Kopi Lane Roasters',
    sendReplyEmail: false,
    ...options.settings,
  };
  const chat = new FakeChat(settings, options.print, options.names);
  const payments = new FakePayments(undefined, 7, options.print);
  const mailer = new FakeMailer();
  return {
    chat,
    payments,
    mailer,
    deps: {
      chat,
      payments,
      extract: fixedExtractor(options.reading),
      email: mailer,
      settings,
      locks: new Set(),
      now: options.now ?? (() => new Date('2026-11-12T09:00:00Z')),
    },
  };
}
