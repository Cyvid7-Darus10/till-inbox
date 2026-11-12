import type { PendingRequest } from '../../lib/requests/pending';

/** A ready request with two approval cards, for tests. Every id here is made up. */
export const pendingFixture = (overrides: Partial<PendingRequest> = {}): PendingRequest => ({
  requestId: 'till-inbox-em_0001',
  receivedAt: '2026-11-12T08:30:00.000Z',
  messageId: '<opening-order-0001@harbourlanecafe.example>',
  subject: 'Paying for the opening order',
  customer: { name: 'Mia Tran', company: 'Harbour Lane Café Pty Ltd', email: 'accounts@harbourlanecafe.example' },
  purpose: '25 kg of the Lane House Blend',
  amount: 950,
  currency: 'AUD',
  dueDate: null,
  confidence: 'high',
  note: '',
  warnings: [],
  mentioned: [],
  cards: [
    { channel: 'DADMIN0001', messageId: '1700000001.000100' },
    { channel: 'DADMIN0002', messageId: '1700000002.000100' },
  ],
  ...overrides,
});

/**
 * A request with every field at its longest, as cleaned email text can make it, and `approvers`
 * cards with the longest Slack ids. Used to check the signed values still fit Slack's limits.
 */
export const largestPending = (approvers: number): PendingRequest =>
  pendingFixture({
    requestId: `till-inbox-${'e'.repeat(53)}`,
    messageId: `<${'m'.repeat(98)}@${'d'.repeat(99)}>`,
    subject: 's'.repeat(120),
    customer: { name: 'n'.repeat(120), company: 'c'.repeat(120), email: `${'a'.repeat(64)}@${'b'.repeat(60)}.example` },
    purpose: 'p'.repeat(160),
    note: 'o'.repeat(200),
    dueDate: '2026-12-31',
    warnings: ['amount-not-in-email', 'instructions-in-email', 'sender-not-verified', 'email-clipped', 'low-confidence'],
    mentioned: Array.from({ length: 10 }, () => 'AUD 1,000,000.00'),
    cards: Array.from({ length: approvers }, () => ({ channel: 'D'.repeat(20), messageId: `${'9'.repeat(12)}.${'9'.repeat(8)}` })),
  });
