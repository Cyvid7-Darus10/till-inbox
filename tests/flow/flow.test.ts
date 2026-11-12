import { afterEach, describe, expect, it, vi } from 'vitest';
import { approve, checkPaid, openAmountForm, reject, sendReply, setAmount } from '../../lib/flow/decisions';
import { fakeWorld } from '../../lib/flow/fakes';
import { handleEmail } from '../../lib/flow/inbound';
import type { CreatedLink } from '../../lib/requests/created';
import type { PendingRequest } from '../../lib/requests/pending';
import { ADMIN, type FixtureName, loadFixture, OTHER_ADMIN, OUTSIDER } from '../fixtures';

const TWO_ADMINS = { adminSlackIds: [ADMIN, OTHER_ADMIN] };

async function emailIn(name: FixtureName, settings = {}) {
  const { email, reading } = loadFixture(name);
  const world = fakeWorld({ reading, settings: { ...TWO_ADMINS, ...settings } });
  const outcome = await handleEmail(email, world.deps);
  const pending = world.chat.cards[0]?.pending as PendingRequest;
  return { world, outcome, pending };
}

const clickOn = (pending: PendingRequest, index: number, clicker = ADMIN) => ({
  clicker,
  clickerIsAdmin: clicker !== OUTSIDER,
  threadId: `slack:${pending.cards[index].channel}:${pending.cards[index].messageId}`,
  messageId: pending.cards[index].messageId,
});

const createdFrom = (world: Awaited<ReturnType<typeof emailIn>>['world']): CreatedLink => {
  const post = world.chat.threadPosts.find((entry) => entry.post.kind === 'created')?.post;
  if (post?.kind !== 'created') throw new Error('no link was posted');
  return post.created;
};

describe('email in', () => {
  it('sends one approval card to each admin and creates nothing yet', async () => {
    const { world, outcome, pending } = await emailIn('single-amount');
    expect(outcome).toBe('carded');
    expect(world.chat.cards).toHaveLength(2);
    expect(pending.cards).toHaveLength(2);
    expect(pending.amount).toBe(640);
    expect(world.payments.links).toHaveLength(0);
    expect(world.mailer.sent).toHaveLength(0);
  });

  it('posts a notice, not a card, for an email that is not a payment request', async () => {
    const { reading, email } = loadFixture('single-amount');
    const world = fakeWorld({ reading: { ...reading, isPaymentRequest: false } });
    expect(await handleEmail(email, world.deps)).toBe('noticed');
    expect(world.chat.cards).toHaveLength(0);
    expect(world.chat.notices).toHaveLength(1);
  });
});

describe('approve', () => {
  it('needs the approver’s own Airwallex login first, and keeps the cards open meanwhile', async () => {
    const { world, pending } = await emailIn('single-amount');
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('needs-login');
    expect(world.chat.threadPosts[0].post.kind).toBe('connect');
    expect(await world.chat.allOpen(pending)).toBe(true);
    expect(world.payments.links).toHaveLength(0);
  });

  it('creates exactly one link, posts the reply in the thread, and sends nothing to the customer', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('created');
    expect(world.payments.links).toHaveLength(1);
    expect(world.payments.links[0].args).toMatchObject({ amount: 640, currency: 'AUD', reusable: false, reference: pending.requestId });
    const created = createdFrom(world);
    const post = world.chat.threadPosts.find((entry) => entry.post.kind === 'created')?.post;
    expect(post).toMatchObject({ canSendEmail: false });
    expect(post?.kind === 'created' && post.reply).toContain(created.link.url);
    expect(await world.chat.allOpen(pending)).toBe(false);
    expect(world.mailer.sent).toHaveLength(0);
  });

  it('ignores a double click, a click on the other admin’s card, and a Slack retry', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN).add(OTHER_ADMIN);
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('created');
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('decided');
    expect(await approve(pending, clickOn(pending, 1, OTHER_ADMIN), world.deps)).toBe('decided');
    expect(world.payments.createCalls).toBe(1);
  });

  it('lets only one of two simultaneous clicks in this instance through', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    const results = await Promise.all([
      approve(pending, clickOn(pending, 0), world.deps),
      approve(pending, clickOn(pending, 0), world.deps),
    ]);
    expect(results.sort()).toEqual(['busy', 'created']);
    expect(world.payments.createCalls).toBe(1);
  });

  it('reuses the existing link if the cards were reopened after a link was already made', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    await approve(pending, clickOn(pending, 0), world.deps);
    await world.chat.refreshCards(pending);
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('reused');
    expect(world.payments.links).toHaveLength(1);
  });

  it('reopens the cards when Airwallex fails, so an admin can try again', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    world.payments.create = async () => {
      throw new Error('network down');
    };
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('failed');
    expect(await world.chat.allOpen(pending)).toBe(true);
  });

  it('refuses an amount above the limit at approval time, says why, and keeps the cards open', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    const lowered = { ...world.deps, settings: { ...world.deps.settings, maxAmount: 500 } };
    expect(await approve(pending, clickOn(pending, 0), lowered)).toBe('over-limit');
    expect(world.payments.createCalls).toBe(0);
    expect(world.chat.threadPosts.at(-1)?.post).toMatchObject({ kind: 'text', text: expect.stringContaining('above the limit of 500') });
    expect(await world.chat.allOpen(pending)).toBe(true);
  });

  it('ignores someone who is not an admin, and a tampered button', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(OUTSIDER);
    expect(await approve(pending, clickOn(pending, 0, OUTSIDER), world.deps)).toBe('ignored');
    expect(await approve(null, clickOn(pending, 0), world.deps)).toBe('ignored');
    expect(world.payments.links).toHaveLength(0);
  });
});

describe('logs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never name the Slack user who clicked, only a short tag', async () => {
    const lines: string[] = [];
    const record = (line: unknown) => {
      lines.push(String(line));
    };
    vi.spyOn(console, 'info').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    await approve(pending, clickOn(pending, 0, OUTSIDER), world.deps);
    await setAmount(pending, clickOn(pending, 0, OUTSIDER), { amount: '1', currency: 'AUD' }, world.deps);
    await approve(pending, clickOn(pending, 0), world.deps);
    const created = createdFrom(world);
    await checkPaid(created, clickOn(pending, 0, OUTSIDER), world.deps);
    await sendReply(created, clickOn(pending, 0, OUTSIDER), world.deps);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line).not.toContain(OUTSIDER);
      expect(line).not.toContain(ADMIN);
    }
    expect(lines.some((line) => /"user":"[0-9a-f]{8}"/.test(line))).toBe(true);
  });
});

describe('no amount stated', () => {
  it('offers no Approve until an admin sets the amount, then creates the link', async () => {
    const { world, pending } = await emailIn('no-amount');
    world.payments.connected.add(ADMIN);
    expect(pending.amount).toBeNull();
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('ignored');
    expect(await setAmount(pending, clickOn(pending, 0), { amount: 'lots', currency: 'AUD' }, world.deps)).toBe('amount-refused');
    expect(await setAmount(pending, clickOn(pending, 0), { amount: '1,140', currency: 'AUD' }, world.deps)).toBe('amount-set');
    const updated = world.chat.cards[0].pending;
    expect(updated.amount).toBe(1140);
    expect(await approve(updated, clickOn(updated, 0), world.deps)).toBe('created');
    expect(world.payments.links[0].args.amount).toBe(1140);
  });
});

describe('who may set the amount', () => {
  it('opens the amount form only for an admin, on a card of this request', async () => {
    const { world, pending } = await emailIn('no-amount');
    const opened: unknown[] = [];
    const open = async (context: unknown) => {
      opened.push(context);
    };
    expect(await openAmountForm(pending, clickOn(pending, 0, OUTSIDER), open, world.deps)).toBe('ignored');
    expect(await openAmountForm(null, clickOn(pending, 0), open, world.deps)).toBe('ignored');
    expect(await openAmountForm(pending, { ...clickOn(pending, 0), messageId: '1799999999.000100' }, open, world.deps)).toBe('ignored');
    expect(opened).toHaveLength(0);
    expect(await openAmountForm(pending, clickOn(pending, 0), open, world.deps)).toBe('modal-opened');
    expect(opened).toEqual([{ pending, threadId: clickOn(pending, 0).threadId, messageId: pending.cards[0].messageId }]);
  });

  it('ignores an amount submitted by someone who is not an admin', async () => {
    const { world, pending } = await emailIn('no-amount');
    expect(await setAmount(pending, clickOn(pending, 0, OUTSIDER), { amount: '50', currency: 'AUD' }, world.deps)).toBe('ignored');
    expect(world.chat.cards[0].pending.amount).toBeNull();
    expect(world.chat.threadPosts).toHaveLength(0);
  });
});

describe('prompt injection', () => {
  it('asks a person for the amount, and the link and reply go only to the real sender', async () => {
    const { world, pending } = await emailIn('injection');
    world.payments.connected.add(ADMIN);
    expect(pending.amount).toBeNull();
    expect(pending.warnings).toContain('instructions-in-email');
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('ignored');
    await setAmount(pending, clickOn(pending, 0), { amount: '2280', currency: 'AUD' }, world.deps);
    await approve(world.chat.cards[0].pending, clickOn(pending, 0), world.deps);
    const post = world.chat.threadPosts.find((entry) => entry.post.kind === 'created')?.post;
    if (post?.kind !== 'created') throw new Error('no link was posted');
    expect(post.created.pending.customer.email).toBe('sam@bondilane.example');
    expect(post.reply).not.toMatch(/pay-update/);
    expect(world.payments.links[0].args).toMatchObject({ amount: 2280, currency: 'AUD' });
    expect(world.mailer.sent).toHaveLength(0);
  });
});

describe('reject', () => {
  it('closes every card and creates nothing; a later Approve does nothing', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    expect(await reject(pending, clickOn(pending, 1, OTHER_ADMIN), world.deps)).toBe('rejected');
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('decided');
    expect(await reject(pending, clickOn(pending, 0), world.deps)).toBe('decided');
    expect(await setAmount(pending, clickOn(pending, 0), { amount: '1', currency: 'AUD' }, world.deps)).toBe('decided');
    expect(world.payments.links).toHaveLength(0);
  });

  it('ignores a reject from someone who is not an admin', async () => {
    const { world, pending } = await emailIn('single-amount');
    expect(await reject(pending, clickOn(pending, 0, OUTSIDER), world.deps)).toBe('ignored');
    expect(await world.chat.allOpen(pending)).toBe(true);
  });
});

describe('has it been paid?', () => {
  it('reads the status from Airwallex and answers in the thread', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    await approve(pending, clickOn(pending, 0), world.deps);
    const created = createdFrom(world);
    const linkClick = { ...clickOn(pending, 0), messageId: created.link.id };
    expect(await checkPaid(created, linkClick, world.deps)).toBe('answered');
    expect(world.chat.threadPosts.at(-1)?.post).toMatchObject({ kind: 'text', text: expect.stringContaining('Not paid yet.') });
    world.payments.markPaid(created.link.id);
    await checkPaid(created, linkClick, world.deps);
    expect(world.chat.threadPosts.at(-1)?.post).toMatchObject({ kind: 'text', text: expect.stringContaining('Paid.') });
  });

  it('asks a newly connected admin to sign in, ignores outsiders, and says when the link is gone', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    await approve(pending, clickOn(pending, 0), world.deps);
    const created = createdFrom(world);
    expect(await checkPaid(created, clickOn(pending, 0, OTHER_ADMIN), world.deps)).toBe('needs-login');
    expect(await checkPaid(created, clickOn(pending, 0, OUTSIDER), world.deps)).toBe('ignored');
    world.payments.links.length = 0;
    await checkPaid(created, clickOn(pending, 0), world.deps);
    expect(world.chat.threadPosts.at(-1)?.post).toMatchObject({ text: expect.stringContaining("couldn't find") });
  });
});

describe('send reply (off by default)', () => {
  it('does nothing while TILL_SEND_REPLY_EMAIL is off', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    await approve(pending, clickOn(pending, 0), world.deps);
    const created = createdFrom(world);
    expect(await sendReply(created, { ...clickOn(pending, 0), messageId: created.link.id }, world.deps)).toBe('ignored');
    expect(world.mailer.sent).toHaveLength(0);
  });

  it('when turned on, sends once to the original sender after an admin presses it', async () => {
    const { world, pending } = await emailIn('single-amount', { sendReplyEmail: true });
    world.payments.connected.add(ADMIN);
    await approve(pending, clickOn(pending, 0), world.deps);
    expect(world.mailer.sent).toHaveLength(0);
    const created = createdFrom(world);
    const sendClick = { ...clickOn(pending, 0), messageId: created.link.id };
    expect(await sendReply(created, sendClick, world.deps)).toBe('sent');
    expect(await sendReply(created, sendClick, world.deps)).toBe('ignored');
    expect(await sendReply(created, { ...sendClick, clicker: OUTSIDER, clickerIsAdmin: false }, world.deps)).toBe('ignored');
    expect(world.mailer.sent).toEqual([
      expect.objectContaining({
        to: 'accounts@northbeachdeli.example',
        subject: 'Your payment link from Kopi Lane Roasters',
        inReplyTo: pending.messageId,
      }),
    ]);
  });

  it('says so in the thread when sending fails', async () => {
    const { world, pending } = await emailIn('single-amount', { sendReplyEmail: true });
    world.payments.connected.add(ADMIN);
    await approve(pending, clickOn(pending, 0), world.deps);
    world.mailer.sendEmail = async () => {
      throw new Error('provider down');
    };
    const created = createdFrom(world);
    expect(await sendReply(created, { ...clickOn(pending, 0), messageId: created.link.id }, world.deps)).toBe('failed');
    expect(world.chat.threadPosts.at(-1)?.post).toMatchObject({ text: expect.stringContaining("couldn't send") });
  });
});

describe('untrusted fields on the way in', () => {
  it('stores a cleaned subject and drops a Message-ID that could inject a header', async () => {
    const { email, reading } = loadFixture('single-amount');
    const world = fakeWorld({ reading });
    const hostile = {
      ...email,
      subject: 'Pay now at evil．com\r\nBcc: victim@example.com',
      messageId: '<a@b.example>\r\nBcc: x@y.example',
    };
    await handleEmail(hostile, world.deps);
    const pending = world.chat.cards[0].pending;
    expect(pending.subject).toBe('Pay now at Bcc:');
    expect(pending.messageId).toBeNull();
  });
});

describe('an unverified sender', () => {
  it('never gets the reply by email, even with sending turned on', async () => {
    const { email, reading } = loadFixture('single-amount');
    const world = fakeWorld({ reading, settings: { sendReplyEmail: true } });
    await handleEmail({ ...email, auth: { spf: 'pass', dkim: 'pass', dmarc: 'fail' } }, world.deps);
    const pending = world.chat.cards[0].pending;
    world.payments.connected.add(ADMIN);
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('created');
    const post = world.chat.threadPosts.find((entry) => entry.post.kind === 'created')?.post;
    expect(post).toMatchObject({ canSendEmail: false });
    const created = createdFrom(world);
    world.chat.sentButtons.set(created.link.id, true);
    expect(await sendReply(created, { ...clickOn(pending, 0), messageId: created.link.id }, world.deps)).toBe('ignored');
    expect(world.mailer.sent).toHaveLength(0);
  });
});

describe('link buttons', () => {
  it('are ignored outside the DM where the request was approved', async () => {
    const { world, pending } = await emailIn('single-amount', { sendReplyEmail: true });
    world.payments.connected.add(ADMIN).add(OTHER_ADMIN);
    await approve(pending, clickOn(pending, 0), world.deps);
    const created = createdFrom(world);
    const elsewhere = { ...clickOn(pending, 1, OTHER_ADMIN), messageId: created.link.id };
    expect(await checkPaid(created, elsewhere, world.deps)).toBe('ignored');
    expect(await sendReply(created, elsewhere, world.deps)).toBe('ignored');
  });
});

describe('when Slack fails part way', () => {
  it('puts the cards back if they could not all be closed', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    world.chat.closeCards = async () => false;
    await expect(approve(pending, clickOn(pending, 0), world.deps)).rejects.toThrow('close every approval card');
    expect(await world.chat.allOpen(pending)).toBe(true);
    expect(world.payments.links).toHaveLength(0);
  });

  it('reopens the cards if the link could not be shown, and a retry shows the same link', async () => {
    const { world, pending } = await emailIn('single-amount');
    world.payments.connected.add(ADMIN);
    const post = world.chat.postInThread.bind(world.chat);
    world.chat.postInThread = async () => {
      throw new Error('slack down');
    };
    await expect(approve(pending, clickOn(pending, 0), world.deps)).rejects.toThrow('slack down');
    expect(await world.chat.allOpen(pending)).toBe(true);
    world.chat.postInThread = post;
    expect(await approve(pending, clickOn(pending, 0), world.deps)).toBe('reused');
    expect(world.payments.createCalls).toBe(1);
  });
});
