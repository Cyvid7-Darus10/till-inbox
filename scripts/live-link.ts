// Creates ONE real payment link in an Airwallex SANDBOX through Vercel Connect, using the same code
// the server runs after an approval, then asks for it again (it must be reused, not duplicated) and
// reads its status. Slack and the email provider are not involved.
//
// Needs `vercel env pull .env.local` (OIDC token) and an Airwallex login for the subject, which the
// script offers to start. Usage:
//   npm run live-link -- fixtures/emails/opening-order.json [--as <login id>]
import { readFile } from 'node:fs/promises';
import { airwallexPayments } from '../lib/airwallex/payments';
import { connectUrl, isConnected } from '../lib/airwallex/session';
import { config } from '../lib/config';
import { toInboundEmail } from '../lib/email/resend';
import type { CreatedLink } from '../lib/requests/created';
import { formatAmount, type PendingRequest, requestIdFor } from '../lib/requests/pending';
import { understand } from '../lib/requests/understand';

const args = process.argv.slice(2);
const path = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--as');
const asIndex = args.indexOf('--as');
const subject = asIndex >= 0 ? args[asIndex + 1] : 'live-check';
if (!path) throw new Error('usage: npm run live-link -- <fixture.json> [--as <login id>]');

const fixture = JSON.parse(await readFile(path, 'utf8'));
const email = toInboundEmail(fixture.email);
const understood = understand(email, fixture.modelReading, { maxAmount: config().maxAmount });
if (understood.kind !== 'payment' || understood.amount === null)
  throw new Error('this fixture has no amount to approve; use opening-order');

if (!(await isConnected(subject))) {
  console.info(`The login "${subject}" has not connected Airwallex. Open this link, sign in to your SANDBOX, then run again:`);
  console.info(await connectUrl(subject, 'https://example.com/connected'));
  process.exit(1);
}

// A fresh request id per run, so each run is its own approval.
const pending: PendingRequest = {
  requestId: requestIdFor(`live-${Date.now()}`),
  receivedAt: new Date().toISOString(),
  messageId: null,
  subject: email.subject,
  customer: understood.customer,
  purpose: understood.purpose,
  amount: understood.amount,
  currency: understood.currency,
  dueDate: understood.dueDate,
  confidence: understood.confidence,
  note: understood.note,
  warnings: understood.warnings,
  cards: [{ channel: 'DLIVECHECK', messageId: '1700000000.000100' }],
};
const payments = airwallexPayments({
  accountId: config().airwallexAccountId,
  linkExpiryDays: config().linkExpiryDays,
  callbackUrl: () => 'https://example.com/connected',
});

console.info(`1. Approve: create ${formatAmount(pending.amount ?? 0, pending.currency ?? '')}, reference ${pending.requestId}`);
const first = await payments.create(subject, pending, new Date());
if (!first.ok) throw new Error(`not created: ${first.problem}`);
console.info(`   created: ${first.link.url} (id ${first.link.id}, status ${first.link.status}, reused ${first.reused})`);

console.info('2. Approve again (a retry or a second admin): the existing link must come back');
const second = await payments.create(subject, pending, new Date());
if (!second.ok) throw new Error(`second call failed: ${second.problem}`);
console.info(
  `   ${second.reused && second.link.id === first.link.id ? 'reused the same link' : 'PROBLEM: a second link was made'} (${second.link.id})`,
);

console.info('3. Has it been paid?');
const created: CreatedLink = {
  pending,
  link: {
    id: first.link.id,
    url: first.link.url,
    accountId: first.accountId ?? '',
    createdAt: first.link.created_at,
    expiresAt: first.link.expires_at ?? '',
  },
};
console.info(`   ${JSON.stringify(await payments.status(subject, created))}`);
