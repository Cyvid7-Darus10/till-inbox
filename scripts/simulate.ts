// Runs the whole flow on one fixture email, with fakes for Slack, Airwallex and the email provider,
// and prints each step. No accounts needed. The model's reading comes from the fixture (recorded
// from a real run); pass --live-model to call the model through Vercel AI Gateway instead.
//
// Usage: npm run simulate -- fixtures/emails/opening-order.json [--live-model] [--amount "1140 AUD"]
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { modelExtractor } from '../lib/agent/extract';
import { ReplayCache } from '../lib/email/guard';
import { readResendWebhook, toInboundEmail } from '../lib/email/resend';
import { sign } from '../lib/email/signature';
import { approve, checkPaid, reject, setAmount } from '../lib/flow/decisions';
import { fakeWorld } from '../lib/flow/fakes';
import { handleEmail } from '../lib/flow/inbound';
import { cardState } from '../lib/requests/approval';
import type { Extraction } from '../lib/requests/extraction';
import type { PendingRequest } from '../lib/requests/pending';

const ADMIN = 'UADMIN0001';
const OTHER_ADMIN = 'UADMIN0002';
const OUTSIDER = 'UOUTSIDE01';
const NAMES = { [ADMIN]: 'Alex (admin)', [OTHER_ADMIN]: 'Priya (admin)', [OUTSIDER]: 'Jordan (not an admin)' };

const args = process.argv.slice(2);
const path = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--amount');
const liveModel = args.includes('--live-model');
const amountIndex = args.indexOf('--amount');
const amountArg = amountIndex >= 0 ? args[amountIndex + 1] : undefined;
if (!path) throw new Error('usage: npm run simulate -- fixtures/emails/<name>.json [--live-model] [--amount "1140 AUD"]');

let step = 0;
const heading = (text: string) => console.info(`\n${++step}. ${text}`);
const print = (line: string) => console.info(`   ${line}`);

const fixture = JSON.parse(await readFile(path, 'utf8'));
console.info(`Till Inbox simulation: ${fixture.description}`);
console.info('Slack, Airwallex and the email provider are fakes. Nothing leaves this machine.');

heading('Email in: the provider calls the webhook with a signed event');
const secret = `whsec_${randomBytes(24).toString('base64')}`;
const body = JSON.stringify({ type: 'email.received', created_at: fixture.email.created_at, data: { email_id: fixture.email.id } });
const deliveryId = `msg_${randomUUID()}`;
const nowMs = Date.now();
const timestamp = Math.floor(nowMs / 1000);
const headers = new Headers({
  'svix-id': deliveryId,
  'svix-timestamp': String(timestamp),
  'svix-signature': sign(secret, deliveryId, timestamp, body),
});
const delivery = readResendWebhook(secret, { headers, rawBody: body }, nowMs);
print(`signature check: ${delivery.kind === 'email' ? 'valid' : delivery.kind}`);
const forged = readResendWebhook(secret, { headers, rawBody: body.replace(fixture.email.id, 'someone-else') }, nowMs);
print(`the same request with a changed body: ${forged.kind} (${forged.kind === 'rejected' ? forged.reason : ''})`);
const late = readResendWebhook(secret, { headers, rawBody: body }, nowMs + 6 * 60 * 1000);
print(`the same request replayed six minutes later: ${late.kind} (${late.kind === 'rejected' ? late.reason : ''})`);
const replays = new ReplayCache(10 * 60 * 1000);
replays.seen(deliveryId, nowMs);
print(`the same request again within the window: ${replays.seen(deliveryId, nowMs) ? 'dropped as a duplicate' : 'accepted'}`);

heading('The email is fetched from the provider');
const email = toInboundEmail(fixture.email);
print(`from ${email.from.name ?? ''} <${email.from.address}>, subject "${email.subject}"`);
print(`sender checks: SPF ${email.auth.spf}, DKIM ${email.auth.dkim}, DMARC ${email.auth.dmarc}`);

heading(liveModel ? 'The model reads it (live, through Vercel AI Gateway)' : 'The model reads it (reading recorded from a real run)');
const reading: Extraction = liveModel
  ? await modelExtractor({ model: process.env.TILL_MODEL ?? 'openai/gpt-5', reasoningEffort: 'low', companyName: 'Kopi Lane Roasters' })(
      email,
    )
  : fixture.modelReading;
if (!liveModel) print(fixture.modelReadingSource);
for (const [key, value] of Object.entries(reading)) print(`${key}: ${JSON.stringify(value)}`);

heading('Code checks the reading and sends an approval card to each admin');
const world = fakeWorld({ reading, settings: { adminSlackIds: [ADMIN, OTHER_ADMIN] }, print, names: NAMES, now: () => new Date() });
print(`outcome: ${await handleEmail(email, world.deps)}`);
if (world.chat.cards.length === 0) process.exit(0);
let pending: PendingRequest = world.chat.cards[0].pending;
print(`Airwallex links so far: ${world.payments.links.length}. Emails sent to the customer: ${world.mailer.sent.length}.`);

const click = (who: string, index = 0) => ({
  clicker: who,
  clickerIsAdmin: who !== OUTSIDER,
  threadId: `slack:${pending.cards[index].channel}:${pending.cards[index].messageId}`,
  messageId: pending.cards[index].messageId,
});

heading(`${NAMES[OUTSIDER]} presses Approve on a forwarded card`);
print(`outcome: ${await approve(pending, click(OUTSIDER), world.deps)}`);

if (cardState(pending) === 'needs-amount') {
  heading(`${NAMES[ADMIN]} tries Approve on a card with no amount`);
  print(`outcome: ${await approve(pending, click(ADMIN), world.deps)} (the card has no Approve button)`);
  const [amount, currency] = (amountArg ?? fixture.adminAmount ?? '100 AUD').split(' ');
  heading(`${NAMES[ADMIN]} presses Set amount and types ${amount} ${currency}`);
  print(`outcome: ${await setAmount(pending, click(ADMIN), { amount, currency }, world.deps)}`);
  pending = world.chat.cards[0].pending;
}

heading(`${NAMES[ADMIN]} presses Approve`);
print(`outcome: ${await approve(pending, click(ADMIN), world.deps)}`);
world.payments.connected.add(ADMIN);
print(`(${NAMES[ADMIN]} signs in to Airwallex through Vercel Connect, then presses Approve again)`);
print(`outcome: ${await approve(pending, click(ADMIN), world.deps)}`);

heading(`${NAMES[ADMIN]} double-clicks, and ${NAMES[OTHER_ADMIN]} presses Approve and Reject on their own card`);
print(`double click: ${await approve(pending, click(ADMIN), world.deps)}`);
print(`other admin approves: ${await approve(pending, click(OTHER_ADMIN, 1), world.deps)}`);
print(`other admin rejects: ${await reject(pending, click(OTHER_ADMIN, 1), world.deps)}`);
print(`Airwallex create calls: ${world.payments.createCalls}. Emails sent to the customer: ${world.mailer.sent.length}.`);

const created = world.chat.threadPosts.find((entry) => entry.post.kind === 'created')?.post;
if (created?.kind === 'created') {
  const linkClick = { ...click(ADMIN), messageId: created.created.link.id };
  heading(`${NAMES[ADMIN]} presses "Has it been paid?"`);
  await checkPaid(created.created, linkClick, world.deps);
  heading('The customer pays (in the fake Airwallex), and the admin asks again');
  world.payments.markPaid(created.created.link.id);
  await checkPaid(created.created, linkClick, world.deps);
}
console.info('\nDone. In a real deployment each [slack] line is a Slack message and each [airwallex] line a sandbox API call.');
