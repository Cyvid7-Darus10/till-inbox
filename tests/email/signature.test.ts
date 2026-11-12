import { Webhook } from 'svix';
import { describe, expect, it } from 'vitest';
import { sign, TIMESTAMP_TOLERANCE_SECONDS, verifySignature } from '../../lib/email/signature';
import { TEST_SECRET } from '../fixtures';

const body = '{"type":"email.received","data":{"email_id":"abc"}}';
const now = 1_763_000_000;

const headersFor = (signature: string, id = 'msg_1', timestamp = now) => ({ id, timestamp: String(timestamp), signature });

describe('webhook signature', () => {
  it('accepts a signature made by the official Svix library', () => {
    const signature = new Webhook(TEST_SECRET).sign('msg_1', new Date(now * 1000), body);
    expect(verifySignature(TEST_SECRET, headersFor(signature), body, now)).toEqual({ ok: true, id: 'msg_1', timestamp: now });
  });

  it('produces the same signature as the Svix library', () => {
    expect(sign(TEST_SECRET, 'msg_1', now, body)).toBe(new Webhook(TEST_SECRET).sign('msg_1', new Date(now * 1000), body));
  });

  it('accepts when one of several space-separated signatures matches (secret rotation)', () => {
    const signature = `v1,bm90IGl0 ${sign(TEST_SECRET, 'msg_1', now, body)}`;
    expect(verifySignature(TEST_SECRET, headersFor(signature), body, now).ok).toBe(true);
  });

  it('rejects a body changed after signing', () => {
    const signature = sign(TEST_SECRET, 'msg_1', now, body);
    expect(verifySignature(TEST_SECRET, headersFor(signature), body.replace('abc', 'xyz'), now)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a signature made with another secret', () => {
    const other = `whsec_${Buffer.from('another secret entirely').toString('base64')}`;
    expect(verifySignature(TEST_SECRET, headersFor(sign(other, 'msg_1', now, body)), body, now)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a replay older than the tolerance window', () => {
    const old = now - TIMESTAMP_TOLERANCE_SECONDS - 1;
    const signature = sign(TEST_SECRET, 'msg_1', old, body);
    expect(verifySignature(TEST_SECRET, headersFor(signature, 'msg_1', old), body, now)).toEqual({ ok: false, reason: 'too-old' });
  });

  it('rejects a timestamp from the future', () => {
    const future = now + TIMESTAMP_TOLERANCE_SECONDS + 1;
    const signature = sign(TEST_SECRET, 'msg_1', future, body);
    expect(verifySignature(TEST_SECRET, headersFor(signature, 'msg_1', future), body, now)).toEqual({ ok: false, reason: 'too-new' });
  });

  it('rejects a reused signature with a different delivery id', () => {
    const signature = sign(TEST_SECRET, 'msg_1', now, body);
    expect(verifySignature(TEST_SECRET, headersFor(signature, 'msg_2'), body, now).ok).toBe(false);
  });

  it('rejects missing headers, a malformed timestamp and a malformed secret', () => {
    expect(verifySignature(TEST_SECRET, { id: null, timestamp: '1', signature: 'v1,x' }, body, now)).toEqual({
      ok: false,
      reason: 'missing-headers',
    });
    expect(verifySignature(TEST_SECRET, headersFor('v1,x', 'msg_1', Number.NaN), body, now)).toEqual({
      ok: false,
      reason: 'bad-timestamp',
    });
    expect(verifySignature('not-a-secret', headersFor('v1,x'), body, now)).toEqual({ ok: false, reason: 'bad-secret' });
    expect(() => sign('not-a-secret', 'msg_1', now, body)).toThrow('whsec_');
  });
});
