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
