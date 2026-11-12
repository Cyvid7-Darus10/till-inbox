import { describe, expect, it } from 'vitest';
import { actionsFor, cardState, channelOf, checkClick, parseAmount, withAmount } from '../../lib/requests/approval';
import { WARNINGS } from '../../lib/requests/understand';
import { pendingFixture } from './helpers';

const click = (overrides = {}) => ({
  action: 'approve' as const,
  clicker: 'UADMIN0001',
  clickerIsAdmin: true,
  threadId: 'slack:DADMIN0001:1700000001.000100',
  messageId: '1700000001.000100',
  ...overrides,
});

describe('card state', () => {
  it('is ready with an amount and offers Approve, Edit amount and Reject', () => {
    expect(cardState(pendingFixture())).toBe('ready');
    expect(actionsFor(pendingFixture())).toEqual(['approve', 'edit-amount', 'reject']);
  });

  it('needs an amount without one, and offers no Approve', () => {
    const noAmount = pendingFixture({ amount: null, currency: null });
    expect(cardState(noAmount)).toBe('needs-amount');
    expect(actionsFor(noAmount)).toEqual(['edit-amount', 'reject']);
  });
});

describe('checking a click', () => {
  it('accepts an admin on one of the request’s own cards', () => {
    expect(checkClick(pendingFixture(), click())).toEqual({ ok: true, card: pendingFixture().cards[0] });
  });

  it('refuses a tampered or unreadable button', () => {
    expect(checkClick(null, click())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a button pasted onto another message', () => {
    expect(checkClick(pendingFixture(), click({ messageId: '1799999999.000100' }))).toEqual({ ok: false, reason: 'unknown-card' });
    expect(checkClick(pendingFixture(), click({ threadId: 'slack:DOTHER0001:1700000001.000100' }))).toEqual({
      ok: false,
      reason: 'unknown-card',
    });
  });

  it('refuses someone who is not an admin, even on a real card', () => {
    expect(checkClick(pendingFixture(), click({ clicker: 'UOUTSIDE01', clickerIsAdmin: false }))).toEqual({
      ok: false,
      reason: 'not-admin',
    });
  });

  it('refuses Approve on a card that has no amount yet', () => {
    expect(checkClick(pendingFixture({ amount: null, currency: null }), click())).toEqual({ ok: false, reason: 'not-available' });
  });

  it('reads the channel out of a thread id', () => {
    expect(channelOf('slack:D123:456.7')).toBe('D123');
    expect(channelOf('nonsense')).toBe('');
  });
});

describe('setting the amount', () => {
  const noAmount = pendingFixture({ amount: null, currency: null, warnings: [WARNINGS.amountNotStated, WARNINGS.senderNotVerified] });

  it('returns a new request with the amount and without the amount warnings, leaving the original alone', () => {
    const edit = withAmount(noAmount, { amount: '1,520.50', currency: 'aud' }, 10_000);
    expect(edit).toEqual({
      ok: true,
      pending: { ...noAmount, amount: 1520.5, currency: 'AUD', warnings: [WARNINGS.senderNotVerified] },
    });
    expect(noAmount.amount).toBeNull();
  });

  it('cleans an edited purpose and refuses an empty one', () => {
    expect(withAmount(noAmount, { amount: '10', currency: 'AUD', purpose: 'Beans https://x.example' }, 100)).toMatchObject({
      ok: true,
      pending: { purpose: 'Beans' },
    });
    expect(withAmount(noAmount, { amount: '10', currency: 'AUD', purpose: '  ' }, 100).ok).toBe(false);
  });

  it('refuses amounts that are not plain numbers, too precise, zero or above the limit', () => {
    for (const amount of ['abc', '9.999', '0', '-5', '1e5', '']) {
      expect(withAmount(noAmount, { amount, currency: 'AUD' }, 10_000).ok).toBe(false);
    }
    expect(withAmount(noAmount, { amount: '20000', currency: 'AUD' }, 10_000)).toEqual({
      ok: false,
      problem: 'That is above the limit of 10,000.',
    });
  });

  it('refuses a currency that is not three letters', () => {
    expect(withAmount(noAmount, { amount: '10', currency: 'dollars' }, 100).ok).toBe(false);
  });

  it('parses amounts people type', () => {
    expect(parseAmount(' 950 ')).toBe(950);
    expect(parseAmount('1,520.5')).toBe(1520.5);
    expect(parseAmount('12345678')).toBeNull();
  });
});
