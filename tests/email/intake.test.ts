import { describe, expect, it } from 'vitest';
import { admitWebhook, type IntakeLimits, newIntakeLimits } from '../../lib/email/intake';
import { readResendWebhook } from '../../lib/email/resend';
import { sign } from '../../lib/email/signature';
import { TEST_SECRET } from '../fixtures';

const nowMs = 1_763_000_000_000;
const read = (request: { headers: Headers; rawBody: string }, now: number) => readResendWebhook(TEST_SECRET, request, now);
const limits = (): IntakeLimits => newIntakeLimits({ verifiedPerMinute: 3, unsignedPerSourcePerMinute: 5 });

let counter = 0;
function signed(emailId = `em_${++counter}`) {
  const rawBody = JSON.stringify({ type: 'email.received', data: { email_id: emailId } });
  const id = `msg_${emailId}`;
  const timestamp = Math.floor(nowMs / 1000);
  return {
    headers: new Headers({
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': sign(TEST_SECRET, id, timestamp, rawBody),
    }),
    rawBody,
  };
}
const unsigned = () => ({ headers: new Headers(), rawBody: '{"type":"email.received","data":{"email_id":"em_x"}}' });
const forged = () => ({ ...signed(), rawBody: '{"type":"email.received","data":{"email_id":"em_forged"}}' });

describe('admitting an inbound webhook', () => {
  it('accepts a signed delivery and hands back its email id', () => {
    expect(admitWebhook(read, { ...signed('em_ok'), source: 'resend' }, limits(), nowMs)).toEqual({
      status: 200,
      message: 'accepted',
      delivery: { deliveryId: 'msg_em_ok', emailId: 'em_ok' },
    });
  });

  it('refuses an oversized body before any other work', () => {
    let reads = 0;
    const counting = (request: { headers: Headers; rawBody: string }, now: number) => {
      reads += 1;
      return read(request, now);
    };
    const big = { headers: new Headers(), rawBody: 'x'.repeat(64 * 1024 + 1), source: 'a' };
    expect(admitWebhook(counting, big, limits(), nowMs).status).toBe(413);
    expect(reads).toBe(0);
  });

  it('a flood of unsigned requests does not cause a signed delivery to be rejected', () => {
    const shared = limits();
    for (let i = 0; i < 100; i += 1) {
      const status = admitWebhook(read, { ...(i % 2 ? unsigned() : forged()), source: 'attacker' }, shared, nowMs).status;
      expect([401, 429]).toContain(status);
    }
    expect(admitWebhook(read, { ...signed(), source: 'resend' }, shared, nowMs).status).toBe(200);
    // Even a signed delivery from the flooding address is still verified and accepted.
    expect(admitWebhook(read, { ...signed(), source: 'attacker' }, shared, nowMs).status).toBe(200);
  });

  it('slows an address that keeps failing, without checking signatures it does not even send', () => {
    const shared = limits();
    const statuses = Array.from({ length: 7 }, () => admitWebhook(read, { ...unsigned(), source: 'a' }, shared, nowMs).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it('counts only verified deliveries against the global limit', () => {
    const shared = limits();
    const statuses = Array.from({ length: 4 }, () => admitWebhook(read, { ...signed(), source: 'resend' }, shared, nowMs).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('drops a repeated delivery and a repeated email', () => {
    const shared = limits();
    const first = signed('em_same');
    expect(admitWebhook(read, { ...first, source: 'r' }, shared, nowMs).status).toBe(200);
    expect(admitWebhook(read, { ...first, source: 'r' }, shared, nowMs)).toMatchObject({ status: 200, message: 'duplicate' });
  });

  it('acknowledges signed events it does not act on', () => {
    const rawBody = '{"type":"email.sent","data":{}}';
    const timestamp = Math.floor(nowMs / 1000);
    const headers = new Headers({
      'svix-id': 'm',
      'svix-timestamp': String(timestamp),
      'svix-signature': sign(TEST_SECRET, 'm', timestamp, rawBody),
    });
    expect(admitWebhook(read, { headers, rawBody, source: 'r' }, limits(), nowMs)).toEqual({ status: 200, message: 'ignored' });
  });
});
