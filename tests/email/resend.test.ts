import { afterEach, describe, expect, it, vi } from 'vitest';
import { htmlToText, parseAddress } from '../../lib/email/provider';
import { readResendWebhook, resendProvider, toInboundEmail } from '../../lib/email/resend';
import { sign } from '../../lib/email/signature';
import { loadFixture, TEST_SECRET } from '../fixtures';

const nowMs = 1_763_000_000_000;

function signedRequest(body: string, id = 'msg_1', timestamp = Math.floor(nowMs / 1000)) {
  return {
    headers: new Headers({ 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': sign(TEST_SECRET, id, timestamp, body) }),
    rawBody: body,
  };
}

describe('reading a Resend webhook', () => {
  it('returns the email id of a signed email.received event', () => {
    const body = JSON.stringify({ type: 'email.received', created_at: '2026-11-12T08:30:00Z', data: { email_id: 'em_1', subject: 'x' } });
    expect(readResendWebhook(TEST_SECRET, signedRequest(body), nowMs)).toEqual({ kind: 'email', deliveryId: 'msg_1', emailId: 'em_1' });
  });

  it('ignores other signed events', () => {
    const body = JSON.stringify({ type: 'email.delivered', data: {} });
    expect(readResendWebhook(TEST_SECRET, signedRequest(body), nowMs)).toEqual({
      kind: 'ignored',
      deliveryId: 'msg_1',
      eventType: 'email.delivered',
    });
  });

  it('rejects an unsigned or tampered request before reading it', () => {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1' } });
    const request = signedRequest(body);
    expect(readResendWebhook(TEST_SECRET, { ...request, rawBody: body.replace('em_1', 'em_2') }, nowMs)).toEqual({
      kind: 'rejected',
      reason: 'bad-signature',
    });
    expect(readResendWebhook(TEST_SECRET, { headers: new Headers(), rawBody: body }, nowMs)).toEqual({
      kind: 'rejected',
      reason: 'missing-headers',
    });
  });

  it('rejects signed bodies that are not the expected JSON', () => {
    expect(readResendWebhook(TEST_SECRET, signedRequest('not json'), nowMs)).toEqual({ kind: 'rejected', reason: 'not-json' });
    expect(readResendWebhook(TEST_SECRET, signedRequest('{"nope":1}'), nowMs)).toEqual({ kind: 'rejected', reason: 'unexpected-shape' });
    expect(readResendWebhook(TEST_SECRET, signedRequest('{"type":"email.received","data":{}}'), nowMs)).toEqual({
      kind: 'rejected',
      reason: 'no-email-id',
    });
  });
});

describe('turning a received email into the DTO', () => {
  it('reads sender, subject, text and sender checks', () => {
    const { email } = loadFixture('opening-order');
    expect(email.from).toEqual({ address: 'accounts@harbourlanecafe.example', name: 'Mia Tran' });
    expect(email.subject).toBe('Paying for the opening order');
    expect(email.auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    expect(email.text).toContain('AUD 950 in total');
    expect(email.clipped).toBe(false);
  });

  it('falls back to the HTML when there is no text part, and marks unknown checks', () => {
    const email = toInboundEmail({
      id: 'em_2',
      created_at: '2026-11-12 08:30:00.123+00',
      from: 'billing@example.com',
      subject: null,
      text: null,
      html: '<p>Pay <b>AUD 10</b></p><script>alert(1)</script>',
      authentication: null,
    });
    expect(email.text).toBe('Pay AUD 10');
    expect(email.from).toEqual({ address: 'billing@example.com', name: null });
    expect(email.auth).toEqual({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' });
    expect(email.receivedAt).toBe('2026-11-12T08:30:00.123Z');
  });

  it("reads Resend's documented sender check values, and treats anything else as unknown", () => {
    const { raw } = loadFixture('opening-order');
    const checks = (authentication: unknown) => toInboundEmail({ ...raw.email, authentication }).auth;
    expect(checks({ spf: 'pass', dkim: 'fail', dmarc: 'pass' })).toEqual({ spf: 'pass', dkim: 'fail', dmarc: 'pass' });
    expect(checks({ spf: 'gray', dkim: 'processing_failed', dmarc: 'unknown' })).toEqual({
      spf: 'unknown',
      dkim: 'unknown',
      dmarc: 'unknown',
    });
    // An object with a result field, in case the shape changes, still reads.
    expect(checks({ spf: { result: 'PASS' }, dkim: {}, dmarc: { result: 'fail' } })).toEqual({
      spf: 'pass',
      dkim: 'unknown',
      dmarc: 'fail',
    });
  });

  it('refuses an email without a usable From address', () => {
    expect(() => toInboundEmail({ id: 'x', created_at: '2026-11-12T08:30:00Z', from: 'nobody' })).toThrow('From');
  });
});

describe('address and html helpers', () => {
  it('parses names and addresses, and refuses junk', () => {
    expect(parseAddress('"Tran, Mia" <Mia@Example.com>')).toEqual({ address: 'mia@example.com', name: 'Tran, Mia' });
    expect(parseAddress('a@b')).toBeNull();
    expect(parseAddress('<a@example.com> <b@example.com>')).toBeNull();
  });

  it('turns html into plain text', () => {
    expect(htmlToText('a&nbsp;&amp;&lt;b&gt;<br>c<style>x</style>')).toBe('a &<b>\nc');
  });
});

describe('the Resend client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the email with the API key and keeps the response body out of errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(loadFixture('opening-order').raw.email));
    vi.stubGlobal('fetch', fetchMock);
    const provider = resendProvider('re_test_key_123', TEST_SECRET);
    const email = await provider.fetchEmail('em/1');
    expect(email.from.address).toBe('accounts@harbourlanecafe.example');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.resend.com/emails/receiving/em%2F1');
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer re_test_key_123');

    fetchMock.mockResolvedValueOnce(new Response('customer text here', { status: 404 }));
    await expect(provider.fetchEmail('em_9')).rejects.toThrow(/^Resend GET \/emails\/receiving failed: 404$/);
  });

  it('sends a reply threaded under the original, and refuses without a From address', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: 'sent_1' }));
    vi.stubGlobal('fetch', fetchMock);
    const outbound = { to: 'mia@example.com', subject: 'Re: x', text: 'hi', inReplyTo: '<m1@example.com>' };
    await expect(resendProvider('re_test_key_123', TEST_SECRET).sendEmail(outbound)).rejects.toThrow('TILL_REPLY_FROM');
    expect(await resendProvider('re_test_key_123', TEST_SECRET, 'orders@example.com').sendEmail(outbound)).toEqual({ id: 'sent_1' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toMatchObject({ from: 'orders@example.com', to: ['mia@example.com'], headers: { 'In-Reply-To': '<m1@example.com>' } });
  });
});
