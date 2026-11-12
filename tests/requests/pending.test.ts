import { describe, expect, it } from 'vitest';
import { decodeCreated, encodeCreated } from '../../lib/requests/created';
import { fitsInButtons } from '../../lib/requests/fits';
import { decodeModalContext, encodeModalContext, MAX_MODAL_METADATA_LENGTH } from '../../lib/requests/modal-context';
import {
  decodePending,
  encodePending,
  formatAmount,
  MAX_BUTTON_VALUE_LENGTH,
  type PendingRequest,
  requestIdFor,
} from '../../lib/requests/pending';
import { signValue } from '../../lib/requests/signed';
import { STATE_SECRET } from '../fixtures';
import { largestPending, pendingFixture } from './helpers';

const encode = (pending: Parameters<typeof encodePending>[0]) => encodePending(pending, STATE_SECRET);
/** The longest link fields a created-link button can carry. */
const longestLink = {
  id: 'i'.repeat(64),
  url: `https://pay.sandbox.airwallex.com/${'p'.repeat(166)}`,
  accountId: `acct_${'a'.repeat(40)}`,
  createdAt: '2'.repeat(40),
  expiresAt: '2'.repeat(40),
};
/** The request with `chars` characters cut from its free-text fields, note first. */
function trimmed(pending: PendingRequest, chars: number): PendingRequest {
  const cutNote = Math.min(chars, pending.note.length);
  const cutSubject = Math.min(chars - cutNote, pending.subject.length);
  const cutPurpose = Math.min(chars - cutNote - cutSubject, pending.purpose.length - 1);
  return {
    ...pending,
    note: pending.note.slice(cutNote),
    subject: pending.subject.slice(cutSubject),
    purpose: pending.purpose.slice(cutPurpose),
  };
}
const decode = (value: string | undefined) => decodePending(value, STATE_SECRET);

describe('a pending request in a button', () => {
  it('survives the round trip through a button value', () => {
    expect(decode(encode(pendingFixture()))).toEqual(pendingFixture());
  });

  it('is refused when tampered with, too long, or missing', () => {
    expect(decode(encode(pendingFixture()).replace('"amount":950', '"amount":-1'))).toBeNull();
    expect(decode(encode(pendingFixture({ customer: { name: null, company: null, email: 'not-an-email' } })))).toBeNull();
    expect(decode('{')).toBeNull();
    expect(decode(undefined)).toBeNull();
    expect(decode('x'.repeat(MAX_BUTTON_VALUE_LENGTH + 1))).toBeNull();
  });

  it('is refused without a valid signature, even when the request inside is well formed', () => {
    const json = JSON.stringify(pendingFixture({ amount: 9_999 }));
    expect(decode(json)).toBeNull();
    expect(decode(signValue('pending', json, 'a different secret of the right length'))).toBeNull();
    expect(decode(encode(pendingFixture()).replace('"amount":950', '"amount":9500'))).toBeNull();
    expect(decode(signValue('created', json, STATE_SECRET))).toBeNull();
  });

  it('fits five approval cards for a typical request, and refuses one that would not', () => {
    expect(fitsInButtons(pendingFixture({ cards: [] }), 5)).toBe(true);
    expect(fitsInButtons(pendingFixture({ cards: [], note: 'n'.repeat(200), purpose: 'p'.repeat(160), subject: 's'.repeat(120) }), 5)).toBe(
      true,
    );
    expect(fitsInButtons(pendingFixture({ cards: [], messageId: 'm'.repeat(2000) }), 1)).toBe(false);
  });

  it('refuses, rather than half-posts, a request with every field at its longest', () => {
    expect(fitsInButtons({ ...largestPending(5), cards: [] }, 5)).toBe(false);
  });

  it.each([1, 2, 5])('keeps the largest request it accepts within Slack limits once signed (%i approvers)', (approvers) => {
    const full = largestPending(approvers);
    const cut = Array.from({ length: 700 }, (_, index) => index).find((chars) =>
      fitsInButtons({ ...trimmed(full, chars), cards: [] }, approvers),
    );
    expect(cut).toBeDefined();
    const largest = trimmed(full, cut ?? 0);
    expect(encode(largest).length).toBeLessThanOrEqual(MAX_BUTTON_VALUE_LENGTH);
    const threadId = `slack:${'D'.repeat(20)}:${'9'.repeat(12)}.${'9'.repeat(8)}`;
    expect(encodeModalContext({ pending: largest, threadId, messageId: '9'.repeat(40) }, STATE_SECRET).length).toBeLessThanOrEqual(
      MAX_MODAL_METADATA_LENGTH,
    );
    const created = { pending: { ...largest, cards: [largest.cards[0]] }, link: longestLink };
    expect(encodeCreated(created, STATE_SECRET).length).toBeLessThanOrEqual(MAX_BUTTON_VALUE_LENGTH);
  });
});

describe('the amount form context', () => {
  const context = { pending: pendingFixture(), threadId: 'slack:DADMIN0001:1700000001.000100', messageId: '1700000001.000100' };

  it('round-trips signed, and is refused unsigned or altered', () => {
    expect(decodeModalContext(encodeModalContext(context, STATE_SECRET), STATE_SECRET)).toEqual(context);
    expect(decodeModalContext(JSON.stringify(context), STATE_SECRET)).toBeNull();
    expect(decodeModalContext(encodeModalContext(context, STATE_SECRET).replace('950', '951'), STATE_SECRET)).toBeNull();
    expect(decodeModalContext(signValue('pending', JSON.stringify(context), STATE_SECRET), STATE_SECRET)).toBeNull();
    expect(decodeModalContext(undefined, STATE_SECRET)).toBeNull();
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
    expect(decodeCreated(encodeCreated(created, STATE_SECRET), STATE_SECRET)).toEqual(created);
    expect(
      decodeCreated(encodeCreated({ ...created, link: { ...created.link, url: 'http://pay.example/abc' } }, STATE_SECRET), STATE_SECRET),
    ).toBeNull();
    expect(
      decodeCreated(signValue('created', JSON.stringify({ ...created, pending: pendingFixture() }), STATE_SECRET), STATE_SECRET),
    ).toBeNull();
    expect(decodeCreated('nope', STATE_SECRET)).toBeNull();
    expect(decodeCreated(undefined, STATE_SECRET)).toBeNull();
  });

  it('is refused without a valid signature', () => {
    expect(decodeCreated(JSON.stringify(created), STATE_SECRET)).toBeNull();
    expect(decodeCreated(encodeCreated(created, STATE_SECRET), 'a different secret of the right length')).toBeNull();
    expect(decodeCreated(signValue('pending', JSON.stringify(created), STATE_SECRET), STATE_SECRET)).toBeNull();
  });

  it('fits in a button', () => {
    expect(encodeCreated(created, STATE_SECRET).length).toBeLessThan(MAX_BUTTON_VALUE_LENGTH);
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
