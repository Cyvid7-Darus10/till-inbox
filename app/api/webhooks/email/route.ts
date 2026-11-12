import { after } from 'next/server';
import { config } from '@/lib/config';
import { MAX_WEBHOOK_BYTES, RateLimiter, ReplayCache } from '@/lib/email/guard';
import { resendProvider } from '@/lib/email/resend';
import { handleEmail } from '@/lib/flow/inbound';
import { log } from '@/lib/log';
import { requestIdFor } from '@/lib/requests/pending';
import { bot, deps } from '@/lib/slack/bot';

// Reading the email, the model and the Slack cards run after the response; give them room.
export const maxDuration = 120;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Per instance. The signature's five-minute window bounds a replay that lands on another instance.
const deliveries = new ReplayCache(10 * MINUTE_MS);
const emails = new ReplayCache(24 * HOUR_MS);
let everyone: RateLimiter | undefined;
let perSender: RateLimiter | undefined;

const respond = (status: number, message: string): Response => Response.json({ message }, { status });

/** Inbound email webhook. Verifies the signature before reading anything else. */
export async function POST(request: Request): Promise<Response> {
  const settings = config();
  everyone ??= new RateLimiter(settings.inboundPerMinute, MINUTE_MS);
  perSender ??= new RateLimiter(settings.inboundPerSenderPerHour, HOUR_MS);
  const now = Date.now();

  if (Number(request.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) return respond(413, 'too large');
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) return respond(413, 'too large');
  if (!everyone.allow('all', now)) {
    log.warn('inbound email rate limited');
    return respond(429, 'slow down');
  }

  const provider = resendProvider(settings.resendApiKey, settings.resendWebhookSecret, settings.replyFrom);
  const delivery = provider.readWebhook({ headers: request.headers, rawBody }, now);
  if (delivery.kind === 'rejected') {
    log.warn('rejected an inbound webhook', { reason: delivery.reason });
    return respond(401, 'invalid signature');
  }
  if (delivery.kind === 'ignored') return respond(200, 'ignored');
  if (deliveries.seen(delivery.deliveryId, now) || emails.seen(delivery.emailId, now)) {
    log.info('dropped a repeated inbound webhook', { requestId: requestIdFor(delivery.emailId) });
    return respond(200, 'duplicate');
  }

  const requestId = requestIdFor(delivery.emailId);
  after(async () => {
    try {
      const email = await provider.fetchEmail(delivery.emailId);
      if (!perSender?.allow(email.from.address, Date.now())) {
        log.warn('inbound email rate limited for its sender', { requestId });
        return;
      }
      await bot().initialize();
      log.info('inbound email handled', { requestId, outcome: await handleEmail(email, deps()) });
    } catch (error: unknown) {
      log.error('failed to handle an inbound email', { requestId, error });
    }
  });
  return respond(200, 'accepted');
}
