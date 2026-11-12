import { describe, expect, it } from 'vitest';
import { cleanField } from '../../lib/requests/clean';
import { expiryFrom, linkArgs } from '../../lib/requests/link-params';
import { buildReply, LINK_PLACEHOLDER, replySubject } from '../../lib/requests/reply';
import { pendingFixture } from './helpers';

const settings = { companyName: 'Kopi Lane Roasters' };
const link = { url: 'https://pay.sandbox.airwallex.com/abc', expiresAt: '2026-11-19T09:00:00Z' };

describe('the reply builder', () => {
  it('writes the reply with the link, amount, expiry and signature', () => {
    const reply = buildReply(pendingFixture(), link, settings);
    expect(reply.to).toBe('accounts@harbourlanecafe.example');
    expect(reply.subject).toBe('Your payment link from Kopi Lane Roasters');
    expect(reply.text).toBe(
      [
        'Hi Mia,',
        '',
        'Thanks for getting in touch. You can pay AUD 950.00 for 25 kg of the Lane House Blend here:',
        'https://pay.sandbox.airwallex.com/abc',
        '',
        'The link works until 19 Nov 2026. You can pay by card or another method shown on the page.',
        'Reply to this email if anything looks wrong.',
        '',
        'Thanks,',
        'Kopi Lane Roasters',
      ].join('\n'),
    );
  });

  it('shows a placeholder before the link exists', () => {
    const text = buildReply(pendingFixture(), null, settings).text;
    expect(text).toContain(LINK_PLACEHOLDER);
    expect(text).not.toContain('works until');
    expect(text).not.toMatch(/\n\n\n/);
  });

  it('always replies to the original sender and greets plainly without a name', () => {
    const reply = buildReply(pendingFixture({ customer: { name: null, company: null, email: 'leo@example.com' } }), link, settings);
    expect(reply.to).toBe('leo@example.com');
    expect(reply.text.startsWith('Hello,')).toBe(true);
  });

  it('refuses to build a reply without an amount', () => {
    expect(() => buildReply(pendingFixture({ amount: null }), link, settings)).toThrow('no amount');
  });

  it('never puts the inbound subject in the outbound subject', () => {
    for (const subject of ['Pay at https://evil.example', 'Order\r\nBcc: victim@example.com', 'Order at evil．com', 'Order']) {
      const reply = buildReply(pendingFixture({ subject }), link, settings);
      expect(reply.subject).toBe('Your payment link from Kopi Lane Roasters');
      expect(reply.subject).not.toMatch(/evil|Bcc|\r|\n|Order/);
    }
    expect(replySubject('Kopi Lane Roasters')).toBe('Your payment link from Kopi Lane Roasters');
  });
});

describe('payment link arguments', () => {
  it('asks for a fixed, single-use link with the request id as reference, and never emails the shopper', () => {
    const args = linkArgs(pendingFixture(), 'acct_fakeaccount01', '2026-11-19T09:00:00Z');
    expect(args).toEqual({
      account_id: 'acct_fakeaccount01',
      title: '25 kg of the Lane House Blend',
      amount: 950,
      currency: 'AUD',
      description: 'For Harbour Lane Café Pty Ltd',
      reference: 'till-inbox-em_0001',
      reusable: false,
      expires_at: '2026-11-19T09:00:00Z',
      metadata: { source: 'till-inbox', request_id: 'till-inbox-em_0001' },
    });
    expect(Object.keys(args)).not.toContain('shopper_email');
  });

  it('refuses to build a link without an approved amount', () => {
    expect(() => linkArgs(pendingFixture({ currency: null }), 'acct_x', 'x')).toThrow('no amount');
  });

  it('computes the expiry in whole seconds with a Z suffix', () => {
    expect(expiryFrom(new Date('2026-11-12T09:00:00.123Z'), 7)).toBe('2026-11-19T09:00:00Z');
  });
});

describe('cleaning fields', () => {
  it('removes links, markup and control characters and caps the length', () => {
    expect(cleanField('Pay\u0007 <b>here</b> https://evil.example/x now', 100)).toBe('Pay b here /b now');
    expect(cleanField('a'.repeat(50), 10)).toBe('a'.repeat(10));
    expect(cleanField('https://only.example', 10)).toBeNull();
    expect(cleanField(null, 10)).toBeNull();
  });
});
