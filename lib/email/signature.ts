import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a webhook signed the way Resend signs them (the Svix scheme): an HMAC-SHA256 of
 * `${id}.${timestamp}.${rawBody}`, keyed with the base64 part of the `whsec_` secret, sent as one or
 * more space-separated `v1,<base64>` values. Old or future timestamps are refused, so a captured
 * request can't be replayed later. Pure: the caller passes the clock.
 */

/** How far a webhook's timestamp may be from now, in seconds. Svix uses five minutes. */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface SignedHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export type SignatureCheck =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; reason: 'missing-headers' | 'bad-timestamp' | 'too-old' | 'too-new' | 'bad-signature' | 'bad-secret' };

const SECRET_PREFIX = 'whsec_';

function secretBytes(secret: string): Buffer | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const bytes = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  return bytes.length > 0 ? bytes : null;
}

/** Signs a payload the same way. Used by tests and the local simulation, never by the server. */
export function sign(secret: string, id: string, timestamp: number, rawBody: string): string {
  const key = secretBytes(secret);
  if (!key) throw new Error('failed to sign: not a whsec_ secret');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

const sameBytes = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function verifySignature(secret: string, headers: SignedHeaders, rawBody: string, nowSeconds: number): SignatureCheck {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing-headers' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  const sentAt = Number(timestamp);
  if (nowSeconds - sentAt > TIMESTAMP_TOLERANCE_SECONDS) return { ok: false, reason: 'too-old' };
  if (sentAt - nowSeconds > TIMESTAMP_TOLERANCE_SECONDS) return { ok: false, reason: 'too-new' };
  if (!secretBytes(secret)) return { ok: false, reason: 'bad-secret' };
  const expected = sign(secret, id, sentAt, rawBody).slice('v1,'.length);
  const matches = signature
    .split(' ')
    .filter((part) => part.startsWith('v1,'))
    .some((part) => sameBytes(part.slice('v1,'.length), expected));
  return matches ? { ok: true, id, timestamp: sentAt } : { ok: false, reason: 'bad-signature' };
}
