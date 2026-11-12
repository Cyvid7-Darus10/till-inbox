import { after } from 'next/server';
import { config } from '@/lib/config';
import { MAX_WEBHOOK_BYTES, RateLimiter } from '@/lib/email/guard';
import { admitWebhook, type IntakeLimits, newIntakeLimits } from '@/lib/email/intake';
import { resendProvider } from '@/lib/email/resend';
import { type DeliveryIo, processDelivery } from '@/lib/flow/delivery';
import { log } from '@/lib/log';
import { bot, deps } from '@/lib/slack/bot';

// Reading the email, the model and the Slack cards run after the response; give them room.
export const maxDuration = 120;

const HOUR_MS = 60 * 60 * 1000;
/** Requests per minute, per source address, that may fail verification before it is slowed down. */
const UNSIGNED_PER_SOURCE_PER_MINUTE = 20;

// Per instance. The signature's five-minute window bounds a replay that lands on another instance.
let limits: IntakeLimits | undefined;
let perSender: RateLimiter | undefined;

const respond = (status: number, message: string): Response => Response.json({ message }, { status });

/** Vercel sets x-real-ip to the caller's address; it is used only as a rate-limit key. */
const sourceOf = (request: Request): string =>
  request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

/** Inbound email webhook. See lib/email/intake.ts for the order of checks. */
export async function POST(request: Request): Promise<Response> {
  const settings = config();
  limits ??= newIntakeLimits({ verifiedPerMinute: settings.inboundPerMinute, unsignedPerSourcePerMinute: UNSIGNED_PER_SOURCE_PER_MINUTE });
  perSender ??= new RateLimiter(settings.inboundPerSenderPerHour, HOUR_MS);

  // Refuse a declared oversized body before reading it; intake checks the real size again.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) return respond(413, 'too large');
  const rawBody = await request.text();
  const provider = resendProvider(settings.resendApiKey, settings.resendWebhookSecret, settings.replyFrom);
  const admission = admitWebhook(
    provider.readWebhook,
    { headers: request.headers, rawBody, source: sourceOf(request) },
    limits,
    Date.now(),
  );
  if (admission.reason) log.warn('inbound webhook not processed', { reason: admission.reason, status: admission.status });
  if (!admission.delivery) return respond(admission.status, admission.message);

  const { emailId } = admission.delivery;
  const arrivedAt = new Date();
  const io: DeliveryIo = {
    fetchEmail: provider.fetchEmail,
    allowSender: (address) => perSender?.allow(address, Date.now()) ?? false,
    ready: async () => {
      await bot().initialize();
      return deps();
    },
  };
  // Failures are logged and reported to the admins inside processDelivery.
  after(() => processDelivery(emailId, arrivedAt, io));
  return respond(admission.status, admission.message);
}
