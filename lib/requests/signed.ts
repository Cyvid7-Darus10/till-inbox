import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Everything Till Inbox puts in a Slack button or form comes back in a request that Slack, or
 * anyone holding a Vercel OIDC token for the project, can write. So each value is signed with
 * TILL_STATE_SECRET: HMAC-SHA256 over the kind of value and the exact JSON, checked in constant
 * time before the JSON is even parsed. A value without a valid signature is refused.
 *
 * Format: `<43-character base64url signature>.<json>`.
 */

/** What a value is for. Part of the signed text, so a value of one kind can't pass as another. */
export type SignedKind = 'pending' | 'created' | 'modal';

const MAC_LENGTH = 43;
/** Characters a signature adds to a value. */
export const SIGNATURE_LENGTH = MAC_LENGTH + 1;

const macOf = (kind: SignedKind, payload: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(`till-inbox:${kind}\n${payload}`).digest();

export const signValue = (kind: SignedKind, payload: string, secret: string): string =>
  `${macOf(kind, payload, secret).toString('base64url')}.${payload}`;

/** The payload of a value signed with this secret for this kind, or null. */
export function openSigned(kind: SignedKind, value: string, secret: string): string | null {
  if (value.length <= SIGNATURE_LENGTH || value[MAC_LENGTH] !== '.') return null;
  const given = Buffer.from(value.slice(0, MAC_LENGTH), 'base64url');
  const payload = value.slice(SIGNATURE_LENGTH);
  const expected = macOf(kind, payload, secret);
  return given.length === expected.length && timingSafeEqual(given, expected) ? payload : null;
}
