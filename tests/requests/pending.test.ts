import { describe, expect, it } from 'vitest';
import { decodeCreated, encodeCreated } from '../../lib/requests/created';
import {
  decodePending,
  encodePending,
  fitsInButton,
  formatAmount,
  MAX_BUTTON_VALUE_LENGTH,
  requestIdFor,
} from '../../lib/requests/pending';
import { pendingFixture } from './helpers';

describe('a pending request in a button', () => {
  it('survives the round trip through a button value', () => {
    expect(decodePending(encodePending(pendingFixture()))).toEqual(pendingFixture());
  });

  it('is refused when tampered with, too long, or missing', () => {
    expect(decodePending(encodePending(pendingFixture()).replace('"amount":950', '"amount":-1'))).toBeNull();
    expect(decodePending(encodePending(pendingFixture({ customer: { name: null, company: null, email: 'not-an-email' } })))).toBeNull();
    expect(decodePending('{')).toBeNull();
    expect(decodePending(undefined)).toBeNull();
    expect(decodePending('x'.repeat(MAX_BUTTON_VALUE_LENGTH + 1))).toBeNull();
  });

  it('fits five approval cards for a typical request, and refuses one that would not', () => {
    expect(fitsInButton(pendingFixture({ cards: [] }), 5)).toBe(true);
    expect(fitsInButton(pendingFixture({ cards: [], note: 'n'.repeat(200), purpose: 'p'.repeat(160), subject: 's'.repeat(120) }), 5)).toBe(
      true,
    );
    expect(fitsInButton(pendingFixture({ cards: [], messageId: 'm'.repeat(2000) }), 1)).toBe(false);
  });
});

describe('a created link in a button', () => {
  const created = {
    pending: pendingFixture({ cards: [pendingFixture().cards[0]] }),
    link: {
      id: '5e0984bf-0979-4fd6-a737-ced7362b224b',
      url: 'https://pay.sandbox.airwallex.com/abc',
      accountId: 'acct_fakeaccount01',
      createdAt: '2026-11-12T09:00:00+0000',
      expiresAt: '2026-11-19T09:00:00Z',
    },
  };

  it('round-trips, and refuses a non-https link or a second card', () => {
    expect(decodeCreated(encodeCreated(created))).toEqual(created);
    expect(decodeCreated(encodeCreated({ ...created, link: { ...created.link, url: 'http://pay.example/abc' } }))).toBeNull();
    expect(decodeCreated(JSON.stringify({ ...created, pending: pendingFixture() }))).toBeNull();
    expect(decodeCreated('nope')).toBeNull();
    expect(decodeCreated(undefined)).toBeNull();
  });

  it('fits in a button', () => {
    expect(encodeCreated(created).length).toBeLessThan(MAX_BUTTON_VALUE_LENGTH);
  });
});

describe('ids and amounts', () => {
  it('makes one safe request id per email', () => {
    expect(requestIdFor('4f1c2b8e-0d1a/4b7e')).toBe('till-inbox-4f1c2b8e-0d1a4b7e');
    expect(requestIdFor('x'.repeat(100))).toHaveLength(64);
  });

  it('formats amounts with the currency first', () => {
    expect(formatAmount(1520.5, 'AUD')).toBe('AUD 1,520.50');
  });
});
