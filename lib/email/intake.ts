import { MAX_WEBHOOK_BYTES, RateLimiter, ReplayCache } from './guard';
import type { WebhookDelivery, WebhookRequest } from './provider';

/**
 * Decides what to do with one inbound webhook request, in an order that keeps unsigned traffic
 * from hurting real deliveries:
 *
 * 1. Size cap, before any other work.
 * 2. An address that already sent too many requests that failed verification, and sends no
 *    signature headers at all, is refused without computing anything.
 * 3. The signature is verified. A failure counts against that address only.
 * 4. Only verified deliveries count against the global limit.
 * 5. A delivery or email seen before is acknowledged and dropped.
 *
 * Pure apart from the limiters it is given.
 */

const MINUTE_MS = 60 * 1000;

export interface IntakeLimits {
  verified: RateLimiter;
  unsignedPerSource: RateLimiter;
  deliveries: ReplayCache;
  emails: ReplayCache;
}

export function newIntakeLimits(settings: { verifiedPerMinute: number; unsignedPerSourcePerMinute: number }): IntakeLimits {
  return {
    verified: new RateLimiter(settings.verifiedPerMinute, MINUTE_MS),
    unsignedPerSource: new RateLimiter(settings.unsignedPerSourcePerMinute, MINUTE_MS),
    deliveries: new ReplayCache(10 * MINUTE_MS),
    emails: new ReplayCache(24 * 60 * MINUTE_MS),
  };
}

export interface Admission {
  status: number;
  message: string;
  /** Present only when the email should be processed. */
  delivery?: { deliveryId: string; emailId: string };
  /** Why a request was refused, for the log. A fixed code, never request content. */
  reason?: string;
}

type ReadWebhook = (request: WebhookRequest, nowMs: number) => WebhookDelivery;

const hasSignatureHeaders = (headers: Headers): boolean =>
  Boolean(headers.get('svix-id') && headers.get('svix-timestamp') && headers.get('svix-signature'));

export function admitWebhook(
  readWebhook: ReadWebhook,
  request: WebhookRequest & { source: string },
  limits: IntakeLimits,
  nowMs: number,
): Admission {
  if (Buffer.byteLength(request.rawBody) > MAX_WEBHOOK_BYTES) return { status: 413, message: 'too large', reason: 'too-large' };
  if (!hasSignatureHeaders(request.headers) && limits.unsignedPerSource.exhausted(request.source, nowMs)) {
    return { status: 429, message: 'slow down', reason: 'unsigned-flood' };
  }
  const delivery = readWebhook(request, nowMs);
  if (delivery.kind === 'rejected') {
    const allowed = limits.unsignedPerSource.allow(request.source, nowMs);
    return allowed
      ? { status: 401, message: 'invalid signature', reason: delivery.reason }
      : { status: 429, message: 'slow down', reason: delivery.reason };
  }
  if (delivery.kind === 'ignored') return { status: 200, message: 'ignored' };
  if (!limits.verified.allow('all', nowMs)) return { status: 429, message: 'slow down', reason: 'verified-rate-limit' };
  if (limits.deliveries.seen(delivery.deliveryId, nowMs) || limits.emails.seen(delivery.emailId, nowMs)) {
    return { status: 200, message: 'duplicate', reason: 'duplicate' };
  }
  return { status: 200, message: 'accepted', delivery: { deliveryId: delivery.deliveryId, emailId: delivery.emailId } };
}
